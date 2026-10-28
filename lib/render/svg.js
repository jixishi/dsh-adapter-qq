/**
 * SVG fallback engine: pure JavaScript, always available (no browser, no Python).
 * Produces a standalone SVG with one `<text>` element per line. The caller
 * reports the media type as `image/svg+xml`.
 */

import fsp from 'node:fs/promises';
import path from 'node:path';

const FONT_SIZE = 17;
const LINE_HEIGHT = 27;
const PADDING = 34;
const TITLE_SIZE = 26;
const TITLE_LINE_HEIGHT = 38;
const MAX_HEIGHT = 16000;
const SANS_STACK = '"Microsoft YaHei","PingFang SC","Hiragino Sans GB","Noto Sans CJK SC",sans-serif';

function escapeXml(text) {
  return String(text ?? '').replace(/[&<>"']/g, (ch) => {
    switch (ch) {
      case '&': return '&amp;';
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '"': return '&quot;';
      default: return '&#39;';
    }
  });
}

function isWide(char) {
  const code = char.codePointAt(0) ?? 0;
  return (
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe4f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x1f300 && code <= 0x1faff)
  );
}

function charWidth(char, fontSize) {
  return isWide(char) ? fontSize : fontSize * 0.58;
}

function wrapText(value, fontSize, maxWidth) {
  const lines = [];
  const normalized = String(value ?? '').replace(/\r\n?/g, '\n');
  for (const rawLine of normalized.split('\n')) {
    if (!rawLine) {
      lines.push('');
      continue;
    }
    let current = '';
    let currentWidth = 0;
    for (const char of Array.from(rawLine)) {
      const width = charWidth(char, fontSize);
      if (current && currentWidth + width > maxWidth) {
        lines.push(current);
        current = char;
        currentWidth = width;
      } else {
        current += char;
        currentWidth += width;
      }
    }
    lines.push(current);
  }
  return lines;
}

/**
 * Render text (and optional title) into an SVG file.
 *
 * @param {Object} options
 * @param {string} options.text
 * @param {string} [options.title]
 * @param {number} [options.width]
 * @param {string} options.outPath
 * @returns {Promise<{path:string,width:number,height:number,bytes:number}>}
 */
export async function renderTextAsSvg({ text = '', title = '', width = 900, outPath } = {}) {
  if (!outPath || typeof outPath !== 'string') {
    throw new TypeError('renderTextAsSvg 需要 outPath');
  }
  const canvasWidth = Math.max(320, Math.min(2400, Math.round(Number(width) || 900)));
  const innerWidth = canvasWidth - PADDING * 2;

  const titleLines = title ? wrapText(title, TITLE_SIZE, innerWidth) : [];
  let bodyLines = wrapText(text, FONT_SIZE, innerWidth);
  if (!bodyLines.length) bodyLines = [''];

  const headerHeight = titleLines.length ? titleLines.length * TITLE_LINE_HEIGHT + 16 : 0;
  const available = MAX_HEIGHT - PADDING * 2 - headerHeight;
  const maxLines = Math.max(1, Math.floor(available / LINE_HEIGHT));
  if (bodyLines.length > maxLines) {
    bodyLines = bodyLines.slice(0, Math.max(0, maxLines - 1)).concat('…（内容过长，已截断）');
  }

  const height = Math.max(200, PADDING * 2 + headerHeight + bodyLines.length * LINE_HEIGHT);

  /** @type {string[]} */
  const parts = [];
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${canvasWidth}" height="${height}" viewBox="0 0 ${canvasWidth} ${height}">`);
  parts.push('<rect width="100%" height="100%" fill="#ffffff"/>');
  let y = PADDING + TITLE_SIZE;
  if (titleLines.length) {
    for (const line of titleLines) {
      parts.push(
        `<text x="${PADDING}" y="${y}" font-family='${SANS_STACK}' font-size="${TITLE_SIZE}" font-weight="700" fill="#1c1d21" xml:space="preserve">${escapeXml(line)}</text>`,
      );
      y += TITLE_LINE_HEIGHT;
    }
    y += 4;
    parts.push(`<line x1="${PADDING}" y1="${y}" x2="${canvasWidth - PADDING}" y2="${y}" stroke="#d7dbe2" stroke-width="1"/>`);
    y += 18;
  }
  for (const line of bodyLines) {
    if (line) {
      parts.push(
        `<text x="${PADDING}" y="${y}" font-family='${SANS_STACK}' font-size="${FONT_SIZE}" fill="#2b2d33" xml:space="preserve">${escapeXml(line)}</text>`,
      );
    }
    y += LINE_HEIGHT;
  }
  parts.push('</svg>');
  const svg = `${parts.join('\n')}\n`;

  await fsp.mkdir(path.dirname(outPath), { recursive: true });
  await fsp.writeFile(outPath, svg, 'utf8');
  const stat = await fsp.stat(outPath);
  return { path: outPath, width: canvasWidth, height, bytes: stat.size };
}
