import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { SubscriptionStore } from '../lib/sync/subscriptions.js';
import { createSubscriptionRoute } from '../lib/qq/subscription-route.js';

const silent = { warn() {}, info() {}, error() {} };

/**
 * Drive the route with plain objects: a minimal IncomingMessage substitute
 * (async-iterable body) and a ServerResponse recorder.
 */
async function callRoute(handler, { method = 'POST', body = {}, headers = {} } = {}) {
  const payload = typeof body === 'string' ? body : JSON.stringify(body);
  const req = {
    method,
    headers: { 'x-dsh-plugin': 'dsh-adapter-qq', ...headers },
    async *[Symbol.asyncIterator]() {
      if (payload) yield Buffer.from(payload, 'utf8');
    },
  };
  let statusCode = 200;
  let raw = '';
  const res = {
    writeHead(code) {
      statusCode = code;
    },
    end(chunk) {
      raw += chunk ?? '';
    },
  };
  await handler(req, res);
  let json = null;
  try {
    json = JSON.parse(raw);
  } catch {
    /* leave null */
  }
  return { statusCode, json, raw };
}

describe('subscription HTTP route', () => {
  let dir;
  let store;
  let handler;
  let sessions;
  let activeId;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-sub-route-'));
    store = new SubscriptionStore({ filePath: path.join(dir, 'subs.json'), logger: silent });
    sessions = [
      { sessionId: 'sess-active', title: '当前会话', cwd: 'W:/a', running: true, updatedAt: 300 },
      { sessionId: 'sess-bg', title: '后台会话', cwd: 'W:/b', running: false, updatedAt: 200 },
      { sessionId: 'sess-old', title: '旧会话', cwd: 'W:/c', running: false, updatedAt: 100 },
    ];
    activeId = 'sess-active';
    handler = createSubscriptionRoute({
      store,
      listSessions: async () => sessions,
      getActiveSessionId: async () => activeId,
      logger: silent,
    });
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('rejects non-POST and missing plugin header', async () => {
    const wrongMethod = await callRoute(handler, { method: 'GET' });
    assert.equal(wrongMethod.statusCode, 405);
    assert.equal(wrongMethod.json.error.code, 'METHOD_NOT_ALLOWED');

    const noHeader = await callRoute(handler, { headers: { 'x-dsh-plugin': 'someone-else' } });
    assert.equal(noHeader.statusCode, 403);
    assert.equal(noHeader.json.error.code, 'FORBIDDEN');
  });

  it('rejects invalid JSON and unknown ops', async () => {
    const badJson = await callRoute(handler, { body: '{ nope' });
    assert.equal(badJson.statusCode, 400);
    assert.equal(badJson.json.error.code, 'BAD_JSON');

    const unknown = await callRoute(handler, { body: { op: 'explode' } });
    assert.equal(unknown.statusCode, 400);
    assert.equal(unknown.json.error.code, 'UNKNOWN_OP');
  });

  it('lists subscriptions together with candidate sessions', async () => {
    await store.subscribe({ sessionId: 'sess-bg', title: '后台会话', intervalMinutes: 15 });
    const result = await callRoute(handler, { body: { op: 'list' } });
    assert.equal(result.statusCode, 200);
    assert.equal(result.json.ok, true);
    assert.equal(result.json.subscriptions.length, 1);
    assert.equal(result.json.defaultInterval, 5);
    assert.deepEqual(result.json.intervals, [1, 5, 15, 30, 60]);
    assert.equal(result.json.activeSessionId, 'sess-active');

    const byId = Object.fromEntries(result.json.sessions.map((s) => [s.sessionId, s]));
    assert.equal(byId['sess-bg'].subscribed, true);
    assert.equal(byId['sess-active'].active, true);
    assert.equal(byId['sess-old'].subscribed, false);
    // Active session sorts first.
    assert.equal(result.json.sessions[0].sessionId, 'sess-active');
  });

  it('subscribes, changes the interval and unsubscribes', async () => {
    const add = await callRoute(handler, {
      body: { op: 'subscribe', args: { sessionId: 'sess-bg', title: '后台会话', intervalMinutes: 30 } },
    });
    assert.equal(add.statusCode, 200);
    assert.equal(add.json.subscriptions.length, 1);
    assert.equal(add.json.subscriptions[0].intervalMinutes, 30);

    const update = await callRoute(handler, {
      body: { op: 'setInterval', args: { sessionId: 'sess-bg', intervalMinutes: 1 } },
    });
    assert.equal(update.statusCode, 200);
    assert.equal(update.json.subscriptions[0].intervalMinutes, 1);

    const remove = await callRoute(handler, {
      body: { op: 'unsubscribe', args: { sessionId: 'sess-bg' } },
    });
    assert.equal(remove.statusCode, 200);
    assert.equal(remove.json.removed, true);
    assert.equal(remove.json.subscriptions.length, 0);
  });

  it('reports a missing session id and an unknown interval target', async () => {
    const noId = await callRoute(handler, { body: { op: 'subscribe', args: {} } });
    assert.equal(noId.statusCode, 400);
    assert.match(noId.json.error.message, /sessionId/);

    const missing = await callRoute(handler, {
      body: { op: 'setInterval', args: { sessionId: 'not-subscribed', intervalMinutes: 5 } },
    });
    assert.equal(missing.statusCode, 404);
    assert.equal(missing.json.error.code, 'NOT_FOUND');
  });

  it('persists through the route so a restart keeps subscriptions', async () => {
    await callRoute(handler, {
      body: { op: 'subscribe', args: { sessionId: 'sess-old', title: '旧会话', intervalMinutes: 60 } },
    });
    const reloaded = new SubscriptionStore({ filePath: store.filePath, logger: silent });
    reloaded.load();
    assert.equal(reloaded.has('sess-old'), true);
    assert.equal(reloaded.get('sess-old').intervalMinutes, 60);
  });

  it('tolerates a session listing that throws', async () => {
    const failing = createSubscriptionRoute({
      store,
      listSessions: async () => {
        throw new Error('controller offline');
      },
      getActiveSessionId: async () => {
        throw new Error('no active');
      },
      logger: silent,
    });
    const result = await callRoute(failing, { body: { op: 'list' } });
    assert.equal(result.statusCode, 200);
    assert.deepEqual(result.json.sessions, []);
    assert.equal(result.json.activeSessionId, '');
  });
});
