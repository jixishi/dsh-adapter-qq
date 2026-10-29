/**
 * QQ Open Platform OpenAPI v2 Client
 * Handles token fetching, gateway URL discovery, message sending, and global menu registration.
 * Reference: https://bot.q.qq.com/wiki/develop/api-v2/
 */

import { createHash } from 'node:crypto';
import {
  qqFileTypeFor,
  sanitizeFilename,
  sniffImageMediaType,
} from './media.js';

/** QQ binary direct upload hard limit: larger payloads must use chunked upload. */
const MAX_INLINE_UPLOAD_BYTES = 5 * 1024 * 1024;
/** md5_10m covers exactly the first 10,002,432 bytes of the file. */
const MD5_10M_BYTES = 10002432;
/** QQ rich-media `msg_type` for media messages. */
const MSG_TYPE_MEDIA = 7;
/** QQ error code: "unsupported file format". */
const QQ_CODE_UNSUPPORTED_FILE_TYPE = 850019;

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
      if (errorJson && errorJson.code !== undefined) err.code = errorJson.code;
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
   * @param {number} [message.msg_type] - Explicit msg_type (0=text, 2=markdown, 6=input_notify, 7=media)
   * @param {string|Object} [message.media] - Rich media (msg_type 7): file_info string or `{ file_info }` object
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
      payload.msg_type = Number(message.msg_type);
    } else if (message.media) {
      payload.msg_type = MSG_TYPE_MEDIA;
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
    } else if (payload.msg_type === MSG_TYPE_MEDIA) {
      if (!message.media) {
        throw new Error('media is required when msg_type is 7 (rich media).');
      }
      payload.media = typeof message.media === 'string'
        ? { file_info: message.media }
        : message.media;
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
   * Recall a sent C2C message (DELETE /v2/users/{user_openid}/messages/{message_id})
   * Reference: https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_users_user_openid_messages_message_id.delete.html
   * @param {string} userOpenid
   * @param {string} messageId
   * @returns {Promise<boolean>}
   */
  async recallC2CMessage(userOpenid, messageId) {
    if (!userOpenid || !messageId) return false;
    try {
      await this.request(`/v2/users/${userOpenid}/messages/${messageId}`, {
        method: 'DELETE',
      });
      return true;
    } catch (err) {
      this.logger.warn?.(`[QQApiClient] Failed to recall message ${messageId}: ${err.message}`);
      return false;
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
   * Upload rich media for a C2C (single) chat via the official
   * `POST /v2/users/{openid}/files` endpoint.
   *
   * - `data.length <= 5MB`: binary direct upload (`file_data` base64).
   * - larger: chunked upload — `upload_prepare` -> bare PUT per presigned URL
   *   -> `upload_part_finish` per part -> `files` merge via `upload_id`.
   *
   * @param {string} userOpenid
   * @param {Object} options
   * @param {1|2|3|4} options.fileType - QQ file_type (1=image, 2=video, 3=voice, 4=file)
   * @param {Buffer|Uint8Array|ArrayBuffer} options.data - Raw media bytes
   * @param {string} options.filename - Filename presented by QQ
   * @returns {Promise<{ fileInfo: string, fileUuid: string|null, ttl: number, rawUrl?: string }>}
   */
  async uploadUserMedia(userOpenid, { fileType, data, filename } = {}) {
    if (!userOpenid) {
      throw new Error('userOpenid is required to upload media.');
    }

    const type = Number(fileType);
    if (!Number.isInteger(type) || type < 1 || type > 4) {
      throw new Error(`Invalid QQ file_type "${fileType}" (expected 1, 2, 3 or 4).`);
    }

    const bytes = mediaBytes(data);
    if (!bytes.length) {
      throw new Error('Media data is empty.');
    }

    const safeName = sanitizeFilename(filename);
    const basePath = `/v2/users/${userOpenid}`;

    // Small payloads can be uploaded directly as base64.
    if (bytes.length <= MAX_INLINE_UPLOAD_BYTES) {
      const result = await this.request(`${basePath}/files`, {
        method: 'POST',
        body: JSON.stringify({
          file_type: type,
          file_name: safeName,
          file_data: bytes.toString('base64'),
          srv_send_msg: false,
        }),
      });
      return normalizeUploadResult(result);
    }

    // Large payloads: prepare -> PUT parts -> finish parts -> merge.
    const md5 = md5Hex(bytes);
    const sha1 = createHash('sha1').update(bytes).digest('hex');
    const md5_10m = md5Hex(bytes.subarray(0, Math.min(bytes.length, MD5_10M_BYTES)));

    const prepare = await this.request(`${basePath}/upload_prepare`, {
      method: 'POST',
      body: JSON.stringify({
        file_type: type,
        file_size: String(bytes.length),
        file_name: safeName,
        md5,
        sha1,
        md5_10m,
      }),
    });

    const uploadId = prepare?.upload_id ? String(prepare.upload_id) : '';
    if (!uploadId) {
      throw new Error(`QQ upload_prepare returned no upload_id: ${previewJson(prepare)}`);
    }

    const parts = normalizePreparedParts(prepare);
    if (parts.length === 0) {
      throw new Error(`QQ upload_prepare returned no parts: ${previewJson(prepare)}`);
    }

    const blockSize = Number(prepare?.block_size) || 0;
    this.logger.info?.(
      `[QQApiClient] Chunked media upload: ${bytes.length} bytes, ${parts.length} part(s), block_size=${blockSize || 'n/a'}`,
    );

    let uploadedBytes = 0;
    let fallbackOffset = 0;
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const partIndex = Number.isInteger(part.index) ? part.index : i;
      const offset = blockSize > 0 ? partIndex * blockSize : fallbackOffset;
      const remaining = bytes.length - offset;
      if (remaining <= 0) continue;

      const expectedSize = part.blockSize > 0 ? part.blockSize : (blockSize > 0 ? blockSize : remaining);
      const chunk = bytes.subarray(offset, offset + Math.min(expectedSize, remaining));

      // Presigned COS URLs must be uploaded with a bare request: no QQ
      // Authorization / X-Union-Appid headers, otherwise COS rejects it.
      const putRes = await fetch(part.url, { method: 'PUT', body: chunk });
      if (!putRes.ok) {
        let detail = '';
        try {
          detail = String(await putRes.text()).slice(0, 200);
        } catch {
          // ignore body read failure
        }
        throw new Error(
          `QQ media part ${partIndex} upload failed: HTTP ${putRes.status}${detail ? ` - ${detail}` : ''}`,
        );
      }

      await this.request(`${basePath}/upload_part_finish`, {
        method: 'POST',
        body: JSON.stringify({
          upload_id: uploadId,
          part_index: partIndex, // QQ part indexes are 0-based.
          block_size: String(chunk.length),
          md5: md5Hex(chunk),
        }),
      });

      uploadedBytes += chunk.length;
      fallbackOffset = offset + chunk.length;
    }

    if (uploadedBytes < bytes.length) {
      throw new Error(
        `QQ chunked upload incomplete: uploaded ${uploadedBytes} of ${bytes.length} bytes.`,
      );
    }

    const merged = await this.request(`${basePath}/files`, {
      method: 'POST',
      body: JSON.stringify({
        file_type: type,
        upload_id: uploadId,
        file_name: safeName,
        srv_send_msg: false,
      }),
    });
    return normalizeUploadResult(merged);
  }

  /**
   * Send an already-uploaded rich media asset (msg_type 7).
   * @param {string} userOpenid
   * @param {Object} options
   * @param {string|Object} options.fileInfo - file_info from uploadUserMedia
   * @param {string} [options.msgId] - Passive reply msg_id
   * @param {number} [options.msgSeq]
   * @returns {Promise<object>} Raw QQ response (contains `id` when accepted)
   */
  async sendUserMedia(userOpenid, { fileInfo, msgId, msgSeq } = {}) {
    if (!fileInfo) {
      throw new Error('fileInfo is required to send rich media message.');
    }
    const media = typeof fileInfo === 'string' ? { file_info: fileInfo } : fileInfo;
    return this.sendC2CMessage(userOpenid, {
      msg_type: MSG_TYPE_MEDIA,
      media,
      ...(msgId ? { msg_id: msgId } : {}),
      ...(msgSeq !== undefined ? { msg_seq: msgSeq } : {}),
    });
  }

  /**
   * Upload and send an image. The real format is sniffed from the bytes
   * (never from the extension); the first attempt uses `file_type=1` and, if
   * QQ answers 850019 (unsupported file format), retries as `file_type=4`.
   * @param {string} userOpenid
   * @param {Object} options
   * @param {Buffer|Uint8Array|ArrayBuffer} options.data
   * @param {string} options.filename
   * @param {string} [options.msgId]
   * @returns {Promise<{ fileInfo: string, fileUuid: string|null, messageId: string|null }>}
   */
  async sendImage(userOpenid, { data, filename, msgId } = {}) {
    const bytes = mediaBytes(data);
    if (!bytes.length) {
      throw new Error('Image data is empty.');
    }

    const mediaType = sniffImageMediaType(bytes);
    if (!mediaType) {
      this.logger.warn?.(
        `[QQApiClient] Image bytes could not be identified (${bytes.length} bytes); trying file_type=1 anyway.`,
      );
    }

    try {
      return await this._uploadAndSendMedia(userOpenid, {
        fileType: 1,
        bytes,
        filename,
        msgId,
      });
    } catch (err) {
      if (!isQQErrorCode(err, QQ_CODE_UNSUPPORTED_FILE_TYPE)) throw err;
      this.logger.warn?.(
        '[QQApiClient] QQ rejected the image format (850019), retrying as file_type=4 (file)...',
      );
      return this._uploadAndSendMedia(userOpenid, {
        fileType: 4,
        bytes,
        filename,
        msgId,
      });
    }
  }

  /**
   * Upload and send a file. The QQ `file_type` is derived from the filename
   * extension (4 = plain file unless it looks like image/video/voice).
   * @param {string} userOpenid
   * @param {Object} options
   * @param {Buffer|Uint8Array|ArrayBuffer} options.data
   * @param {string} options.filename
   * @param {string} [options.msgId]
   * @returns {Promise<{ fileInfo: string, fileUuid: string|null, messageId: string|null }>}
   */
  async sendFile(userOpenid, { data, filename, msgId } = {}) {
    const bytes = mediaBytes(data);
    if (!bytes.length) {
      throw new Error('File data is empty.');
    }
    const safeName = sanitizeFilename(filename);
    const fileType = qqFileTypeFor({ filename: safeName });
    return this._uploadAndSendMedia(userOpenid, {
      fileType,
      bytes,
      filename: safeName,
      msgId,
    });
  }

  /**
   * Internal: upload one asset then send it as a msg_type=7 media message.
   * @param {string} userOpenid
   * @param {Object} options
   * @param {number} options.fileType
   * @param {Buffer} options.bytes
   * @param {string} [options.filename]
   * @param {string} [options.msgId]
   * @returns {Promise<{ fileInfo: string, fileUuid: string|null, messageId: string|null }>}
   */
  async _uploadAndSendMedia(userOpenid, { fileType, bytes, filename, msgId }) {
    const uploaded = await this.uploadUserMedia(userOpenid, {
      fileType,
      data: bytes,
      filename,
    });
    const sent = await this.sendUserMedia(userOpenid, {
      fileInfo: uploaded.fileInfo,
      msgId,
    });
    return {
      fileInfo: uploaded.fileInfo,
      fileUuid: uploaded.fileUuid,
      messageId: sent?.id ?? null,
    };
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
  /**
   * Default QQ bottom menu.
   * @param {{team?:boolean, schedule?:boolean, terminal?:boolean}} [options]
   *   capabilities detected from the host (official plugins enabled).
   */
  getDefaultMenu(options = {}) {
    const items = [
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
        name: '技能',
        send_message: '/skills',
      },
      {
        type: 'send_message',
        name: 'MCP',
        send_message: '/mcp',
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
    ];
    if (options.team || options.schedule) {
      items.push({ type: 'send_message', name: '代理状态', send_message: '/status' });
    }
    if (options.schedule) {
      items.push({ type: 'send_message', name: '任务', send_message: '/tasks' });
    }
    if (options.terminal) {
      items.push({ type: 'send_message', name: '后台任务', send_message: '/jobs' });
    }
    items.push({
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
          name: '渲染图片',
          send_message: '/render',
        },
        {
          type: 'send_message',
          name: '取消任务',
          send_message: '/cancel',
        },
      ],
    });
    return { items };
  }

  /**
   * Register DSH default global menu to QQ Bot
   * @param {{team?:boolean, schedule?:boolean, terminal?:boolean}} [options]
   */
  async registerDefaultGlobalMenu(options = {}) {
    try {
      return await this.setGlobalMenu(this.getDefaultMenu(options));
    } catch (err) {
      this.logger.error?.(`[QQApiClient] Failed to register global custom menu: ${err.message}`);
      throw err;
    }
  }
}

/**
 * Coerce a supported binary input to Buffer.
 * @param {Buffer|Uint8Array|ArrayBuffer} data
 * @returns {Buffer}
 */
function mediaBytes(data) {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof Uint8Array) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  }
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  throw new Error('Media data must be a Buffer, Uint8Array or ArrayBuffer.');
}

/**
 * @param {Buffer} buffer
 * @returns {string} lowercase hex MD5
 */
function md5Hex(buffer) {
  return createHash('md5').update(buffer).digest('hex');
}

/**
 * Detect a QQ business error code on a thrown API error.
 * @param {Error} err
 * @param {number} code
 * @returns {boolean}
 */
function isQQErrorCode(err, code) {
  if (!err) return false;
  if (Number(err.code) === code) return true;
  if (err.response && typeof err.response === 'object' && Number(err.response.code) === code) return true;
  return String(err.message || '').includes(String(code));
}

/**
 * Normalize the `upload_prepare` response into a uniform parts list.
 * Supports the documented `parts: [{ index, presigned_url, block_size }]`
 * shape and a legacy `presigned_urls: [url]` shape.
 * @param {object} prepare
 * @returns {Array<{ index: number, url: string, blockSize: number }>}
 */
function normalizePreparedParts(prepare) {
  const rawParts = Array.isArray(prepare?.parts)
    ? prepare.parts
    : (Array.isArray(prepare?.presigned_urls) ? prepare.presigned_urls : []);

  const parts = [];
  rawParts.forEach((entry, fallbackIndex) => {
    if (typeof entry === 'string') {
      if (entry) parts.push({ index: fallbackIndex, url: entry, blockSize: 0 });
      return;
    }
    if (!entry || typeof entry !== 'object') return;
    const url = entry.presigned_url || entry.url || '';
    if (!url) return;
    const rawIndex = Number.isInteger(entry.index) ? entry.index : Number(entry.part_index);
    parts.push({
      index: Number.isInteger(rawIndex) ? rawIndex : fallbackIndex,
      url: String(url),
      blockSize: Number(entry.block_size) || 0,
    });
  });
  return parts;
}

/**
 * Map a QQ `/files` response to the public upload result shape.
 * @param {object} result
 * @returns {{ fileInfo: string, fileUuid: string|null, ttl: number, rawUrl?: string }}
 */
function normalizeUploadResult(result) {
  const fileInfo = result?.file_info;
  if (!fileInfo) {
    throw new Error(`QQ media upload returned no file_info: ${previewJson(result)}`);
  }
  const normalized = {
    fileInfo: String(fileInfo),
    fileUuid: result.file_uuid ? String(result.file_uuid) : null,
    ttl: Number.isFinite(Number(result.ttl)) ? Number(result.ttl) : 0,
  };
  if (result.raw_url) normalized.rawUrl = String(result.raw_url);
  return normalized;
}

/**
 * Short JSON preview for error messages.
 * @param {unknown} value
 * @returns {string}
 */
function previewJson(value) {
  try {
    return String(JSON.stringify(value)).slice(0, 200);
  } catch {
    return String(value).slice(0, 200);
  }
}
