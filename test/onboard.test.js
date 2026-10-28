import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, createCipheriv } from 'node:crypto';

import {
  BIND_STATUS,
  BindTaskStore,
  OnboardError,
  buildConnectUrl,
  createBindTask,
  createOnboardRoute,
  decryptBindSecret,
  generateBindKey,
  handleOnboardOp,
  pollBindResult,
} from '../lib/qq/onboard.js';

function portalResponse(payload, { ok = true, status = 200 } = {}) {
  return {
    ok,
    status,
    text: async () => (typeof payload === 'string' ? payload : JSON.stringify(payload)),
  };
}

function encryptSecret(secret, keyBase64) {
  const key = Buffer.from(keyBase64, 'base64');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, ciphertext, cipher.getAuthTag()]).toString('base64');
}

describe('QQ scan-to-bind protocol', () => {
  it('generates a base64 AES-256 key and builds the QR URL', () => {
    const key = generateBindKey();
    assert.equal(Buffer.from(key, 'base64').length, 32);
    const url = buildConnectUrl('task/a b');
    assert.ok(url.startsWith('https://q.qq.com/qqbot/openclaw/connect.html?task_id='));
    assert.ok(url.includes('task%2Fa%20b'));
    assert.ok(url.includes('&_wv=2'));
  });

  it('decrypts a bot secret encrypted from the local AES key', () => {
    const key = generateBindKey();
    const payload = encryptSecret('client-secret-123', key);
    assert.equal(decryptBindSecret(payload, key), 'client-secret-123');
  });

  it('rejects a malformed key or ciphertext', () => {
    assert.throws(() => decryptBindSecret('AAAA', generateBindKey()), /密钥长度|不完整/);
    assert.throws(() => decryptBindSecret('AAAA', 'AAAA'), OnboardError);
  });

  it('creates a bind task and converts portal errors into structured errors', async () => {
    const created = await createBindTask({
      fetchImpl: async () => portalResponse({ retcode: 0, data: { task_id: 'task-1' } }),
    });
    assert.equal(created.taskId, 'task-1');
    assert.equal(created.url, buildConnectUrl('task-1'));
    assert.equal(Buffer.from(created.key, 'base64').length, 32);

    await assert.rejects(
      createBindTask({ fetchImpl: async () => portalResponse({ retcode: 0, data: {} }) }),
      (error) => error instanceof OnboardError && error.code === 'MISSING_TASK_ID'
    );

    await assert.rejects(
      createBindTask({ fetchImpl: async () => portalResponse({ retcode: 10000, msg: '不支持的操作' }) }),
      (error) =>
        error instanceof OnboardError &&
        error.code === 'PORTAL_ERROR' &&
        error.retcode === 10000 &&
        error.message === '不支持的操作'
    );
  });

  it('surfaces network, HTTP and non-JSON failures', async () => {
    await assert.rejects(
      createBindTask({
        fetchImpl: async () => {
          throw new Error('boom');
        },
      }),
      (error) => error.code === 'NETWORK_ERROR' && /boom/.test(error.message)
    );
    await assert.rejects(
      createBindTask({ fetchImpl: async () => portalResponse('<html>', { ok: false, status: 502 }) }),
      (error) => error.code === 'BAD_RESPONSE' && error.status === 502
    );
    await assert.rejects(
      createBindTask({ fetchImpl: async () => portalResponse({ retcode: 1, msg: 'x' }, { ok: false, status: 500 }) }),
      (error) => error.code === 'HTTP_ERROR' && error.status === 500 && error.retcode === 1
    );
  });

  it('polls bind result statuses', async () => {
    const pending = await pollBindResult('t', {
      fetchImpl: async () => portalResponse({ retcode: 0, data: { status: BIND_STATUS.PENDING } }),
    });
    assert.equal(pending.status, BIND_STATUS.PENDING);
    const done = await pollBindResult('t', {
      fetchImpl: async () =>
        portalResponse({
          retcode: 0,
          data: { status: 2, bot_appid: '123', bot_encrypt_secret: 'enc', user_openid: 'openid' },
        }),
    });
    assert.deepEqual(done, {
      status: 2,
      appId: '123',
      encryptedSecret: 'enc',
      userOpenid: 'openid',
    });
  });
});

describe('Onboard HTTP operations', () => {
  const qrStub = async (url) => `data:image/png;base64,${Buffer.from(url).toString('base64')}`;

  it('creates a task, returns a QR image and keeps the key server-side', async () => {
    const store = new BindTaskStore();
    const result = await handleOnboardOp(
      'onboard-create',
      {},
      {
        store,
        toDataUrl: qrStub,
        fetchImpl: async () => portalResponse({ retcode: 0, data: { task_id: 'task-1' } }),
      }
    );
    assert.equal(result.ok, true);
    assert.equal(result.taskId, 'task-1');
    assert.ok(result.qrDataUrl.startsWith('data:image/png;base64,'));
    assert.equal(store.size, 1);
    assert.ok(store.get('task-1').key);
  });

  it('completes with decrypted credentials and clears the task', async () => {
    const store = new BindTaskStore();
    const key = generateBindKey();
    store.set('task-2', { key, url: 'https://example' });
    const encryptedSecret = encryptSecret('secret-xyz', key);
    const result = await handleOnboardOp(
      'onboard-poll',
      { taskId: 'task-2' },
      {
        store,
        fetchImpl: async () =>
          portalResponse({
            retcode: 0,
            data: {
              status: BIND_STATUS.COMPLETED,
              bot_appid: 'app-1',
              bot_encrypt_secret: encryptedSecret,
              user_openid: 'openid-1',
            },
          }),
      }
    );
    assert.deepEqual(result, {
      ok: true,
      status: 'completed',
      appId: 'app-1',
      clientSecret: 'secret-xyz',
      userOpenid: 'openid-1',
    });
    assert.equal(store.size, 0);
  });

  it('reports expiry and missing tasks as structured errors', async () => {
    const store = new BindTaskStore();
    store.set('expired-1', { key: generateBindKey(), url: 'x' });
    const expired = await handleOnboardOp(
      'onboard-poll',
      { taskId: 'expired-1' },
      { store, fetchImpl: async () => portalResponse({ retcode: 0, data: { status: 3 } }) }
    );
    assert.deepEqual(expired, { ok: true, status: 'expired' });
    assert.equal(store.size, 0);

    const missing = await handleOnboardOp('onboard-poll', { taskId: 'nope' }, { store });
    assert.equal(missing.ok, false);
    assert.equal(missing.error.code, 'TASK_NOT_FOUND');

    const unknown = await handleOnboardOp('what', {}, { store });
    assert.equal(unknown.error.code, 'UNKNOWN_OP');
  });

  it('returns portal failures from the create operation', async () => {
    const result = await handleOnboardOp(
      'onboard-create',
      {},
      {
        store: new BindTaskStore(),
        fetchImpl: async () => portalResponse({ retcode: 850031, msg: '超过限制' }),
      }
    );
    assert.equal(result.ok, false);
    assert.deepEqual(result.error.code, 'PORTAL_ERROR');
    assert.equal(result.error.retcode, 850031);
    assert.equal(result.error.message, '超过限制');
  });

  it('guards the HTTP route by method and plugin header', async () => {
    const store = new BindTaskStore();
    const route = createOnboardRoute({ store, logger: { warn() {} } });

    const capture = () => {
      const res = {
        status: 0,
        headers: {},
        body: '',
        writeHead(status, headers) {
          this.status = status;
          this.headers = headers;
        },
        end(body) {
          this.body = body;
        },
      };
      return res;
    };

    const res1 = capture();
    await route({ method: 'GET', headers: {} }, res1);
    assert.equal(res1.status, 405);

    const res2 = capture();
    await route({ method: 'POST', headers: {} }, res2);
    assert.equal(res2.status, 403);

    const req = {
      method: 'POST',
      headers: { 'x-dsh-plugin': 'dsh-adapter-qq' },
      async *[Symbol.asyncIterator]() {
        yield JSON.stringify({ op: 'onboard-cancel', args: { taskId: 'x' } });
      },
    };
    const res3 = capture();
    await route(req, res3);
    assert.equal(res3.status, 200);
    assert.equal(JSON.parse(res3.body).ok, true);
  });
});
