import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { QQApiClient } from '../lib/qq/client.js';

const silentLogger = { info() {}, warn() {}, error() {}, debug() {} };

/** A client whose token is already cached, so no token fetch is expected. */
function configuredClient() {
  const client = new QQApiClient({
    appId: 'test_app',
    clientSecret: 'test_sec',
    logger: silentLogger,
  });
  client.accessToken = 'mock_token';
  client.tokenExpiresAt = Date.now() + 3600_000;
  return client;
}

function jsonResponse(body, status = 200) {
  const text = JSON.stringify(body ?? {});
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers({ 'content-type': 'application/json' }),
    json: async () => JSON.parse(text),
    text: async () => text,
  };
}

/** Install a fetch mock for one test and always restore the previous one. */
async function withFetch(mockFetch, run) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mockFetch;
  try {
    return await run();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

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

  it('should expose skills, MCP and render shortcuts in the default menu', () => {
    const client = new QQApiClient({ appId: '123', clientSecret: 'sec' });
    const menu = client.getDefaultMenu();

    const targets = menu.items
      .filter((item) => item.type === 'send_message')
      .map((item) => item.send_message);
    assert.ok(targets.includes('/skills'), 'top level menu must include /skills');
    assert.ok(targets.includes('/mcp'), 'top level menu must include /mcp');

    const shortcuts = menu.items.find((item) => item.type === 'menu');
    assert.ok(shortcuts, 'quick action sub menu must exist');
    const shortcutTargets = shortcuts.sub_menu_items.map((item) => item.send_message);
    assert.ok(shortcutTargets.includes('/render'), 'quick actions must include /render');
  });

  it('should fetch and cache access_token', async () => {
    const client = new QQApiClient({ appId: 'test_app', clientSecret: 'test_sec', logger: silentLogger });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, opts) => {
      if (url === 'https://bots.qq.com/app/getAppAccessToken') {
        const body = JSON.parse(opts.body);
        assert.equal(body.appId, 'test_app');
        assert.equal(body.clientSecret, 'test_sec');
        return jsonResponse({ access_token: 'mock_token_123', expires_in: 7200 });
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
    const client = configuredClient();
    let sentUrl = '';
    let sentBody = null;

    await withFetch(async (url, opts) => {
      if (url.includes('/v2/users/user_abc/messages')) {
        sentUrl = url;
        sentBody = JSON.parse(opts.body);
        return jsonResponse({ id: 'msg_999' });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }, async () => {
      const res = await client.sendC2CMessage('user_abc', {
        markdown: '# Hello World',
        msg_id: 'incoming_123',
      });

      assert.equal(res.id, 'msg_999');
      assert.equal(sentUrl, 'https://api.sgroup.qq.com/v2/users/user_abc/messages');
      assert.equal(sentBody.msg_type, 2);
      assert.equal(sentBody.markdown.content, '# Hello World');
      assert.equal(sentBody.msg_id, 'incoming_123');
      assert.ok(typeof sentBody.msg_seq === 'number');
    });
  });
});

describe('QQApiClient rich media', () => {
  it('uploads small media directly as base64 file_data', async () => {
    const client = configuredClient();
    const data = Buffer.from('a small file payload');
    let uploadBody = null;

    await withFetch(async (url, opts = {}) => {
      assert.equal(String(url), 'https://api.sgroup.qq.com/v2/users/user_direct/files');
      assert.equal(opts.method, 'POST');
      assert.equal(opts.headers.Authorization, 'QQBot mock_token');
      uploadBody = JSON.parse(opts.body);
      return jsonResponse({ file_uuid: 'uuid_direct', file_info: 'FILE_DIRECT', ttl: 300 });
    }, async () => {
      const result = await client.uploadUserMedia('user_direct', {
        fileType: 4,
        data,
        filename: 'report.pdf',
      });

      assert.deepEqual(result, {
        fileInfo: 'FILE_DIRECT',
        fileUuid: 'uuid_direct',
        ttl: 300,
      });
    });

    assert.equal(uploadBody.file_type, 4);
    assert.equal(uploadBody.file_name, 'report.pdf');
    assert.equal(uploadBody.file_data, data.toString('base64'));
    assert.equal(uploadBody.srv_send_msg, false);
    assert.equal(uploadBody.upload_id, undefined);
  });

  it('uses the chunked flow above 5MB (prepare -> bare PUT -> part_finish -> merge)', async () => {
    const client = configuredClient();
    const partSize = 5 * 1024 * 1024;
    const data = Buffer.alloc(partSize + 100, 0x61);
    const uploadId = 'upload_chunk_1';
    const order = [];
    const finishBodies = [];

    const expected = {
      md5: createHash('md5').update(data).digest('hex'),
      sha1: createHash('sha1').update(data).digest('hex'),
      md5_10m: createHash('md5').update(data.subarray(0, 10002432)).digest('hex'),
    };

    await withFetch(async (url, opts = {}) => {
      const target = String(url);

      if (target.endsWith('/v2/users/user_chunk/upload_prepare')) {
        order.push('prepare');
        assert.equal(opts.method, 'POST');
        assert.equal(opts.headers.Authorization, 'QQBot mock_token');

        const body = JSON.parse(opts.body);
        assert.equal(body.file_type, 4);
        assert.equal(body.file_name, 'big.bin');
        assert.equal(body.file_size, String(data.length));
        assert.equal(typeof body.file_size, 'string');
        assert.equal(body.md5, expected.md5);
        assert.equal(body.sha1, expected.sha1);
        assert.equal(body.md5_10m, expected.md5_10m);
        assert.equal(body.srv_send_msg, undefined);

        return jsonResponse({
          upload_id: uploadId,
          block_size: String(partSize),
          parts: [
            {
              index: 0,
              presigned_url: 'https://cos.example/part?n=0',
              block_size: String(partSize),
            },
            {
              index: 1,
              presigned_url: 'https://cos.example/part?n=1',
              block_size: '100',
            },
          ],
          upload_config: { concurrency: 1, retry_timeout: 300, retry_delay: 1 },
        });
      }

      if (target.startsWith('https://cos.example/part?n=')) {
        const partIndex = target.endsWith('n=0') ? 0 : 1;
        order.push(`put${partIndex}`);
        assert.equal(opts.method, 'PUT');
        // Presigned URLs must be called bare: no QQ auth headers may leak in.
        assert.equal(opts.headers, undefined);
        assert.ok(Buffer.isBuffer(opts.body));
        assert.equal(opts.body.length, partIndex === 0 ? partSize : 100);
        return { ok: true, status: 200, headers: new Headers(), text: async () => '' };
      }

      if (target.endsWith('/v2/users/user_chunk/upload_part_finish')) {
        const body = JSON.parse(opts.body);
        order.push(`finish${body.part_index}`);
        finishBodies.push(body);
        assert.equal(body.upload_id, uploadId);
        assert.equal(typeof body.part_index, 'number');
        assert.equal(typeof body.block_size, 'string');
        return jsonResponse({});
      }

      if (target.endsWith('/v2/users/user_chunk/files')) {
        order.push('merge');
        const body = JSON.parse(opts.body);
        assert.equal(body.upload_id, uploadId);
        assert.equal(body.file_type, 4);
        assert.equal(body.file_name, 'big.bin');
        assert.equal(body.srv_send_msg, false);
        assert.equal(body.file_data, undefined);
        return jsonResponse({ file_uuid: 'uuid_chunk', file_info: 'FILE_CHUNK', ttl: 600 });
      }

      throw new Error(`Unexpected fetch: ${opts.method || 'GET'} ${target}`);
    }, async () => {
      const result = await client.uploadUserMedia('user_chunk', {
        fileType: 4,
        data,
        filename: 'big.bin',
      });
      assert.deepEqual(result, {
        fileInfo: 'FILE_CHUNK',
        fileUuid: 'uuid_chunk',
        ttl: 600,
      });
    });

    assert.deepEqual(order, ['prepare', 'put0', 'finish0', 'put1', 'finish1', 'merge']);
    assert.equal(finishBodies.length, 2);
    assert.equal(finishBodies[0].part_index, 0);
    assert.equal(finishBodies[0].block_size, String(partSize));
    assert.equal(
      finishBodies[0].md5,
      createHash('md5').update(data.subarray(0, partSize)).digest('hex'),
    );
    assert.equal(finishBodies[1].part_index, 1);
    assert.equal(finishBodies[1].block_size, '100');
    assert.equal(
      finishBodies[1].md5,
      createHash('md5').update(data.subarray(partSize)).digest('hex'),
    );
  });

  it('sends rich media as msg_type=7 with media.file_info', async () => {
    const client = configuredClient();
    let sentBody = null;

    await withFetch(async (url, opts = {}) => {
      assert.equal(String(url), 'https://api.sgroup.qq.com/v2/users/user_media/messages');
      sentBody = JSON.parse(opts.body);
      return jsonResponse({ id: 'msg_media_1' });
    }, async () => {
      const res = await client.sendUserMedia('user_media', {
        fileInfo: 'FILE_INFO_1',
        msgId: 'incoming_1',
        msgSeq: 42,
      });
      assert.deepEqual(res, { id: 'msg_media_1' });
    });

    assert.equal(sentBody.msg_type, 7);
    assert.deepEqual(sentBody.media, { file_info: 'FILE_INFO_1' });
    assert.equal(sentBody.msg_id, 'incoming_1');
    assert.equal(sentBody.msg_seq, 42);
    assert.equal(sentBody.content, undefined);
  });

  it('infers msg_type=7 from sendC2CMessage({ media }) and passes objects through', async () => {
    const client = configuredClient();
    const bodies = [];

    await withFetch(async (url, opts = {}) => {
      bodies.push(JSON.parse(opts.body));
      return jsonResponse({ id: `msg_${bodies.length}` });
    }, async () => {
      await client.sendC2CMessage('user_c2c_media', { media: 'FILE_INFO_STR', msg_id: 'm1' });
      await client.sendC2CMessage('user_c2c_media', {
        media: { file_info: 'FILE_INFO_OBJ' },
        msg_seq: 7,
      });
    });

    assert.equal(bodies[0].msg_type, 7);
    assert.deepEqual(bodies[0].media, { file_info: 'FILE_INFO_STR' });
    assert.equal(bodies[0].msg_id, 'm1');

    assert.equal(bodies[1].msg_type, 7);
    assert.deepEqual(bodies[1].media, { file_info: 'FILE_INFO_OBJ' });
    assert.equal(bodies[1].msg_seq, 7);
  });

  it('respects an explicit msg_type over media and markdown', async () => {
    const client = configuredClient();
    let sentBody = null;

    await withFetch(async (url, opts = {}) => {
      sentBody = JSON.parse(opts.body);
      return jsonResponse({ id: 'msg_text_1' });
    }, async () => {
      await client.sendC2CMessage('user_explicit', {
        msg_type: 0,
        content: 'hello',
        media: 'IGNORED',
        markdown: '# ignored',
      });
    });

    assert.equal(sentBody.msg_type, 0);
    assert.equal(sentBody.content, 'hello');
    assert.equal(sentBody.media, undefined);
    assert.equal(sentBody.markdown, undefined);
  });

  it('rejects msg_type=7 without media', async () => {
    const client = configuredClient();
    await assert.rejects(
      client.sendC2CMessage('user_missing_media', { msg_type: 7 }),
      /media is required/i,
    );
  });

  it('falls back to file_type=4 when QQ rejects the image format with 850019', async () => {
    const client = configuredClient();
    // Filename says .txt, but the bytes are a PNG: bytes must win.
    const pngBytes = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
    ]);
    const uploadBodies = [];
    let sentBody = null;

    await withFetch(async (url, opts = {}) => {
      const target = String(url);

      if (target.endsWith('/v2/users/user_img/files')) {
        const body = JSON.parse(opts.body);
        uploadBodies.push(body);
        if (uploadBodies.length === 1) {
          return jsonResponse({ code: 850019, message: '不支持的文件格式' }, 400);
        }
        return jsonResponse({ file_uuid: 'uuid_as_file', file_info: 'FILE_AS_FILE', ttl: 0 });
      }

      if (target.endsWith('/v2/users/user_img/messages')) {
        sentBody = JSON.parse(opts.body);
        return jsonResponse({ id: 'msg_img_1' });
      }

      throw new Error(`Unexpected fetch: ${opts.method || 'GET'} ${target}`);
    }, async () => {
      const result = await client.sendImage('user_img', {
        data: pngBytes,
        filename: 'photo.txt',
        msgId: 'incoming_img',
      });

      assert.deepEqual(result, {
        fileInfo: 'FILE_AS_FILE',
        fileUuid: 'uuid_as_file',
        messageId: 'msg_img_1',
      });
    });

    assert.equal(uploadBodies.length, 2);
    assert.equal(uploadBodies[0].file_type, 1);
    assert.equal(uploadBodies[0].file_name, 'photo.txt');
    assert.equal(uploadBodies[1].file_type, 4);
    assert.equal(sentBody.msg_type, 7);
    assert.deepEqual(sentBody.media, { file_info: 'FILE_AS_FILE' });
    assert.equal(sentBody.msg_id, 'incoming_img');
  });

  it('sends a plain file with an extension-derived file_type', async () => {
    const client = configuredClient();
    const bodies = [];

    await withFetch(async (url, opts = {}) => {
      const target = String(url);
      if (target.endsWith('/v2/users/user_file/files')) {
        const body = JSON.parse(opts.body);
        bodies.push({ kind: 'upload', body });
        return jsonResponse({ file_uuid: 'uuid_zip', file_info: 'FILE_ZIP', ttl: 0 });
      }
      if (target.endsWith('/v2/users/user_file/messages')) {
        const body = JSON.parse(opts.body);
        bodies.push({ kind: 'send', body });
        return jsonResponse({ id: 'msg_zip_1' });
      }
      throw new Error(`Unexpected fetch: ${opts.method || 'GET'} ${target}`);
    }, async () => {
      const result = await client.sendFile('user_file', {
        data: Buffer.from('PK\u0003\u0004 not really a zip'),
        filename: 'archive.zip',
        msgId: 'incoming_file',
      });

      assert.deepEqual(result, {
        fileInfo: 'FILE_ZIP',
        fileUuid: 'uuid_zip',
        messageId: 'msg_zip_1',
      });
    });

    assert.equal(bodies[0].body.file_type, 4);
    assert.equal(bodies[0].body.file_name, 'archive.zip');
    assert.equal(bodies[0].body.srv_send_msg, false);
    assert.equal(bodies[1].body.msg_type, 7);
    assert.deepEqual(bodies[1].body.media, { file_info: 'FILE_ZIP' });
    assert.equal(bodies[1].body.msg_id, 'incoming_file');
  });

  it('requires fileInfo when sending media', async () => {
    const client = configuredClient();
    await assert.rejects(client.sendUserMedia('user_no_media', {}), /fileInfo is required/i);
  });
});

describe('QQApiClient send fallbacks', () => {
  it('refreshes the token and retries once on 401', async () => {
    const client = configuredClient();
    let tokenCalls = 0;
    const authHeaders = [];

    await withFetch(async (url, opts = {}) => {
      const target = String(url);

      if (target === 'https://bots.qq.com/app/getAppAccessToken') {
        tokenCalls += 1;
        return jsonResponse({ access_token: 'fresh_token', expires_in: 7200 });
      }

      if (target.endsWith('/v2/users/user_401/messages')) {
        authHeaders.push(opts.headers.Authorization);
        if (authHeaders.length === 1) {
          return jsonResponse({ code: 11244, message: 'token invalid' }, 401);
        }
        return jsonResponse({ id: 'msg_after_refresh' });
      }

      throw new Error(`Unexpected fetch: ${opts.method || 'GET'} ${target}`);
    }, async () => {
      const res = await client.sendC2CMessage('user_401', { content: 'hi' });
      assert.deepEqual(res, { id: 'msg_after_refresh' });
    });

    assert.equal(tokenCalls, 1);
    assert.equal(authHeaders.length, 2);
    assert.equal(authHeaders[0], 'QQBot mock_token');
    assert.equal(authHeaders[1], 'QQBot fresh_token');
  });

  it('retries once without msg_id when the passive reply is rejected', async () => {
    const client = configuredClient();
    const bodies = [];

    await withFetch(async (url, opts = {}) => {
      const body = JSON.parse(opts.body);
      bodies.push(body);
      if (bodies.length === 1) {
        return jsonResponse({ code: 40054005, message: 'invalid msg_id' }, 400);
      }
      return jsonResponse({ id: 'msg_active' });
    }, async () => {
      const res = await client.sendC2CMessage('user_retry', {
        content: 'hello',
        msg_id: 'expired_msg_id',
      });
      assert.deepEqual(res, { id: 'msg_active' });
    });

    assert.equal(bodies.length, 2);
    assert.equal(bodies[0].msg_id, 'expired_msg_id');
    assert.equal(Object.hasOwn(bodies[1], 'msg_id'), false);
    assert.equal(bodies[1].content, 'hello');
  });

  it('falls back to plain text when a markdown message is rejected with 400', async () => {
    const client = configuredClient();
    const bodies = [];

    await withFetch(async (url, opts = {}) => {
      const body = JSON.parse(opts.body);
      bodies.push(body);
      if (bodies.length === 1) {
        return jsonResponse({ code: 40004, message: 'markdown not allowed' }, 400);
      }
      return jsonResponse({ id: 'msg_text_fallback' });
    }, async () => {
      const res = await client.sendC2CMessage('user_md', {
        markdown: '# Title\n\nbody',
        keyboard: { content: { rows: [] } },
      });
      assert.deepEqual(res, { id: 'msg_text_fallback' });
    });

    assert.equal(bodies.length, 2);
    assert.equal(bodies[0].msg_type, 2);
    assert.equal(bodies[0].markdown.content, '# Title\n\nbody');
    assert.equal(bodies[1].msg_type, 0);
    assert.equal(bodies[1].content, '# Title\n\nbody');
    assert.deepEqual(bodies[1].keyboard, { content: { rows: [] } });
  });
});
