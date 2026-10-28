/**
 * `qq_send_file` tool: deliver a local file (or base64 payload) to the bound QQ
 * user. Images are sent as rich-media image messages, everything else as file
 * messages. Binary classification is delegated to `lib/qq/media.js` so the real
 * bytes win over the declared type, matching what QQ and DSH attachments expect.
 */

import { readFile, stat } from 'node:fs/promises';
import { basename, isAbsolute, resolve } from 'node:path';

const DEFAULT_FILENAME = 'file';
const MAX_FILENAME_CHARS = 120;
const IMAGE_EXTENSION_BY_MEDIA_TYPE = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
};

/**
 * Prefer the shared media helper for filename hygiene; keep a local fallback so
 * an unexpected helper failure cannot break sending.
 * @param {Object} media
 * @param {string} name
 * @param {string} fallback
 * @returns {string}
 */
function sanitizeFilenameWith(media, name, fallback) {
  try {
    if (typeof media?.sanitizeFilename === 'function') {
      const cleaned = media.sanitizeFilename(name, fallback);
      if (typeof cleaned === 'string' && cleaned) return cleaned;
    }
  } catch {
    /* fall through to the local cleaner */
  }
  return safeFilename(name, fallback);
}

/** Cached dynamic import of the media helpers (the tool must stay loadable alone). */
let mediaModulePromise = null;

async function loadMediaModule() {
  if (!mediaModulePromise) {
    mediaModulePromise = import('../qq/media.js').catch((error) => {
      mediaModulePromise = null;
      throw error;
    });
  }
  return mediaModulePromise;
}

/**
 * @param {unknown} error
 * @returns {string}
 */
function errorMessage(error) {
  const raw =
    error && typeof error === 'object' && typeof error.message === 'string'
      ? error.message
      : String(error ?? 'unknown error');
  return raw.trim() || 'unknown error';
}

/**
 * Strip directories/control characters and cap the visible name length.
 * @param {string} name
 * @param {string} [fallback]
 * @returns {string}
 */
function safeFilename(name, fallback = DEFAULT_FILENAME) {
  const raw = typeof name === 'string' ? name : String(name ?? '');
  const base = raw.split(/[\\/]/).pop() ?? '';
  const cleaned = Array.from(base.replace(/[\u0000-\u001f\u007f]/g, '').trim())
    .slice(0, MAX_FILENAME_CHARS)
    .join('')
    .trim();
  if (cleaned && !/^\.+$/.test(cleaned)) return cleaned;
  return fallback;
}

/**
 * Human-readable size used by `output.render` (kept locally so rendering never
 * needs to await a module).
 * @param {number} bytes
 * @returns {string}
 */
function formatSize(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value <= 0) return '0 B';
  if (value < 1024) return `${Math.round(value)} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let scaled = value / 1024;
  let index = 0;
  while (scaled >= 1024 && index < units.length - 1) {
    scaled /= 1024;
    index += 1;
  }
  return `${scaled.toFixed(1)} ${units[index]}`;
}

/**
 * Resolve a user-supplied path against the execution working directory.
 * @param {string} input
 * @param {Object} exec
 * @returns {string}
 */
function resolveInputPath(input, exec) {
  const raw = String(input ?? '').trim();
  if (!raw) return '';
  if (isAbsolute(raw)) return raw;
  const bases = [
    exec?.cwd,
    exec?.workingDirectory,
    // DSH 0.2.1 exposes the session working directory through the agent header.
    exec?.agent?.session?.header?.cwd,
    process.cwd(),
  ];
  const base = bases.find((value) => typeof value === 'string' && value.trim() !== '');
  return resolve(base, raw);
}

/**
 * Decode a base64 payload, tolerating an optional `data:…;base64,` prefix.
 * @param {string} input
 * @returns {Buffer}
 */
function decodeBase64(input) {
  const raw = String(input ?? '').trim();
  const payload = raw.startsWith('data:') ? raw.slice(raw.indexOf(',') + 1) : raw;
  return Buffer.from(payload.replace(/\s+/g, ''), 'base64');
}

/**
 * Build the `qq_send_file` tool definition for `ctx.tools.register`.
 * @param {Object} options
 * @param {(userOpenid: string, payload: { data: Buffer, filename: string, msgId?: string }) => Promise<Object>} options.sendFile
 * @param {(userOpenid: string, payload: { data: Buffer, filename: string, msgId?: string }) => Promise<Object>} options.sendImage
 * @param {Function} options.getConfig
 * @param {Object} [options.logger]
 * @returns {Object}
 */
export function createSendFileTool({ sendFile, sendImage, getConfig, logger = console } = {}) {
  if (typeof sendFile !== 'function') {
    throw new TypeError('createSendFileTool: sendFile must be a function');
  }
  if (typeof sendImage !== 'function') {
    throw new TypeError('createSendFileTool: sendImage must be a function');
  }

  const readConfig = () => {
    try {
      const value = typeof getConfig === 'function' ? getConfig() : {};
      return value && typeof value === 'object' ? value : {};
    } catch {
      return {};
    }
  };

  return {
    name: 'qq_send_file',
    description:
      '把本地文件或 base64 数据发送到当前绑定的 QQ 会话。图片（按字节嗅探）以图片消息发送，其他内容以文件消息发送。'
      + 'path 与 data_base64 至少提供一个；path 支持绝对路径或相对于会话工作目录的路径。',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: '要发送的本地文件路径（绝对路径，或相对于当前会话工作目录的路径）',
        },
        data_base64: {
          type: 'string',
          description: '文件内容的 base64 编码（可带 data:...;base64, 前缀），与 path 二选一',
        },
        filename: {
          type: 'string',
          description: '发送时显示的文件名；缺省时使用 path 的文件名',
        },
        as_image: {
          type: 'boolean',
          description: '强制按图片消息发送（仅当内容确实是图片时使用）',
        },
        msg_id: {
          type: 'string',
          description: '被动回复使用的 QQ 消息 ID（可选）',
        },
      },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean', description: '是否发送成功' },
          path: { type: 'string', description: '实际读取的本地绝对路径（仅 path 方式）' },
          bytes: { type: 'integer', description: '发送的字节数' },
          filename: { type: 'string', description: '发送时使用的文件名' },
          kind: { type: 'string', enum: ['image', 'file'], description: '实际使用的消息类型' },
          messageId: { type: 'string', description: 'QQ 返回的消息 ID' },
          error: { type: 'string', description: '失败原因' },
        },
        required: ['ok'],
        additionalProperties: false,
      },
      render(_args, value) {
        try {
          const result = value && typeof value === 'object' ? value : {};
          if (result.ok === false) {
            return [{ type: 'text', text: `QQ 文件发送失败：${result.error || '未知错误'}` }];
          }
          const kindLabel = result.kind === 'image' ? '图片' : '文件';
          const parts = [`已发送${kindLabel}「${result.filename || DEFAULT_FILENAME}」到当前 QQ 会话`];
          if (typeof result.bytes === 'number') parts.push(formatSize(result.bytes));
          if (result.path) parts.push(`本地路径：${result.path}`);
          if (result.messageId) parts.push(`消息 ID：${result.messageId}`);
          return [{ type: 'text', text: parts.join('，') }];
        } catch {
          return [{ type: 'text', text: 'QQ 文件发送完成' }];
        }
      },
    },

    async execute(args = {}, exec = {}) {
      const input = args && typeof args === 'object' ? args : {};
      const config = readConfig();
      const userOpenid = typeof config.userOpenid === 'string' ? config.userOpenid.trim() : '';
      if (!userOpenid) {
        return { ok: false, error: '尚未绑定 QQ 用户' };
      }

      const hasPath = typeof input.path === 'string' && input.path.trim() !== '';
      const hasData = typeof input.data_base64 === 'string' && input.data_base64.trim() !== '';
      if (!hasPath && !hasData) {
        return { ok: false, error: '需要提供 path 或 data_base64 之一' };
      }

      let media;
      try {
        media = await loadMediaModule();
      } catch (error) {
        const message = `媒体类型嗅探模块不可用：${errorMessage(error)}`;
        logger.warn?.(`[qq_send_file] ${message}`);
        return { ok: false, error: message };
      }

      const resolvedPath = hasPath ? resolveInputPath(input.path, exec) : '';
      let bytes;
      let sourceName = '';
      if (hasPath) {
        if (!resolvedPath) return { ok: false, error: 'path 不能为空' };
        try {
          const info = await stat(resolvedPath);
          if (!info.isFile()) {
            return { ok: false, error: `路径不是普通文件：${resolvedPath}` };
          }
          bytes = await readFile(resolvedPath);
        } catch (error) {
          return { ok: false, error: `无法读取文件：${errorMessage(error)}` };
        }
        if (bytes.length === 0) {
          return { ok: false, error: `文件内容为空，无法发送：${resolvedPath}` };
        }
        sourceName = basename(resolvedPath);
      } else {
        try {
          bytes = decodeBase64(input.data_base64);
        } catch (error) {
          return { ok: false, error: `data_base64 解码失败：${errorMessage(error)}` };
        }
        if (!bytes || bytes.length === 0) {
          return { ok: false, error: 'data_base64 为空或不是有效的 base64 内容' };
        }
        sourceName = typeof input.filename === 'string' ? input.filename : '';
      }

      let inferred;
      try {
        inferred = media.inferAttachmentMediaType({
          contentType: '',
          filename: sourceName,
          bytes,
        });
      } catch (error) {
        inferred = { mediaType: '', isImage: false };
        logger.warn?.(`[qq_send_file] media sniffing failed: ${errorMessage(error)}`);
      }
      const useImage = input.as_image === true || inferred?.isImage === true;

      const fallbackName =
        (inferred?.mediaType && IMAGE_EXTENSION_BY_MEDIA_TYPE[inferred.mediaType]
          ? `image.${IMAGE_EXTENSION_BY_MEDIA_TYPE[inferred.mediaType]}`
          : '') || DEFAULT_FILENAME;
      const filename = sanitizeFilenameWith(
        media,
        typeof input.filename === 'string' && input.filename.trim() ? input.filename : sourceName,
        fallbackName,
      );
      const kind = useImage ? 'image' : 'file';
      const payload = {
        data: bytes,
        filename,
        ...(typeof input.msg_id === 'string' && input.msg_id.trim() ? { msgId: input.msg_id.trim() } : {}),
      };

      try {
        const sent = useImage
          ? await sendImage(userOpenid, payload)
          : await sendFile(userOpenid, payload);
        const rawMessageId = sent?.messageId ?? sent?.message_id ?? sent?.id;
        const result = {
          ok: true,
          ...(resolvedPath ? { path: resolvedPath } : {}),
          bytes: bytes.length,
          filename,
          kind,
        };
        if (rawMessageId !== undefined && rawMessageId !== null && String(rawMessageId) !== '') {
          result.messageId = String(rawMessageId);
        }
        return result;
      } catch (error) {
        const message = errorMessage(error);
        logger.warn?.(`[qq_send_file] send ${kind} failed: ${message}`);
        return {
          ok: false,
          ...(resolvedPath ? { path: resolvedPath } : {}),
          bytes: bytes.length,
          filename,
          kind,
          error: message,
        };
      }
    },
  };
}
