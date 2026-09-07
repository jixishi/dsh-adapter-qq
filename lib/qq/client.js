/**
 * QQ Open Platform OpenAPI v2 Client
 * Handles token fetching, gateway URL discovery, message sending, and global menu registration.
 * Reference: https://bot.q.qq.com/wiki/develop/api-v2/
 */

export class QQApiClient {
  /**
   * @param {Object} options
   * @param {string} options.appId - QQ Bot AppID
   * @param {string} options.clientSecret - QQ Bot AppSecret
   * @param {boolean} [options.sandbox=false] - Whether to use QQ sandbox environment
   * @param {Object} [options.logger] - Logger instance
   */
  constructor({ appId, clientSecret, sandbox = false, logger = console }) {
    this.appId = String(appId || '').trim();
    this.clientSecret = String(clientSecret || '').trim();
    this.sandbox = Boolean(sandbox);
    this.logger = logger;

    this.tokenUrl = 'https://bots.qq.com/app/getAppAccessToken';
    this.baseUrl = this.sandbox
      ? 'https://sandbox.api.sgroup.qq.com'
      : 'https://api.sgroup.qq.com';

    this.accessToken = null;
    this.tokenExpiresAt = 0;
    this.tokenFetchingPromise = null;
    this.msgSeq = Math.floor(Date.now() / 1000) % 1000000;
  }

  /**
   * Update credentials and environment
   */
  updateConfig({ appId, clientSecret, sandbox }) {
    if (appId !== undefined) this.appId = String(appId).trim();
    if (clientSecret !== undefined) this.clientSecret = String(clientSecret).trim();
    if (sandbox !== undefined) {
      this.sandbox = Boolean(sandbox);
      this.baseUrl = this.sandbox
        ? 'https://sandbox.api.sgroup.qq.com'
        : 'https://api.sgroup.qq.com';
    }
    // Invalidate cached token when credentials change
    this.accessToken = null;
    this.tokenExpiresAt = 0;
  }

  /**
   * Check if credentials are validly configured
   */
  isConfigured() {
    return Boolean(this.appId && this.clientSecret);
  }

  /**
   * Get valid access token with concurrency deduplication and pre-expiry refresh
   * @param {boolean} [forceRefresh=false]
   * @returns {Promise<string>}
   */
  async getAccessToken(forceRefresh = false) {
    if (!this.isConfigured()) {
      throw new Error('QQ Bot appId or clientSecret is missing.');
    }

    const now = Date.now();
    // Refresh 60 seconds before expiration
    if (!forceRefresh && this.accessToken && now < this.tokenExpiresAt - 60000) {
      return this.accessToken;
    }

    if (this.tokenFetchingPromise) {
      return this.tokenFetchingPromise;
    }

    this.tokenFetchingPromise = (async () => {
      try {
        const res = await fetch(this.tokenUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            appId: this.appId,
            clientSecret: this.clientSecret,
          }),
        });

        if (!res.ok) {
          const text = await res.text();
          throw new Error(`Failed to getAppAccessToken: HTTP ${res.status} - ${text}`);
        }

        const data = await res.json();
        if (!data.access_token) {
          throw new Error(`Invalid token response from QQ: ${JSON.stringify(data)}`);
        }

        this.accessToken = data.access_token;
        const expiresIn = Number(data.expires_in) || 7200;
        this.tokenExpiresAt = Date.now() + expiresIn * 1000;
        this.logger.info?.(`[QQApiClient] Successfully obtained access_token (expires in ${expiresIn}s)`);
        return this.accessToken;
      } finally {
        this.tokenFetchingPromise = null;
      }
    })();

    return this.tokenFetchingPromise;
  }

  /**
   * Internal request helper with auth token and error handling
   * @param {string} path - URL path
   * @param {Object} [options]
   * @param {number} [retryCount=0]
   * @returns {Promise<any>}
   */
  async request(path, options = {}, retryCount = 0) {
    const token = await this.getAccessToken(retryCount > 0);
    const url = path.startsWith('http') ? path : `${this.baseUrl}${path}`;

    const headers = {
      Authorization: `QQBot ${token}`,
      'Content-Type': 'application/json',
      'X-Union-Appid': this.appId,
      ...(options.headers || {}),
    };

    const res = await fetch(url, {
      ...options,
      headers,
    });

    // 401 Unauthorized or Token invalid -> retry once with refreshed token
    if (res.status === 401 && retryCount === 0) {
      this.logger.warn?.('[QQApiClient] Received 401 Unauthorized, refreshing token and retrying...');
      return this.request(path, options, retryCount + 1);
    }

    // 50015014 System busy / Rate limited -> exponential backoff retry
    if (res.status === 429 || res.status === 503) {
      if (retryCount < 3) {
        const delay = Math.pow(2, retryCount) * 1000;
        this.logger.warn?.(`[QQApiClient] Rate limited or busy (${res.status}), retrying in ${delay}ms...`);
        await new Promise((resolve) => setTimeout(resolve, delay));
        return this.request(path, options, retryCount + 1);
      }
    }

    if (!res.ok) {
      const errorText = await res.text();
      let errorJson = null;
      try {
        errorJson = JSON.parse(errorText);
      } catch {
        // keep text
      }

      // If QQ API returns code 50015014 (System busy)
      if (errorJson?.code === 50015014 && retryCount < 3) {
        const delay = (retryCount + 1) * 2000;
        this.logger.warn?.(`[QQApiClient] QQ API error 50015014, retrying in ${delay}ms...`);
        await new Promise((resolve) => setTimeout(resolve, delay));
        return this.request(path, options, retryCount + 1);
      }

      const err = new Error(`QQ API error [${res.status}]: ${errorText}`);
      err.status = res.status;
      err.response = errorJson || errorText;
      throw err;
    }

    const contentType = res.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      return res.json();
    }
    return res.text();
  }

  /**
   * Get WebSocket Gateway URL
   * @returns {Promise<string>}
   */
  async getGatewayUrl() {
    const data = await this.request('/gateway');
    if (!data?.url) {
      throw new Error(`Unexpected gateway response: ${JSON.stringify(data)}`);
    }
    return data.url;
  }

  /**
   * Next message sequence number
   * @returns {number}
   */
  getNextMsgSeq() {
    this.msgSeq = (this.msgSeq + 1) % 10000000;
    return this.msgSeq;
  }

  /**
   * Send C2C message to a user
   * @param {string} userOpenid - User OpenID
   * @param {Object} message - Message payload
   * @param {string} [message.content] - Text content (msg_type 0)
   * @param {string} [message.markdown] - Markdown content (msg_type 2)
   * @param {Object} [message.keyboard] - InlineKeyboard buttons
   * @param {string} [message.msg_id] - Passive reply msg_id
   * @param {number} [message.msg_type] - Explicit msg_type (0=text, 2=markdown, 6=input_notify)
   * @param {number} [message.msg_seq] - Optional explicit msg_seq
   * @returns {Promise<any>}
   */
  async sendC2CMessage(userOpenid, message) {
    if (!userOpenid) {
      throw new Error('userOpenid is required to send C2C message.');
    }

    const payload = {
      msg_seq: message.msg_seq ?? this.getNextMsgSeq(),
      ...(message.msg_id ? { msg_id: message.msg_id } : {}),
    };

    if (message.msg_type !== undefined) {
      payload.msg_type = message.msg_type;
    } else if (message.markdown) {
      payload.msg_type = 2;
    } else {
      payload.msg_type = 0;
    }

    if (payload.msg_type === 2) {
      payload.markdown = typeof message.markdown === 'string'
        ? { content: message.markdown }
        : message.markdown;
    } else if (payload.msg_type === 0) {
      payload.content = String(message.content ?? '');
    } else if (payload.msg_type === 6) {
      payload.input_notify = message.input_notify || { input_type: 1, input_second: 60 };
    }

    if (message.keyboard) {
      payload.keyboard = message.keyboard;
    }

    try {
      return await this.request(`/v2/users/${userOpenid}/messages`, {
        method: 'POST',
        body: JSON.stringify(payload),
      });
    } catch (err) {
      // If sending with msg_id failed (e.g. expired or invalid id), retry without msg_id
      if (payload.msg_id) {
        this.logger.warn?.(`[QQApiClient] Send with msg_id failed (${err.message}), retrying without msg_id...`);
        const retryPayload = { ...payload };
        delete retryPayload.msg_id;
        try {
          return await this.request(`/v2/users/${userOpenid}/messages`, {
            method: 'POST',
            body: JSON.stringify(retryPayload),
          });
        } catch {
          // fall through to markdown fallback
        }
      }

      // If sending markdown failed due to permission, automatically fallback to plain text
      if (payload.msg_type === 2 && (err.status === 400 || err.status === 403)) {
        this.logger.warn?.(`[QQApiClient] Markdown send failed (${err.message}), falling back to plain text`);
        const fallbackText = typeof message.markdown === 'string'
          ? message.markdown
          : message.markdown?.content || message.content || '';
        return this.sendC2CMessage(userOpenid, {
          content: fallbackText,
          msg_type: 0,
          keyboard: message.keyboard,
        });
      }
      throw err;
    }
  }

  /**
   * Acknowledge an interaction event (PUT /interactions/{interaction_id})
   * Crucial for mobile QQ to complete button interactions without timing out.
   * @param {string} interactionId - Interaction ID from INTERACTION_CREATE
   * @param {number} [code=0] - 0=Success, 1=Fail, 2=Frequent, 3=Duplicate, 4=No permission
   * @returns {Promise<any>}
   */
  async ackInteraction(interactionId, code = 0) {
    if (!interactionId) return null;
    const cleanId = String(interactionId).replace(/^INTERACTION_CREATE:/, '');
    try {
      return await this.request(`/interactions/${cleanId}`, {
        method: 'PUT',
        body: JSON.stringify({ code }),
      });
    } catch (err) {
      this.logger.warn?.(`[QQApiClient] Failed to ack interaction ${cleanId}: ${err.message}`);
      return null;
    }
  }

  /**
   * Send typing notification to user
   * @param {string} userOpenid
   * @param {string} msgId
   * @returns {Promise<any>}
   */
  async sendTyping(userOpenid, msgId) {
    if (!userOpenid || !msgId) return null;
    try {
      return await this.sendC2CMessage(userOpenid, {
        msg_type: 6,
        msg_id: msgId,
        input_notify: { input_type: 1, input_second: 60 },
      });
    } catch {
      // Typing indicator is best-effort; ignore errors
      return null;
    }
  }

  /**
   * Modify global custom menu (PUT /v2/menu)
   * Reference: https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_menu.put.html
   * @param {Object} menuConfig - Menu configuration
   * @returns {Promise<{ version: number }>}
   */
  async setGlobalMenu(menuConfig) {
    const payload = menuConfig.menu ? menuConfig : { menu: menuConfig };
    this.logger.info?.('[QQApiClient] Registering global custom menu (PUT /v2/menu)...');
    const result = await this.request('/v2/menu', {
      method: 'PUT',
      body: JSON.stringify(payload),
    });
    this.logger.info?.(`[QQApiClient] Global custom menu registered successfully (version: ${result?.version})`);
    return result;
  }

  /**
   * Query global custom menu (GET /v2/menu)
   * @returns {Promise<any>}
   */
  async getGlobalMenu() {
    return this.request('/v2/menu', { method: 'GET' });
  }

  /**
   * Build default global shortcut menu for DSH
   * Note:
   * Top-level item name: max 10 characters (Chinese char = 2 chars, so max 5 Chinese chars)
   * Sub-item name: max 14 characters (max 7 Chinese chars)
   * Items limit: max 10 top-level, max 5 sub-items per menu
   */
  getDefaultMenu() {
    return {
      items: [
        {
          type: 'send_message',
          name: '会话列表',
          send_message: '/sessions',
        },
        {
          type: 'send_message',
          name: '当前会话',
          send_message: '/current',
        },
        {
          type: 'send_message',
          name: '统计信息',
          send_message: '/stats',
        },
        {
          type: 'send_message',
          name: '切换模型',
          send_message: '/model',
        },
        {
          type: 'menu',
          name: '快捷操作',
          sub_menu_items: [
            {
              type: 'send_message',
              name: '新建会话',
              send_message: '/new',
            },
            {
              type: 'send_message',
              name: '切换预设',
              send_message: '/preset',
            },
            {
              type: 'send_message',
              name: '切换权限',
              send_message: '/permission',
            },
            {
              type: 'send_message',
              name: '取消当前任务',
              send_message: '/cancel',
            },
            {
              type: 'send_message',
              name: '帮助菜单',
              send_message: '/help',
            },
          ],
        },
      ],
    };
  }

  /**
   * Register DSH default global menu to QQ Bot
   */
  async registerDefaultGlobalMenu() {
    try {
      return await this.setGlobalMenu(this.getDefaultMenu());
    } catch (err) {
      this.logger.error?.(`[QQApiClient] Failed to register global custom menu: ${err.message}`);
      throw err;
    }
  }
}
