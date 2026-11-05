/**
 * Loopback HTTP API for the "订阅管理" sidebar pane.
 *
 * The sidebar runs in the browser and cannot touch the host filesystem, so the
 * subscription store is exposed over same-origin HTTP. The route is deliberately
 * narrow:
 *
 *   POST /dsh-adapter-qq/subscriptions   { op, args }   -> { ok, ... }
 *
 * Ops:
 *   list        {}                                   -> snapshot + candidate sessions
 *   subscribe   { sessionId, title, intervalMinutes } -> snapshot
 *   unsubscribe { sessionId }                         -> snapshot
 *   setInterval { sessionId, intervalMinutes }        -> snapshot
 *   flush       {}                                    -> force-send pending digests
 *
 * Safety: the same `x-dsh-plugin` header check the onboarding route uses, plus a
 * 64KiB body limit, so a stray cross-site form post cannot drive it.
 */

import { formatRelativeTime, groupByWorkspace, workspaceLabel } from '../sync/display-time.js';

const PLUGIN_HEADER = 'dsh-adapter-qq';
const MAX_BODY_BYTES = 64 * 1024;

/**
 * @param {Object} options
 * @param {Object} options.store SubscriptionStore
 * @param {Object} [options.scheduler] SubscriptionScheduler (for `flush`)
 * @param {Function} [options.listSessions] async () => Array<{sessionId,title,cwd,...}>
 * @param {Function} [options.getActiveSessionId] async () => string
 * @param {Object} [options.logger]
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void>}
 */
export function createSubscriptionRoute({
  store,
  scheduler = null,
  listSessions = null,
  getActiveSessionId = null,
  now = () => Date.now(),
  logger = console,
} = {}) {
  return async function subscriptionRoute(req, res) {
    const send = (payload, status = 200) => {
      const body = JSON.stringify(payload);
      res.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
      });
      res.end(body);
    };

    if (String(req.method || 'POST').toUpperCase() !== 'POST') {
      send({ ok: false, error: { code: 'METHOD_NOT_ALLOWED', message: '只支持 POST' } }, 405);
      return;
    }
    if (String(req.headers?.['x-dsh-plugin'] || '') !== PLUGIN_HEADER) {
      send({ ok: false, error: { code: 'FORBIDDEN', message: '缺少 x-dsh-plugin 请求头' } }, 403);
      return;
    }

    let raw = '';
    try {
      for await (const chunk of req) {
        raw += chunk;
        if (raw.length > MAX_BODY_BYTES) throw new Error('body too large');
      }
    } catch (error) {
      send({ ok: false, error: { code: 'BAD_REQUEST', message: `读取请求体失败：${error.message}` } }, 400);
      return;
    }

    let payload = {};
    if (raw) {
      try {
        payload = JSON.parse(raw);
      } catch {
        send({ ok: false, error: { code: 'BAD_JSON', message: '请求体不是合法 JSON' } }, 400);
        return;
      }
    }

    if (!store) {
      send({ ok: false, error: { code: 'NO_STORE', message: '订阅存储未初始化' } }, 500);
      return;
    }

    const op = String(payload.op || 'list');
    const args = payload.args && typeof payload.args === 'object' ? payload.args : {};

    try {
      const result = await handleOp(op, args);
      send({ ok: true, ...result });
    } catch (error) {
      const code = error?.code || 'OPERATION_FAILED';
      const status = code === 'NOT_FOUND' ? 404 : 400;
      logger?.warn?.(`[adapter-qq] 订阅 API 失败（${op}）：${error.message}`);
      send({ ok: false, error: { code, message: error.message } }, status);
    }

    async function handleOp(name, input) {
      if (name === 'list') {
        const snapshot = store.snapshot();
        const [sessions, activeId] = await Promise.all([
          typeof listSessions === 'function' ? listSessions().catch(() => []) : Promise.resolve([]),
          typeof getActiveSessionId === 'function' ? getActiveSessionId().catch(() => '') : Promise.resolve(''),
        ]);
        const subscribedIds = new Set(snapshot.subscriptions.map((item) => item.sessionId));
        const currentTime = now();
        const bySessionId = new Map();

        const candidates = (Array.isArray(sessions) ? sessions : [])
          .filter((item) => item && item.sessionId)
          .map((item) => {
            const updatedAt = Number(item.updatedAt) || 0;
            const row = {
              sessionId: item.sessionId,
              title: item.title || item.sessionId,
              cwd: item.cwd || '',
              workspace: workspaceLabel(item.cwd),
              running: item.running === true,
              subscribed: subscribedIds.has(item.sessionId),
              active: item.sessionId === activeId,
              updatedAt,
              // Same wording the DSH left sidebar uses for the same field.
              updatedLabel: formatRelativeTime(updatedAt, currentTime),
            };
            bySessionId.set(row.sessionId, row);
            return row;
          })
          .sort((a, b) => {
            // Active first, then already-subscribed, then most recently updated.
            if (a.active !== b.active) return a.active ? -1 : 1;
            if (a.subscribed !== b.subscribed) return a.subscribed ? -1 : 1;
            return (b.updatedAt || 0) - (a.updatedAt || 0);
          });

        // Attach workspace + last activity to each subscription. A subscription
        // can outlive the session listing (cold session), so fall back to the
        // stored title instead of dropping the row.
        const subscriptions = snapshot.subscriptions.map((item) => {
          const row = bySessionId.get(item.sessionId);
          return {
            ...item,
            cwd: row?.cwd || '',
            workspace: row ? row.workspace : '未指定工作区',
            updatedAt: row?.updatedAt || 0,
            updatedLabel: row ? row.updatedLabel : formatRelativeTime(item.lastNotifiedAt, currentTime),
          };
        });

        return {
          ...snapshot,
          subscriptions,
          activeSessionId: activeId,
          sessions: candidates,
          workspaceGroups: groupByWorkspace(candidates),
        };
      }

      if (name === 'subscribe') {
        const sessionId = String(input.sessionId || '').trim();
        if (!sessionId) {
          const error = new Error('缺少 sessionId');
          error.code = 'BAD_REQUEST';
          throw error;
        }
        await store.subscribe({
          sessionId,
          title: String(input.title || ''),
          intervalMinutes: input.intervalMinutes,
        });
        scheduler?.arm();
        return { ...store.snapshot() };
      }

      if (name === 'unsubscribe') {
        const sessionId = String(input.sessionId || '').trim();
        if (!sessionId) {
          const error = new Error('缺少 sessionId');
          error.code = 'BAD_REQUEST';
          throw error;
        }
        const removed = await store.unsubscribe(sessionId);
        scheduler?.arm();
        return { removed, ...store.snapshot() };
      }

      if (name === 'setInterval') {
        const sessionId = String(input.sessionId || '').trim();
        const updated = await store.setIntervalMinutes(sessionId, input.intervalMinutes);
        if (!updated) {
          const error = new Error(`会话 ${sessionId || '(空)'} 没有订阅`);
          error.code = 'NOT_FOUND';
          throw error;
        }
        scheduler?.arm();
        return { ...store.snapshot() };
      }

      if (name === 'flush') {
        // "立即推送" must ignore the coalescing window: waiting for the interval
        // made the button a no-op for anything buffered but not yet due.
        const flushed = scheduler ? await scheduler.flushAll() : [];
        return { flushed, flushedCount: flushed.length, ...store.snapshot() };
      }

      const error = new Error(`未知操作：${name}`);
      error.code = 'UNKNOWN_OP';
      throw error;
    }
  };
}
