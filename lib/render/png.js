/**
 * Minimal PNG codec used to trim the blank tail of a headless screenshot.
 *
 * Supports the subset Chromium's `--screenshot` produces: 8-bit, non-interlaced,
 * color type 2 (RGB) or 6 (RGBA). Anything else is rejected so callers can fall
 * back to the untouched screenshot.
 */

import zlib from 'node:zlib';

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) {
    c = CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([length, typeBuf, data, crc]);
}

function channelsOf(colorType) {
  if (colorType === 2) return 3;
  if (colorType === 6) return 4;
  return 0;
}

/**
 * Decode an 8-bit RGB/RGBA PNG into raw unfiltered rows.
 * @param {Buffer|Uint8Array} bytes
 * @returns {{width:number,height:number,colorType:2|6,channels:3|4,data:Buffer}|null}
 */
export function decodePng(bytes) {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes ?? []);
  if (buf.length < 8 || !buf.subarray(0, 8).equals(SIGNATURE)) return null;

  let offset = 8;
  let width = 0;
  let height = 0;
  let colorType = 0;
  let bitDepth = 0;
  let interlace = 0;
  const idat = [];

  while (offset + 8 <= buf.length) {
    const length = buf.readUInt32BE(offset);
    const type = buf.toString('ascii', offset + 4, offset + 8);
    const data = buf.subarray(offset + 8, offset + 8 + length);
    offset += 12 + length;
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
  }

  const channels = channelsOf(colorType);
  if (!width || !height || bitDepth !== 8 || interlace !== 0 || !channels) return null;

  let inflated;
  try {
    inflated = zlib.inflateSync(Buffer.concat(idat));
  } catch {
    return null;
  }

  const stride = width * channels;
  if (inflated.length < (stride + 1) * height) return null;

  const data = Buffer.alloc(stride * height);
  let prior = Buffer.alloc(stride);
  for (let y = 0; y < height; y += 1) {
    const filter = inflated[y * (stride + 1)];
    const rowStart = y * (stride + 1) + 1;
    const outRow = data.subarray(y * stride, (y + 1) * stride);
    for (let x = 0; x < stride; x += 1) {
      const raw = inflated[rowStart + x];
      const left = x >= channels ? outRow[x - channels] : 0;
      const up = prior[x];
      const upLeft = x >= channels ? prior[x - channels] : 0;
      let value;
      switch (filter) {
        case 0:
          value = raw;
          break;
        case 1:
          value = raw + left;
          break;
        case 2:
          value = raw + up;
          break;
        case 3:
          value = raw + ((left + up) >> 1);
          break;
        case 4: {
          const p = left + up - upLeft;
          const pa = Math.abs(p - left);
          const pb = Math.abs(p - up);
          const pc = Math.abs(p - upLeft);
          const predictor = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
          value = raw + predictor;
          break;
        }
        default:
          return null;
      }
      outRow[x] = value & 0xff;
    }
    prior = outRow;
  }

  return { width, height, colorType, channels, data };
}

/**
 * Encode raw rows into a PNG (filter 0 rows).
 * @param {{width:number,height:number,colorType:2|6,channels:3|4,data:Buffer}} image
 * @returns {Buffer}
 */
export function encodePng({ width, height, colorType, channels, data }) {
  const stride = width * channels;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0;
    data.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = colorType;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function rowIsBlank(data, rowStart, width, channels, background, tolerance) {
  for (let x = 0; x < width; x += 1) {
    const p = rowStart + x * channels;
    if (
      Math.abs(data[p] - background[0]) > tolerance ||
      Math.abs(data[p + 1] - background[1]) > tolerance ||
      Math.abs(data[p + 2] - background[2]) > tolerance
    ) {
      return false;
    }
  }
  return true;
}

/**
 * Pick the dominant background color by sampling the image sparsely.
 * @returns {number[]} [r,g,b]
 */
function dominantBackground(data, width, height, channels) {
  const counts = new Map();
  const stride = width * channels;
  const stepY = Math.max(1, Math.floor(height / 120));
  const stepX = Math.max(1, Math.floor(width / 120));
  for (let y = 0; y < height; y += stepY) {
    for (let x = 0; x < width; x += stepX) {
      const p = y * stride + x * channels;
      const key = (data[p] << 16) | (data[p + 1] << 8) | data[p + 2];
      counts.set(key, (counts.get(key) || 0) + 1);
    }
  }
  let best = 0;
  let bestCount = -1;
  for (const [key, count] of counts.entries()) {
    if (count > bestCount) {
      best = key;
      bestCount = count;
    }
  }
  return [(best >> 16) & 0xff, (best >> 8) & 0xff, best & 0xff];
}

/**
 * Detect a screenshot that never painted (a single uniform color).
 * @param {Buffer|Uint8Array} bytes
 * @returns {boolean} true when the PNG is uniform or undecodable
 */
export function isLikelyBlankPng(bytes) {
  const image = decodePng(bytes);
  if (!image) return true;
  const { width, height, channels, data } = image;
  if (!width || !height) return true;
  const stride = width * channels;
  const first = (data[0] << 16) | (data[1] << 8) | data[2];
  const stepY = Math.max(1, Math.floor(height / 40));
  const stepX = Math.max(1, Math.floor(width / 40));
  for (let y = 0; y < height; y += stepY) {
    for (let x = 0; x < width; x += stepX) {
      const p = y * stride + x * channels;
      const key = (data[p] << 16) | (data[p + 1] << 8) | data[p + 2];
      if (key !== first) return false;
    }
  }
  return true;
}

/**
 * Trim the uniform background tail of a screenshot (and report clipping).
 * @param {Buffer} bytes PNG bytes
 * @param {{margin?:number, tolerance?:number, minHeight?:number}} [options]
 * @returns {{bytes:Buffer,width:number,height:number,trimmed:boolean,clipped:boolean}|null}
 */
export function trimPngBottom(bytes, { margin = 24, tolerance = 3, minHeight = 160 } = {}) {
  const image = decodePng(bytes);
  if (!image) return null;

  const { width, height, colorType, channels, data } = image;
  const stride = width * channels;
  const lastRow = height - 1;
  const background = dominantBackground(data, width, height, channels);

  let contentRow = -1;
  for (let y = lastRow; y >= 0; y -= 1) {
    if (!rowIsBlank(data, y * stride, width, channels, background, tolerance)) {
      contentRow = y;
      break;
    }
  }

  // Nothing detectable: keep the original screenshot.
  if (contentRow < 0) {
    return { bytes, width, height, trimmed: false, clipped: false };
  }

  const lastRowBlank = rowIsBlank(data, lastRow * stride, width, channels, background, tolerance);
  const clipped = !lastRowBlank || contentRow >= lastRow - Math.max(2, margin);
  const targetHeight = Math.max(minHeight, Math.min(height, contentRow + 1 + margin));
  if (targetHeight >= height) {
    return { bytes, width, height, trimmed: false, clipped };
  }

  const cropped = data.subarray(0, targetHeight * stride);
  const encoded = encodePng({ width, height: targetHeight, colorType, channels, data: cropped });
  return { bytes: encoded, width, height: targetHeight, trimmed: true, clipped };
}
