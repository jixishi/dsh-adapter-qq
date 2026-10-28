import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSendFileTool } from '../lib/tools/qq-send-file.js';

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);
const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
const silentLogger = { info() {}, warn() {}, debug() {}, error() {} };

let workspace;

before(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'qq-send-file-'));
  await writeFile(join(workspace, 'note.txt'), 'hello world');
  await writeFile(join(workspace, 'picture.bin'), PNG_MAGIC);
  await writeFile(join(workspace, 'photo.jpg'), JPEG_MAGIC);
  await writeFile(join(workspace, 'renamed.png'), 'not really a png');
  await writeFile(join(workspace, 'empty.txt'), '');
  await mkdir(join(workspace, 'folder'));
});

after(async () => {
  if (workspace) await rm(workspace, { recursive: true, force: true });
});

/**
 * Build a tool wired to recording senders.
 * @param {Object} [overrides]
 */
function makeHarness(overrides = {}) {
  const calls = { image: [], file: [] };
  const config = { userOpenid: 'user-1', ...(overrides.config || {}) };
  const sendImage =
    overrides.sendImage ||
    (async (...args) => {
      calls.image.push(args);
      return { messageId: 'img-msg-1' };
    });
  const sendFile =
    overrides.sendFile ||
    (async (...args) => {
      calls.file.push(args);
      return { messageId: 'file-msg-1' };
    });
  const tool = createSendFileTool({
    sendImage,
    sendFile,
    getConfig: () => config,
    logger: silentLogger,
  });
  return { tool, calls, config };
}

describe('createSendFileTool definition', () => {
  it('exposes the qq_send_file contract', () => {
    const { tool } = makeHarness();

    assert.equal(tool.name, 'qq_send_file');
    assert.equal(typeof tool.description, 'string');
    assert.match(tool.description, /path/);
    assert.equal(tool.parameters.type, 'object');
    assert.deepEqual(Object.keys(tool.parameters.properties).sort(), [
      'as_image',
      'data_base64',
      'filename',
      'msg_id',
      'path',
    ]);
    assert.equal(tool.output.schema.type, 'object');
    assert.equal(tool.output.schema.properties.kind.enum.join(','), 'image,file');
    assert.equal(typeof tool.output.render, 'function');
    assert.equal(typeof tool.execute, 'function');
  });

  it('requires both sender functions', () => {
    assert.throws(() => createSendFileTool({ sendImage: async () => ({}) }), TypeError);
    assert.throws(() => createSendFileTool({ sendFile: async () => ({}) }), TypeError);
  });
});

describe('qq_send_file execution', () => {
  it('sends a plain file through sendFile with the real bytes', async () => {
    const { tool, calls } = makeHarness();

    const result = await tool.execute({ path: join(workspace, 'note.txt') });

    assert.equal(calls.file.length, 1);
    assert.equal(calls.image.length, 0);
    const [openid, payload] = calls.file[0];
    assert.equal(openid, 'user-1');
    assert.ok(Buffer.isBuffer(payload.data));
    assert.equal(payload.data.toString('utf8'), 'hello world');
    assert.equal(payload.filename, 'note.txt');
    assert.equal(payload.msgId, undefined);

    assert.equal(result.ok, true);
    assert.equal(result.kind, 'file');
    assert.equal(result.bytes, 11);
    assert.equal(result.filename, 'note.txt');
    assert.equal(result.path, join(workspace, 'note.txt'));
    assert.equal(result.messageId, 'file-msg-1');
  });

  it('sniffs image bytes and routes through sendImage even with a non-image name', async () => {
    const { tool, calls } = makeHarness();

    const result = await tool.execute({ path: join(workspace, 'picture.bin') });

    assert.equal(calls.image.length, 1);
    assert.equal(calls.file.length, 0);
    const payload = calls.image[0][1];
    assert.equal(payload.filename, 'picture.bin');
    assert.deepEqual([...payload.data], [...PNG_MAGIC]);
    assert.equal(result.ok, true);
    assert.equal(result.kind, 'image');
    assert.equal(result.messageId, 'img-msg-1');
  });

  it('trusts a jpeg signature sniffed from the bytes', async () => {
    const { tool, calls } = makeHarness();

    const result = await tool.execute({ path: join(workspace, 'photo.jpg') });

    assert.equal(result.kind, 'image');
    assert.equal(calls.image[0][1].filename, 'photo.jpg');
  });

  it('uses the media helper extension fallback for image names', async () => {
    const { tool, calls } = makeHarness();

    const result = await tool.execute({ path: join(workspace, 'renamed.png') });

    assert.equal(result.kind, 'image');
    assert.equal(calls.image.length, 1);
  });

  it('honours as_image for base64 payloads', async () => {
    const { tool, calls } = makeHarness();

    const result = await tool.execute({
      data_base64: Buffer.from('plain text').toString('base64'),
      filename: 'plot.png',
      as_image: true,
    });

    assert.equal(result.ok, true);
    assert.equal(result.kind, 'image');
    assert.equal(result.path, undefined);
    assert.equal(calls.image.length, 1);
    const payload = calls.image[0][1];
    assert.equal(payload.filename, 'plot.png');
    assert.equal(payload.data.toString('utf8'), 'plain text');
  });

  it('decodes a data URL base64 payload and falls back to a default filename', async () => {
    const { tool, calls } = makeHarness();

    const result = await tool.execute({ data_base64: `data:text/plain;base64,${Buffer.from('hello').toString('base64')}` });

    assert.equal(result.ok, true);
    assert.equal(result.kind, 'file');
    assert.equal(result.filename, 'file');
    assert.equal(result.bytes, 5);
    assert.equal(calls.file[0][1].data.toString('utf8'), 'hello');
  });

  it('passes msg_id through as msgId', async () => {
    const { tool, calls } = makeHarness();

    await tool.execute({ path: join(workspace, 'note.txt'), msg_id: 'msg-42' });

    assert.equal(calls.file[0][1].msgId, 'msg-42');
  });

  it('resolves a relative path against the execution working directory', async () => {
    const { tool, calls } = makeHarness();

    const result = await tool.execute({ path: 'note.txt' }, { cwd: workspace });

    assert.equal(result.ok, true);
    assert.equal(result.path, join(workspace, 'note.txt'));
    assert.equal(calls.file[0][1].data.toString('utf8'), 'hello world');
  });

  it('resolves a relative path against the DSH session working directory', async () => {
    const { tool, calls } = makeHarness();

    const result = await tool.execute(
      { path: 'note.txt' },
      { agent: { session: { header: { cwd: workspace } } } },
    );

    assert.equal(result.ok, true);
    assert.equal(result.path, join(workspace, 'note.txt'));
    assert.equal(calls.file[0][1].data.toString('utf8'), 'hello world');
  });

  it('returns ok:false when no QQ user is bound and never calls a sender', async () => {
    const { tool, calls } = makeHarness({ config: { userOpenid: '' } });

    const result = await tool.execute({ path: join(workspace, 'note.txt') });

    assert.deepEqual(result, { ok: false, error: '尚未绑定 QQ 用户' });
    assert.equal(calls.file.length, 0);
    assert.equal(calls.image.length, 0);
  });

  it('returns ok:false when neither path nor data_base64 is provided', async () => {
    const { tool } = makeHarness();

    const result = await tool.execute({});

    assert.equal(result.ok, false);
    assert.match(result.error, /path 或 data_base64/);
  });

  it('rejects a directory path without throwing', async () => {
    const { tool, calls } = makeHarness();

    const result = await tool.execute({ path: join(workspace, 'folder') });

    assert.equal(result.ok, false);
    assert.match(result.error, /不是普通文件/);
    assert.equal(calls.file.length, 0);
  });

  it('reports unreadable files without throwing', async () => {
    const { tool } = makeHarness();

    const result = await tool.execute({ path: join(workspace, 'missing.txt') });

    assert.equal(result.ok, false);
    assert.match(result.error, /无法读取文件/);
  });

  it('rejects an empty file without calling a sender', async () => {
    const { tool, calls } = makeHarness();

    const result = await tool.execute({ path: join(workspace, 'empty.txt') });

    assert.equal(result.ok, false);
    assert.match(result.error, /文件内容为空/);
    assert.equal(calls.file.length, 0);
  });

  it('rejects an empty base64 payload', async () => {
    const { tool } = makeHarness();

    const result = await tool.execute({ data_base64: '   ' });

    assert.equal(result.ok, false);
    assert.match(result.error, /path 或 data_base64/);
  });

  it('returns ok:false and keeps the kind when the sender rejects', async () => {
    const { tool } = makeHarness({
      sendImage: async () => {
        throw new Error('QQ API error [500]: invalid file');
      },
    });

    const result = await tool.execute({ path: join(workspace, 'picture.bin') });

    assert.equal(result.ok, false);
    assert.equal(result.kind, 'image');
    assert.equal(result.bytes, PNG_MAGIC.length);
    assert.match(result.error, /invalid file/);
  });

  it('renders a Chinese summary for success and failure', () => {
    const { tool } = makeHarness();

    const success = tool.output.render({}, {
      ok: true,
      kind: 'image',
      filename: 'plot.png',
      bytes: 2048,
      path: 'C:/tmp/plot.png',
      messageId: 'm-1',
    });
    assert.equal(success.length, 1);
    assert.equal(success[0].type, 'text');
    assert.match(success[0].text, /已发送图片/);
    assert.match(success[0].text, /2\.0 KB/);
    assert.match(success[0].text, /消息 ID：m-1/);

    const failure = tool.output.render({}, { ok: false, error: '尚未绑定 QQ 用户' });
    assert.equal(failure[0].type, 'text');
    assert.match(failure[0].text, /发送失败/);
    assert.match(failure[0].text, /尚未绑定 QQ 用户/);
  });

  it('never throws from output.render on replay with odd values', () => {
    const { tool } = makeHarness();

    assert.doesNotThrow(() => tool.output.render({}, null));
    assert.doesNotThrow(() => tool.output.render({}, { ok: true }));
    const blocks = tool.output.render({}, { ok: true });
    assert.equal(blocks[0].type, 'text');
  });
});
