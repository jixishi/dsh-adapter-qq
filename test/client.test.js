import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { QQApiClient } from '../lib/qq/client.js';

describe('QQApiClient', () => {
  it('should initialize with provided credentials', () => {
    const client = new QQApiClient({
      appId: '10203040',
      clientSecret: 'my_secret_key',
      sandbox: true,
    });

    assert.equal(client.appId, '10203040');
    assert.equal(client.clientSecret, 'my_secret_key');
    assert.equal(client.sandbox, true);
    assert.equal(client.baseUrl, 'https://sandbox.api.sgroup.qq.com');
    assert.equal(client.isConfigured(), true);
  });

  it('should report isConfigured false when credentials missing', () => {
    const client = new QQApiClient({ appId: '', clientSecret: '' });
    assert.equal(client.isConfigured(), false);
  });

  it('should update configuration and invalidate cached token', () => {
    const client = new QQApiClient({ appId: 'old', clientSecret: 'old_sec' });
    client.accessToken = 'cached_token';
    client.tokenExpiresAt = Date.now() + 100000;

    client.updateConfig({ appId: 'new_id', clientSecret: 'new_sec', sandbox: false });
    assert.equal(client.appId, 'new_id');
    assert.equal(client.clientSecret, 'new_sec');
    assert.equal(client.accessToken, null);
    assert.equal(client.baseUrl, 'https://api.sgroup.qq.com');
  });

  it('should increment msg_seq monotonically', () => {
    const client = new QQApiClient({ appId: '123', clientSecret: 'sec' });
    const seq1 = client.getNextMsgSeq();
    const seq2 = client.getNextMsgSeq();
    assert.equal(seq2, seq1 + 1);
  });

  it('should build valid default custom menu conforming to QQ specifications', () => {
    const client = new QQApiClient({ appId: '123', clientSecret: 'sec' });
    const menu = client.getDefaultMenu();

    assert.ok(Array.isArray(menu.items));
    assert.ok(menu.items.length <= 10, 'Top level menu items must be <= 10');

    for (const item of menu.items) {
      assert.ok(item.name.length <= 10, `Item name "${item.name}" exceeds 10 characters`);
      if (item.type === 'menu') {
        assert.ok(Array.isArray(item.sub_menu_items));
        assert.ok(item.sub_menu_items.length <= 5, 'Sub menu items must be <= 5');
        for (const sub of item.sub_menu_items) {
          assert.ok(sub.name.length <= 14, `Sub item name "${sub.name}" exceeds 14 characters`);
        }
      }
    }
  });

  it('should fetch and cache access_token', async () => {
    const client = new QQApiClient({ appId: 'test_app', clientSecret: 'test_sec' });

    // Mock global fetch
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, opts) => {
      if (url === 'https://bots.qq.com/app/getAppAccessToken') {
        const body = JSON.parse(opts.body);
        assert.equal(body.appId, 'test_app');
        assert.equal(body.clientSecret, 'test_sec');
        return {
          ok: true,
          status: 200,
          headers: new Headers({ 'content-type': 'application/json' }),
          json: async () => ({ access_token: 'mock_token_123', expires_in: 7200 }),
        };
      }
      return originalFetch(url, opts);
    };

    try {
      const token = await client.getAccessToken();
      assert.equal(token, 'mock_token_123');
      assert.equal(client.accessToken, 'mock_token_123');

      // Subsequent call should use cache without fetching again
      const cached = await client.getAccessToken();
      assert.equal(cached, 'mock_token_123');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('should send C2C message with proper payload formatting', async () => {
    const client = new QQApiClient({ appId: 'test_app', clientSecret: 'test_sec' });
    client.accessToken = 'mock_token';
    client.tokenExpiresAt = Date.now() + 100000;

    const originalFetch = globalThis.fetch;
    let sentUrl = '';
    let sentBody = null;

    globalThis.fetch = async (url, opts) => {
      if (url.includes('/v2/users/user_abc/messages')) {
        sentUrl = url;
        sentBody = JSON.parse(opts.body);
        return {
          ok: true,
          status: 200,
          headers: new Headers({ 'content-type': 'application/json' }),
          json: async () => ({ id: 'msg_999' }),
        };
      }
      return originalFetch(url, opts);
    };

    try {
      const res = await client.sendC2CMessage('user_abc', {
        markdown: '# Hello World',
        msg_id: 'incoming_123',
      });

      assert.equal(res.id, 'msg_999');
      assert.equal(sentBody.msg_type, 2);
      assert.equal(sentBody.markdown.content, '# Hello World');
      assert.equal(sentBody.msg_id, 'incoming_123');
      assert.ok(typeof sentBody.msg_seq === 'number');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
