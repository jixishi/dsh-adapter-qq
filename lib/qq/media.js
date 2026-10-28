/**
 * QQ rich-media helpers.
 *
 * Pure Node module (no DSH dependency, no third-party packages): magic-number
 * image sniffing, filename hygiene, byte formatting and QQ `file_type`
 * classification. The sniffing result is authoritative: QQ frequently reports
 * a `content_type` that does not match the real bytes, so callers must prefer
 * `sniffImageMediaType()` over any declared type or file extension.
 */

export const IMAGE_MEDIA_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];

const IMAGE_EXTENSION_TO_MEDIA_TYPE = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
};

const VIDEO_EXTENSIONS = new Set([
  'mp4', 'mov', 'm4v', 'avi', 'mkv', 'webm', 'flv', 'wmv', '3gp', 'mpeg', 'mpg', 'ts',
]);

const VOICE_EXTENSIONS = new Set([
  'silk', 'slk', 'amr', 'mp3', 'wav', 'ogg', 'oga', 'm4a', 'aac', 'flac', 'wma', 'opus',
]);

const MAX_FILENAME_CHARS = 120;

/**
 * Coerce Buffer / Uint8Array / ArrayBuffer to Buffer; null for anything else.
 * @param {Buffer|Uint8Array|ArrayBuffer|null|undefined} bytes
 * @returns {Buffer|null}
 */
function toBuffer(bytes) {
  if (Buffer.isBuffer(bytes)) return bytes;
  if (bytes instanceof Uint8Array) {
    return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  if (bytes instanceof ArrayBuffer) return Buffer.from(bytes);
  return null;
}

/**
 * Lowercase, strip parameters and normalize common aliases of a MIME type.
 * @param {string} contentType
 * @returns {string}
 */
function normalizeContentType(contentType) {
  const raw = String(contentType ?? '').trim().toLowerCase();
  if (!raw) return '';
  const bare = raw.split(';')[0].trim();
  if (bare === 'image/jpg' || bare === 'image/pjpeg') return 'image/jpeg';
  return bare;
}

/**
 * Lowercase extension of a filename, ignoring directories, query strings and
 * leading-dot-only names. Returns '' when there is no usable extension.
 * @param {string} filename
 * @returns {string}
 */
function extensionOf(filename) {
  const raw = String(filename ?? '').trim();
  if (!raw) return '';
  const clean = raw.split(/[?#]/)[0].replace(/\\/g, '/');
  const base = clean.slice(clean.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  if (dot <= 0 || dot === base.length - 1) return '';
  return base.slice(dot + 1).toLowerCase();
}

/**
 * Sniff an image media type from magic numbers.
 * @param {Buffer|Uint8Array|ArrayBuffer} bytes
 * @returns {string|null} one of IMAGE_MEDIA_TYPES, or null
 */
export function sniffImageMediaType(bytes) {
  const buf = toBuffer(bytes);
  if (!buf) return null;

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    buf.length >= 8
    && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47
    && buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a
  ) {
    return 'image/png';
  }

  // JPEG: FF D8 FF
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return 'image/jpeg';
  }

  // GIF: "GIF87a" or "GIF89a"
  if (buf.length >= 6) {
    const header = buf.toString('latin1', 0, 6);
    if (header === 'GIF87a' || header === 'GIF89a') return 'image/gif';
  }

  // WEBP: "RIFF" + 4-byte size + "WEBP"
  if (
    buf.length >= 12
    && buf.toString('latin1', 0, 4) === 'RIFF'
    && buf.toString('latin1', 8, 12) === 'WEBP'
  ) {
    return 'image/webp';
  }

  return null;
}

/**
 * Infer an image media type from a filename extension.
 * @param {string} filename
 * @returns {string|null} one of IMAGE_MEDIA_TYPES, or null
 */
export function imageMediaTypeFromName(filename) {
  return IMAGE_EXTENSION_TO_MEDIA_TYPE[extensionOf(filename)] || null;
}

/**
 * Whether a media type is an image type DSH can carry natively.
 * @param {string} mediaType
 * @returns {boolean}
 */
export function isImageMediaType(mediaType) {
  return IMAGE_MEDIA_TYPES.includes(normalizeContentType(mediaType));
}

/**
 * Unified attachment classification: real bytes first, then a declared
 * `image/*` content type, then the filename extension.
 * Non-images keep their (normalized) declared content type, possibly ''.
 * @param {Object} attachment
 * @param {string} [attachment.contentType]
 * @param {string} [attachment.filename]
 * @param {Buffer|Uint8Array} [attachment.bytes]
 * @returns {{ mediaType: string, isImage: boolean }}
 */
export function inferAttachmentMediaType({ contentType, filename, bytes } = {}) {
  const sniffed = sniffImageMediaType(bytes);
  if (sniffed) return { mediaType: sniffed, isImage: true };

  const declared = normalizeContentType(contentType);
  if (declared.startsWith('image/')) return { mediaType: declared, isImage: true };

  const fromName = imageMediaTypeFromName(filename);
  if (fromName) return { mediaType: fromName, isImage: true };

  return { mediaType: declared, isImage: false };
}

/**
 * Strip directories and control characters, trim and cap at 120 code points.
 * Empty / dot-only names fall back to `fallback` (then to 'file').
 * @param {string} name
 * @param {string} [fallback='file']
 * @returns {string}
 */
export function sanitizeFilename(name, fallback = 'file') {
  const raw = typeof name === 'string' ? name : String(name ?? '');
  let base = raw.replace(/\\/g, '/');
  const slash = base.lastIndexOf('/');
  if (slash >= 0) base = base.slice(slash + 1);

  base = base.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  base = Array.from(base).slice(0, MAX_FILENAME_CHARS).join('').trim();

  if (base && !/^\.+$/.test(base)) return base;

  const fallbackClean = String(fallback ?? '')
    .replace(/[\u0000-\u001f\u007f/\\]/g, '')
    .trim();
  const fallbackName = Array.from(fallbackClean).slice(0, MAX_FILENAME_CHARS).join('').trim();
  return fallbackName && !/^\.+$/.test(fallbackName) ? fallbackName : 'file';
}

/**
 * Human-readable byte size: "512 B", "1.2 KB", "3.4 MB" (1024-based).
 * @param {number} n
 * @returns {string}
 */
export function formatBytes(n) {
  const value = Number(n);
  if (!Number.isFinite(value) || value <= 0) return '0 B';
  if (value < 1024) return `${Math.round(value)} B`;

  const units = ['KB', 'MB', 'GB', 'TB'];
  let scaled = value / 1024;
  let unitIndex = 0;
  while (scaled >= 1024 && unitIndex < units.length - 1) {
    scaled /= 1024;
    unitIndex += 1;
  }
  return `${scaled.toFixed(1)} ${units[unitIndex]}`;
}

/**
 * QQ rich-media `file_type`: 1=image, 2=video, 3=voice, 4=file.
 * Extension / MIME based; MIME wins when both are present.
 * @param {Object} options
 * @param {string} [options.filename]
 * @param {string} [options.mediaType]
 * @returns {1|2|3|4}
 */
export function qqFileTypeFor({ filename, mediaType } = {}) {
  const declared = normalizeContentType(mediaType);
  const extension = extensionOf(filename);

  if (declared.startsWith('image/') || IMAGE_EXTENSION_TO_MEDIA_TYPE[extension]) return 1;
  if (declared.startsWith('video/') || VIDEO_EXTENSIONS.has(extension)) return 2;
  if (declared.startsWith('audio/') || VOICE_EXTENSIONS.has(extension)) return 3;
  return 4;
}
