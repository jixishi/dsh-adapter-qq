import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createRenderTextImageTool } from '../lib/tools/qq-render-text-image.js';

const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

async function makeTempDir() {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-tool-render-'));
}

async function makeFakeRenderer(dir, overrides = {}) {
  const outPath = path.join(dir, 'render-fake.png');
  const calls = [];
  const renderTextImage = async (options) => {
    calls.push(options);
    await fsp.writeFile(outPath, TINY_PNG);
    return {
      path: outPath,
      bytes: TINY_PNG.length,
      width: 900,
      height: 600,
      mediaType: 'image/png',
      engine: 'browser',
      ...overrides,
    };
  };
  return { renderTextImage, calls, outPath };
}

function makeSendImage({ messageId = 'msg-1', failure = null } = {}) {
  const calls = [];
  const sendImage = async (openid, payload) => {
    calls.push({ openid, payload });
    if (failure) throw failure;
    return { messageId };
  };
  return { sendImage, calls };
}

describe('createRenderTextImageTool definition', () => {
  it('exposes the contract name, Chinese description and schemas', () => {
    const tool = createRenderTextImageTool({ renderTextImage: async () => ({}) });

    assert.equal(tool.name, 'qq_render_text_image');
    assert.equal(typeof tool.description, 'string');
    assert.ok(tool.description.includes('图片'));
    assert.ok(tool.description.includes('Markdown'));
    assert.ok(tool.description.includes('QQ'));

    assert.equal(tool.parameters.type, 'object');
    assert.deepEqual(tool.parameters.required, ['text']);
    assert.equal(tool.parameters.additionalProperties, false);
    assert.equal(tool.parameters.properties.text.type, 'string');
    assert.equal(tool.parameters.properties.title.type, 'string');
    assert.deepEqual(tool.parameters.properties.theme.enum, ['light', 'dark']);
    assert.equal(tool.parameters.properties.width.type, 'integer');
    assert.equal(tool.parameters.properties.send.type, 'boolean');
    assert.equal(tool.parameters.properties.filename.type, 'string');

    const schema = tool.output.schema;
    assert.equal(schema.type, 'object');
    for (const key of ['path', 'bytes', 'width', 'height', 'mediaType', 'engine', 'delivered']) {
      assert.ok(schema.properties[key], `output.schema 缺少 ${key}`);
    }
    assert.deepEqual(
      [...schema.required].sort(),
      ['bytes', 'delivered', 'engine', 'height', 'mediaType', 'path', 'width'].sort(),
    );
    assert.equal(typeof tool.output.render, 'function');
    assert.equal(typeof tool.execute, 'function');
  });

  it('rejects construction without renderTextImage', () => {
    assert.throws(() => createRenderTextImageTool({}), /renderTextImage/);
  });
});

describe('qq_render_text_image execute', () => {
  it('renders and sends to the bound QQ user by default', async () => {
    const dir = await makeTempDir();
    try {
      const fake = await makeFakeRenderer(dir);
      const sender = makeSendImage({ messageId: 'msg-42' });
      const tool = createRenderTextImageTool({
        renderTextImage: fake.renderTextImage,
        sendImage: sender.sendImage,
        getConfig: () => ({ userOpenid: 'openid-1' }),
        logger: { warn() {} },
      });

      const result = await tool.execute({ text: '# 你好', title: '标题', theme: 'dark', width: 5000 });

      assert.equal(fake.calls.length, 1);
      assert.equal(fake.calls[0].text, '# 你好');
      assert.equal(fake.calls[0].title, '标题');
      assert.equal(fake.calls[0].theme, 'dark');
      assert.equal(fake.calls[0].width, 1600, '宽度应夹取到 1600');

      assert.equal(sender.calls.length, 1);
      assert.equal(sender.calls[0].openid, 'openid-1');
      assert.equal(sender.calls[0].payload.filename, 'render-fake.png');
      assert.ok(Buffer.isBuffer(sender.calls[0].payload.data));
      assert.deepEqual(sender.calls[0].payload.data, TINY_PNG);

      assert.equal(result.path, fake.outPath);
      assert.equal(result.bytes, TINY_PNG.length);
      assert.equal(result.width, 900);
      assert.equal(result.height, 600);
      assert.equal(result.mediaType, 'image/png');
      assert.equal(result.engine, 'browser');
      assert.equal(result.delivered, true);
      assert.equal(result.messageId, 'msg-42');
      assert.equal(result.deliveredError, undefined);
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  it('does not send when send=false and clamps small widths', async () => {
    const dir = await makeTempDir();
    try {
      const fake = await makeFakeRenderer(dir);
      const sender = makeSendImage();
      const tool = createRenderTextImageTool({
        renderTextImage: fake.renderTextImage,
        sendImage: sender.sendImage,
        getConfig: () => ({ userOpenid: 'openid-1' }),
        logger: { warn() {} },
      });

      const result = await tool.execute({ text: '仅本地', send: false, width: 100 });
      assert.equal(fake.calls[0].width, 480, '宽度应夹取到 480');
      assert.equal(fake.calls[0].theme, 'light');
      assert.equal(sender.calls.length, 0);
      assert.equal(result.delivered, false);
      assert.equal(result.deliveredError, undefined);
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  it('reports delivery failure without throwing', async () => {
    const dir = await makeTempDir();
    try {
      const fake = await makeFakeRenderer(dir);
      const sender = makeSendImage({ failure: new Error('QQ 上传失败') });
      const tool = createRenderTextImageTool({
        renderTextImage: fake.renderTextImage,
        sendImage: sender.sendImage,
        getConfig: () => ({ userOpenid: 'openid-1' }),
        logger: { warn() {} },
      });

      const result = await tool.execute({ text: '内容' });
      assert.equal(result.delivered, false);
      assert.equal(result.deliveredError, 'QQ 上传失败');
      assert.equal(result.path, fake.outPath);
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  it('skips sending when no QQ user is bound', async () => {
    const dir = await makeTempDir();
    try {
      const fake = await makeFakeRenderer(dir);
      const sender = makeSendImage();
      const tool = createRenderTextImageTool({
        renderTextImage: fake.renderTextImage,
        sendImage: sender.sendImage,
        getConfig: () => ({ userOpenid: '  ' }),
        logger: { warn() {} },
      });

      const result = await tool.execute({ text: '内容' });
      assert.equal(sender.calls.length, 0);
      assert.equal(result.delivered, false);
      assert.equal(result.deliveredError, '尚未绑定 QQ 用户');
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  it('survives a throwing getConfig', async () => {
    const dir = await makeTempDir();
    try {
      const fake = await makeFakeRenderer(dir);
      const sender = makeSendImage();
      const tool = createRenderTextImageTool({
        renderTextImage: fake.renderTextImage,
        sendImage: sender.sendImage,
        getConfig: () => {
          throw new Error('config broken');
        },
        logger: { warn() {} },
      });

      const result = await tool.execute({ text: '内容' });
      assert.equal(result.delivered, false);
      assert.equal(result.deliveredError, '尚未绑定 QQ 用户');
      assert.equal(result.path, fake.outPath);
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  it('uses the configured renderWidth as the default width', async () => {
    const dir = await makeTempDir();
    try {
      const fake = await makeFakeRenderer(dir);
      const tool = createRenderTextImageTool({
        renderTextImage: fake.renderTextImage,
        sendImage: makeSendImage().sendImage,
        getConfig: () => ({ userOpenid: '', renderWidth: 1000 }),
        logger: { warn() {} },
      });

      await tool.execute({ text: '内容', send: false });
      assert.equal(fake.calls[0].width, 1000);
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  it('uses the configured renderTheme unless the call overrides it', async () => {
    const dir = await makeTempDir();
    try {
      const fake = await makeFakeRenderer(dir);
      const tool = createRenderTextImageTool({
        renderTextImage: fake.renderTextImage,
        sendImage: makeSendImage().sendImage,
        getConfig: () => ({ userOpenid: '', renderWidth: 900, renderTheme: 'dark' }),
        logger: { warn() {} },
      });

      await tool.execute({ text: '内容', send: false });
      assert.equal(fake.calls[0].theme, 'dark');

      await tool.execute({ text: '内容', send: false, theme: 'light' });
      assert.equal(fake.calls[1].theme, 'light');
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  it('rejects empty and oversized text', async () => {
    const tool = createRenderTextImageTool({ renderTextImage: async () => ({}) });
    await assert.rejects(() => tool.execute({ text: '   ' }), /text 不能为空/);
    await assert.rejects(() => tool.execute({ text: 'x'.repeat(20001) }), /text 过长/);
  });
});

describe('qq_render_text_image output.render', () => {
  const baseValue = {
    path: 'C:\\tmp\\render-1-abc.png',
    bytes: 2048,
    width: 900,
    height: 640,
    mediaType: 'image/png',
    engine: 'browser',
    delivered: false,
  };

  it('summarizes a delivered image in Chinese', () => {
    const tool = createRenderTextImageTool({ renderTextImage: async () => ({}) });
    const blocks = tool.output.render({}, { ...baseValue, delivered: true, messageId: 'm-9' });
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].type, 'text');
    const text = blocks[0].text;
    assert.ok(text.includes(baseValue.path));
    assert.ok(text.includes('900×640'));
    assert.ok(text.includes('2.0 KB'));
    assert.ok(text.includes('已发送到 QQ'));
    assert.ok(text.includes('m-9'));
  });

  it('mentions the delivery error when sending failed', () => {
    const tool = createRenderTextImageTool({ renderTextImage: async () => ({}) });
    const text = tool.output.render({}, { ...baseValue, deliveredError: '网络错误' })[0].text;
    assert.ok(text.includes('未发送到 QQ'));
    assert.ok(text.includes('网络错误'));
  });

  it('explains send=false', () => {
    const tool = createRenderTextImageTool({ renderTextImage: async () => ({}) });
    const text = tool.output.render({ send: false }, baseValue)[0].text;
    assert.ok(text.includes('send=false'));
  });

  it('handles the SVG engine label', () => {
    const tool = createRenderTextImageTool({ renderTextImage: async () => ({}) });
    const text = tool.output.render({}, { ...baseValue, engine: 'svg', mediaType: 'image/svg+xml' })[0].text;
    assert.ok(text.includes('SVG 兜底'));
    assert.ok(text.includes('image/svg+xml'));
  });
});
