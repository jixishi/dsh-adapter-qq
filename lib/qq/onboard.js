/**
 * Official QQ Bot "scan to configure" (扫码绑定) flow.
 *
 * Protocol (verified against q.qq.com, mirrored by the official OpenClaw
 * onboarding reference):
 *   1. POST https://q.qq.com/lite/create_bind_task      { key }        -> task_id
 *   2. QR target: https://q.qq.com/qqbot/openclaw/connect.html?task_id=…
 *   3. POST https://q.qq.com/lite/poll_bind_result      { task_id }    -> status/appid/encrypted secret/openid
 *      status: 0 = none, 1 = pending, 2 = completed, 3 = expired
 *   4. Decrypt `bot_encrypt_secret` with the local AES-256-GCM key:
 *      base64( IV(12) || ciphertext || tag(16) ), AAD none.
 *
 * The AES key never leaves this process, so the bot secret comes back
 * encrypted to us and is decrypted only after the phone confirms the scan.
 */

import { randomBytes, createDecipheriv } from 'node:crypto';
import QRCode from 'qrcode';

export const PORTAL_HOST = process.env.QQ_PORTAL_HOST || 'q.qq.com';
export const ONBOARD_CREATE_PATH = '/lite/create_bind_task';
export const ONBOARD_POLL_PATH = '/lite/poll_bind_result';
export const QR_URL_TEMPLATE =
  'https://q.qq.com/qqbot/openclaw/connect.html?task_id={task_id}&_wv=2&source=dsh-adapter-qq';

export const BIND_STATUS = Object.freeze({
  NONE: 0,
  PENDING: 1,
  COMPLETED: 2,
  EXPIRED: 3,
});

export const BIND_TASK_TTL_MS = 15 * 60 * 1000;
const PORTAL_TIMEOUT_MS = 10000;

/** Structured onboarding failure carrying the q.qq.com retcode where present. */
export class OnboardError extends Error {
  /**
   * @param {string} message
   * @param {Object} [options]
   * @param {string} [options.code]
   * @param {number} [options.retcode]
   * @param {string} [options.detail]
   * @param {number} [options.status]
   */
  constructor(message, { code = 'ONBOARD_FAILED', retcode, detail, status } = {}) {
    super(message);
    this.name = 'OnboardError';
    this.code = code;
    if (retcode !== undefined) this.retcode = retcode;
    if (detail !== undefined) this.detail = detail;
    if (status !== undefined) this.status = status;
  }

  /** Serializable error payload for the HTTP route / settings UI. */
  toJSON() {
    return {
      code: this.code,
      message: this.message,
      ...(this.retcode !== undefined ? { retcode: this.retcode } : {}),
      ...(this.detail !== undefined ? { detail: this.detail } : {}),
      ...(this.status !== undefined ? { status: this.status } : {}),
    };
  }
}

/** Generate the per-task AES-256 key as base64. */
export function generateBindKey() {
  return randomBytes(32).toString('base64');
}

/**
 * Build the QR-code target URL for one task.
 * @param {string} taskId
 * @returns {string}
 */
export function buildConnectUrl(taskId) {
  return QR_URL_TEMPLATE.replace('{task_id}', encodeURIComponent(String(taskId)));
}

/**
 * Decrypt `bot_encrypt_secret` (AES-256-GCM, IV 12 bytes, tag last 16).
 * @param {string} encryptedBase64
 * @param {string} keyBase64
 * @returns {string} client secret
 */
export function decryptBindSecret(encryptedBase64, keyBase64) {
  const key = Buffer.from(String(keyBase64 || ''), 'base64');
  const raw = Buffer.from(String(encryptedBase64 || ''), 'base64');
  if (key.length !== 32) {
    throw new OnboardError('绑定密钥长度不正确（需要 32 字节 AES-256 密钥）', { code: 'BAD_KEY' });
  }
  if (raw.length < 12 + 16) {
    throw new OnboardError('加密密钥数据不完整（缺少 IV 或认证标签）', { code: 'BAD_CIPHERTEXT' });
  }
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(raw.length - 16);
  const ciphertext = raw.subarray(12, raw.length - 16);
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch (error) {
    throw new OnboardError(`解密机器人密钥失败：${error?.message ?? error}`, {
      code: 'DECRYPT_FAILED',
      detail: error?.message,
    });
  }
}

function headers() {
  return {
    'content-type': 'application/json',
    accept: 'application/json',
    // q.qq.com answers a JS anti-bot page without an explicit JSON Accept + UA.
    'user-agent': `dsh-adapter-qq (Node/${process.versions.node}; ${process.platform})`,
  };
}

/**
 * POST one q.qq.com bind-task endpoint and normalize errors.
 * @param {string} path
 * @param {Object} payload
 * @param {{fetchImpl?: Function, timeoutMs?: number}} [options]
 * @returns {Promise<Object>} parsed JSON with retcode 0
 */
async function portalPost(path, payload, { fetchImpl = globalThis.fetch, timeoutMs = PORTAL_TIMEOUT_MS } = {}) {
  if (typeof fetchImpl !== 'function') {
    throw new OnboardError('当前 Node 环境没有 fetch，无法连接 q.qq.com', { code: 'NO_FETCH' });
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs);
  let response;
  try {
    response = await fetchImpl(`https://${PORTAL_HOST}${path}`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } catch (error) {
    const timedOut = controller.signal.aborted;
    throw new OnboardError(
      timedOut ? `连接 q.qq.com 超时（${timeoutMs}ms）` : `无法连接 q.qq.com：${error?.message ?? error}`,
      { code: timedOut ? 'TIMEOUT' : 'NETWORK_ERROR', detail: error?.message }
    );
  } finally {
    clearTimeout(timer);
  }

  const text = await response.text().catch(() => '');
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new OnboardError(`q.qq.com 返回了非 JSON 响应（HTTP ${response.status}）`, {
      code: 'BAD_RESPONSE',
      status: response.status,
      detail: text.slice(0, 300),
    });
  }

  if (!response.ok) {
    throw new OnboardError(`q.qq.com 返回 HTTP ${response.status}`, {
      code: 'HTTP_ERROR',
      status: response.status,
      retcode: typeof data?.retcode === 'number' ? data.retcode : undefined,
      detail: text.slice(0, 300),
    });
  }
  if (data?.retcode !== 0) {
    throw new OnboardError(String(data?.msg || `q.qq.com 返回 retcode=${data?.retcode}`), {
      code: 'PORTAL_ERROR',
      retcode: typeof data?.retcode === 'number' ? data.retcode : undefined,
      detail: text.slice(0, 300),
    });
  }
  return data;
}

/**
 * Create one bind task.
 * @param {{fetchImpl?: Function, timeoutMs?: number}} [options]
 * @returns {Promise<{taskId:string, key:string, url:string}>}
 */
export async function createBindTask(options = {}) {
  const key = generateBindKey();
  const data = await portalPost(ONBOARD_CREATE_PATH, { key }, options);
  const taskId = data?.data?.task_id;
  if (!taskId) {
    throw new OnboardError('q.qq.com 未返回 task_id', {
      code: 'MISSING_TASK_ID',
      detail: JSON.stringify(data).slice(0, 300),
    });
  }
  return { taskId: String(taskId), key, url: buildConnectUrl(taskId) };
}

/**
 * Poll one bind task.
 * @param {string} taskId
 * @param {{fetchImpl?: Function, timeoutMs?: number}} [options]
 * @returns {Promise<{status:number, appId:string, encryptedSecret:string, userOpenid:string}>}
 */
export async function pollBindResult(taskId, options = {}) {
  const data = await portalPost(ONBOARD_POLL_PATH, { task_id: taskId }, options);
  const payload = data?.data ?? {};
  return {
    status: Number(payload.status ?? 0),
    appId: String(payload.bot_appid ?? ''),
    encryptedSecret: String(payload.bot_encrypt_secret ?? ''),
    userOpenid: String(payload.user_openid ?? ''),
  };
}

/** In-memory task store: taskId -> { key, url, createdAt }. */
export class BindTaskStore {
  constructor({ ttlMs = BIND_TASK_TTL_MS } = {}) {
    this.ttlMs = ttlMs;
    this.tasks = new Map();
  }

  prune(now = Date.now()) {
    for (const [taskId, task] of this.tasks) {
      if (now - task.createdAt > this.ttlMs) this.tasks.delete(taskId);
    }
  }

  set(taskId, record) {
    this.prune();
    this.tasks.set(String(taskId), { ...record, createdAt: Date.now() });
  }

  get(taskId) {
    this.prune();
    return this.tasks.get(String(taskId));
  }

  delete(taskId) {
    this.tasks.delete(String(taskId));
  }

  get size() {
    return this.tasks.size;
  }
}

/**
 * One onboarding operation behind the same-origin HTTP route.
 * Never throws: every failure is returned as `{ ok:false, error }`.
 *
 * @param {string} op - onboard-create | onboard-poll | onboard-cancel
 * @param {Object} args
 * @param {Object} deps
 * @param {BindTaskStore} deps.store
 * @param {Function} [deps.fetchImpl]
 * @param {Function} [deps.toDataUrl] - QR encoder (defaults to qrcode.toDataURL)
 * @param {Console|Object} [deps.logger]
 * @returns {Promise<Object>}
 */
export async function handleOnboardOp(op, args = {}, { store, fetchImpl, toDataUrl, logger = console } = {}) {
  try {
    if (!store) throw new OnboardError('绑定任务存储未初始化', { code: 'NO_STORE' });

    if (op === 'onboard-create') {
      const task = await createBindTask({ fetchImpl });
      store.set(task.taskId, { key: task.key, url: task.url });
      let qrDataUrl = '';
      try {
        const encode = toDataUrl || QRCode.toDataURL;
        qrDataUrl = await encode(task.url, { margin: 2, width: 320, errorCorrectionLevel: 'M' });
      } catch (error) {
        logger?.warn?.(`[adapter-qq] QR encode failed: ${error?.message ?? error}`);
      }
      return {
        ok: true,
        taskId: task.taskId,
        url: task.url,
        qrDataUrl,
        expiresInMs: BIND_TASK_TTL_MS,
        pollIntervalMs: 2000,
      };
    }

    if (op === 'onboard-poll') {
      const taskId = String(args.taskId || '');
      const task = taskId ? store.get(taskId) : undefined;
      if (!task) {
        throw new OnboardError('绑定任务不存在或已过期，请重新生成二维码', { code: 'TASK_NOT_FOUND' });
      }
      const result = await pollBindResult(taskId, { fetchImpl });
      if (result.status === BIND_STATUS.COMPLETED) {
        if (!result.encryptedSecret) {
          throw new OnboardError('q.qq.com 返回已完成但缺少 bot_encrypt_secret', {
            code: 'MISSING_SECRET',
          });
        }
        const clientSecret = decryptBindSecret(result.encryptedSecret, task.key);
        store.delete(taskId);
        return {
          ok: true,
          status: 'completed',
          appId: result.appId,
          clientSecret,
          userOpenid: result.userOpenid,
        };
      }
      if (result.status === BIND_STATUS.EXPIRED) {
        store.delete(taskId);
        return { ok: true, status: 'expired' };
      }
      return {
        ok: true,
        status: result.status === BIND_STATUS.PENDING ? 'pending' : 'none',
      };
    }

    if (op === 'onboard-cancel') {
      const taskId = String(args.taskId || '');
      if (taskId) store.delete(taskId);
      return { ok: true, status: 'cancelled' };
    }

    throw new OnboardError(`未知操作：${op || '(empty)'}`, { code: 'UNKNOWN_OP' });
  } catch (error) {
    const payload =
      error instanceof OnboardError
        ? error.toJSON()
        : { code: 'INTERNAL_ERROR', message: error?.message ?? String(error) };
    logger?.warn?.(`[adapter-qq] onboard ${op} failed: ${payload.code} ${payload.message}`);
    return { ok: false, error: payload };
  }
}

/**
 * Same-origin HTTP route used by the settings tab.
 * POST /dsh-adapter-qq/api  {"op":"onboard-create"|"onboard-poll"|"onboard-cancel","args":{}}
 *
 * @param {Object} options
 * @param {BindTaskStore} options.store
 * @param {Object} [options.logger]
 * @param {Function} [options.fetchImpl]
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void>}
 */
export function createOnboardRoute({ store, logger = console, fetchImpl } = {}) {
  return async function onboardRoute(req, res) {
    const send = (payload, status = 200) => {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(payload));
    };

    if (String(req.method || 'POST').toUpperCase() !== 'POST') {
      send({ ok: false, error: { code: 'METHOD_NOT_ALLOWED', message: '只支持 POST' } }, 405);
      return;
    }
    if (String(req.headers?.['x-dsh-plugin'] || '') !== 'dsh-adapter-qq') {
      send({ ok: false, error: { code: 'FORBIDDEN', message: '缺少 x-dsh-plugin 请求头' } }, 403);
      return;
    }

    let body = '';
    try {
      for await (const chunk of req) {
        body += chunk;
        if (body.length > 64 * 1024) throw new Error('body too large');
      }
    } catch (error) {
      send({ ok: false, error: { code: 'BAD_REQUEST', message: `读取请求体失败：${error.message}` } }, 400);
      return;
    }

    let payload;
    try {
      payload = body ? JSON.parse(body) : {};
    } catch {
      send({ ok: false, error: { code: 'BAD_JSON', message: '请求体不是合法 JSON' } }, 400);
      return;
    }

    const result = await handleOnboardOp(String(payload.op || ''), payload.args || {}, {
      store,
      fetchImpl,
      logger,
    });
    send(result, result.ok ? 200 : 200);
  };
}
