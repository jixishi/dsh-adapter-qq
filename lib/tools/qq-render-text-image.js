/**
 * Agent tool definition: `qq_render_text_image`.
 *
 * Renders Markdown/plain text into an image (browser -> Pillow -> SVG) and,
 * unless `send: false`, uploads it to the currently bound QQ user through the
 * injected `sendImage` capability. Delivery failures never throw: they are
 * reported in the tool result (`delivered: false` + `deliveredError`).
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';

const MAX_TEXT_LENGTH = 20000;
const MIN_WIDTH = 480;
const MAX_WIDTH = 1600;

const ENGINE_LABELS = {
  browser: '无头浏览器',
  pillow: 'Pillow',
  svg: 'SVG 兜底',
};

function formatBytes(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value < 0) return '未知大小';
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

function extensionFor(mediaType) {
  return mediaType === 'image/svg+xml' ? '.svg' : '.png';
}

/** Keep filenames single-line, path-free and within 120 characters. */
function sanitizeFilename(name, mediaType, fallbackName = '') {
  const fallback = fallbackName || `render${extensionFor(mediaType)}`;
  if (typeof name !== 'string' || !name.trim()) return fallback;
  let raw = name.replace(/\\/g, '/').split('/').pop() || '';
  raw = raw.replace(/[\u0000-\u001f\u007f]/g, '').replace(/[<>:"|?*]/g, '_').trim();
  if (!raw) return fallback;
  if (!/\.[A-Za-z0-9]{1,6}$/.test(raw)) raw += extensionFor(mediaType);
  if (raw.length > 120) {
    const dot = raw.lastIndexOf('.');
    const suffix = dot > 0 ? raw.slice(dot) : '';
    const stem = dot > 0 ? raw.slice(0, dot) : raw;
    raw = stem.slice(0, Math.max(1, 120 - suffix.length)) + suffix;
  }
  return raw;
}

function clampWidth(value, fallback) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return fallback;
  return Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, Math.round(numeric)));
}

/**
 * Build the tool definition for `ctx.tools.register`.
 *
 * @param {Object} options
 * @param {Function} options.renderTextImage `lib/render/index.js` renderTextImage
 * @param {Function} [options.sendImage] `(userOpenid, { data, filename, msgId }) => Promise<{ messageId }>`
 * @param {Function} [options.getConfig]
 * @param {Console|Object} [options.logger]
 * @returns {Object}
 */
export function createRenderTextImageTool({
  renderTextImage,
  sendImage,
  getConfig = () => ({}),
  logger = console,
} = {}) {
  if (typeof renderTextImage !== 'function') {
    throw new TypeError('createRenderTextImageTool 需要 renderTextImage');
  }

  return {
    name: 'qq_render_text_image',
    description:
      '把 Markdown 或纯文本渲染成一张图片（优先无头浏览器排版，其次 Pillow，最后 SVG 兜底），'
      + '默认同时发送到当前绑定的 QQ 会话，并返回本地图片路径。适合把长回复、代码块、表格做成图片分享给 QQ 用户。',
    parameters: {
      type: 'object',
      properties: {
        text: {
          type: 'string',
          description: '要渲染的 Markdown 或纯文本内容（1-20000 字符，必填）',
        },
        title: {
          type: 'string',
          description: '图片顶部标题（可选）',
        },
        theme: {
          type: 'string',
          enum: ['light', 'dark'],
          description: '配色主题，默认 light',
        },
        width: {
          type: 'integer',
          description: `画布宽度（像素，${MIN_WIDTH}-${MAX_WIDTH}，默认 900）`,
        },
        send: {
          type: 'boolean',
          description: '是否同时发送到当前绑定的 QQ 会话，默认 true',
        },
        filename: {
          type: 'string',
          description: '发送到 QQ 时使用的文件名（可选，自动补扩展名）',
        },
      },
      required: ['text'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '本地图片绝对路径' },
          bytes: { type: 'number', description: '文件字节数' },
          width: { type: 'integer', description: '图片宽度（像素）' },
          height: { type: 'integer', description: '图片高度（像素）' },
          mediaType: { type: 'string', description: 'image/png 或 image/svg+xml' },
          engine: { type: 'string', description: 'browser | pillow | svg' },
          delivered: { type: 'boolean', description: '是否已发送到 QQ' },
          messageId: { type: 'string', description: 'QQ 消息 ID（发送成功时）' },
          deliveredError: { type: 'string', description: '发送失败原因（未发送时）' },
        },
        required: ['path', 'bytes', 'width', 'height', 'mediaType', 'engine', 'delivered'],
        additionalProperties: false,
      },
      render(args, value) {
        const engine = ENGINE_LABELS[value?.engine] || value?.engine || '未知引擎';
        const lines = [
          `已生成文本图片（${engine}）：${value?.path}`,
          `尺寸 ${value?.width}×${value?.height}px · ${formatBytes(value?.bytes)} · ${value?.mediaType}`,
        ];
        if (value?.delivered) {
          lines.push(value.messageId ? `已发送到 QQ（消息 ID：${value.messageId}）` : '已发送到 QQ。');
        } else if (value?.deliveredError) {
          lines.push(`未发送到 QQ：${value.deliveredError}`);
        } else if (args?.send === false) {
          lines.push('未发送到 QQ（send=false，仅返回本地文件）。');
        } else {
          lines.push('未发送到 QQ（尚未绑定 QQ 用户）。');
        }
        return [{ type: 'text', text: lines.join('\n') }];
      },
    },

    async execute(args = {}) {
      const text = typeof args?.text === 'string' ? args.text : '';
      if (!text.trim()) throw new Error('text 不能为空：请提供要渲染的 Markdown 或纯文本内容');
      if (text.length > MAX_TEXT_LENGTH) {
        throw new Error(`text 过长（${text.length} 字符），请控制在 ${MAX_TEXT_LENGTH} 字符以内`);
      }

      let config = {};
      try {
        config = (typeof getConfig === 'function' ? getConfig() : null) || {};
      } catch {
        config = {};
      }

      const width = clampWidth(args.width, clampWidth(config.renderWidth, 900));
      const theme = args.theme === 'dark' || args.theme === 'light'
        ? args.theme
        : (config.renderTheme === 'dark' ? 'dark' : 'light');

      const rendered = await renderTextImage({
        text,
        title: typeof args.title === 'string' ? args.title : '',
        theme,
        width,
        scale: 2,
        logger,
      });
      if (!rendered || !rendered.path) {
        throw new Error('图片渲染失败：未得到有效文件');
      }

      /** @type {Record<string, unknown>} */
      const value = {
        path: rendered.path,
        bytes: rendered.bytes,
        width: rendered.width,
        height: rendered.height,
        mediaType: rendered.mediaType,
        engine: rendered.engine,
        delivered: false,
      };

      const wantsSend = args.send !== false;
      if (!wantsSend) return value;

      const userOpenid = typeof config.userOpenid === 'string' ? config.userOpenid.trim() : '';
      if (!userOpenid) {
        value.deliveredError = '尚未绑定 QQ 用户';
        return value;
      }
      if (typeof sendImage !== 'function') {
        value.deliveredError = '当前未配置 QQ 图片发送能力';
        return value;
      }

      try {
        const data = await readFile(rendered.path);
        const fallbackName = path.basename(rendered.path);
        const filename = sanitizeFilename(args.filename, rendered.mediaType, fallbackName);
        const sent = await sendImage(userOpenid, { data, filename });
        value.delivered = true;
        const messageId = sent?.messageId ?? sent?.message_id ?? sent?.id;
        if (messageId !== undefined && messageId !== null) value.messageId = String(messageId);
      } catch (error) {
        value.delivered = false;
        value.deliveredError = String(error?.message || error || '发送失败');
        logger?.warn?.(`[adapter-qq] 渲染图片发送到 QQ 失败：${value.deliveredError}`);
      }
      return value;
    },
  };
}
