/**
 * Typst rendering engine.
 *
 * Uses the embedded official Typst CLI (`@flukxr/typst-cli`, 0.15.x platform
 * binaries) with two bundled font packages:
 *   - @fontpkg/lxgw-neo-xi-hei  (霞鹜新晰黑 / LXGW Neo XiHei)
 *   - noto-color-emoji          (Google Noto Color Emoji, CBDT full colour)
 *
 * Typst lays out and rasterizes in one pass, supports full-colour emoji and CJK
 * natively, and is fast (~30ms of engine time after process start).
 */

import { createRequire } from 'node:module';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { runProcess } from './process.js';

const require = createRequire(import.meta.url);

const TYPST_TIMEOUT_MS = 15000;
const PNG_EXPORT_PPI = 192; // CSS px -> 2x raster
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CJK_FONT = 'LXGW Neo XiHei';
const EMOJI_FONT = 'Noto Color Emoji';
const MONO_FONTS = '"Cascadia Mono", "Consolas", "LXGW Neo XiHei"';

/**
 * Resolve the embedded Typst binary and the two bundled font directories.
 * @returns {{typstPath:string, version:string, fontDirs:string[], lxgwDir:string, emojiDir:string}|null}
 */
export function resolveTypstAssets() {
  try {
    const cli = require('@flukxr/typst-cli');
    const typstPath = cli.typstPath;
    const lxgwDir = path.dirname(require.resolve('@fontpkg/lxgw-neo-xi-hei/package.json'));
    const emojiDir = path.join(path.dirname(require.resolve('noto-color-emoji/package.json')), 'ttf');
    if (!typstPath || !lxgwDir || !emojiDir) return null;
    return { typstPath, version: cli.version, fontDirs: [lxgwDir, emojiDir], lxgwDir, emojiDir };
  } catch {
    return null;
  }
}

function escapeTypst(text) {
  return String(text ?? '').replace(/[\\)#$[\]*_`<>@~]/g, (char) => `\\${char}`);
}

/** Typst string literal (JSON escapes are compatible with Typst). */
function typstString(text) {
  return JSON.stringify(String(text ?? ''));
}

/**
 * Render one Markdown inline run as Typst markup.
 * @param {string} text
 * @returns {string}
 */
export function renderInlineTypst(text) {
  const input = String(text ?? '');
  let out = '';
  let i = 0;

  while (i < input.length) {
    const rest = input.slice(i);
    let match;

    if ((match = /^`([^`]+)`/.exec(rest))) {
      out += `#raw(${typstString(match[1])})`;
      i += match[0].length;
      continue;
    }
    if ((match = /^\*\*([^*]+)\*\*/.exec(rest))) {
      out += `*${renderInlineTypst(match[1])}*`;
      i += match[0].length;
      continue;
    }
    if ((match = /^__([^_]+)__/.exec(rest))) {
      out += `*${renderInlineTypst(match[1])}*`;
      i += match[0].length;
      continue;
    }
    if ((match = /^~~([^~]+)~~/.exec(rest))) {
      out += `#strike[${renderInlineTypst(match[1])}]`;
      i += match[0].length;
      continue;
    }
    if ((match = /^\*([^*\n]+)\*/.exec(rest))) {
      out += `_${renderInlineTypst(match[1])}_`;
      i += match[0].length;
      continue;
    }
    if ((match = /^_([^_\n]+)_/.exec(rest))) {
      out += `_${renderInlineTypst(match[1])}_`;
      i += match[0].length;
      continue;
    }
    if ((match = /^!\[([^\]]*)\]\(([^)\s]+)\)/.exec(rest))) {
      out += renderInlineTypst(match[1] || match[2]);
      i += match[0].length;
      continue;
    }
    if ((match = /^\[([^\]]+)\]\(([^)\s]+)\)/.exec(rest))) {
      out += `#link(${typstString(match[2])})[${renderInlineTypst(match[1])}]`;
      i += match[0].length;
      continue;
    }

    out += escapeTypst(input[i]);
    i += 1;
  }

  return out;
}

function maxBacktickRun(text) {
  let max = 0;
  for (const match of String(text).matchAll(/`+/g)) max = Math.max(max, match[0].length);
  return max;
}

function isTableSeparator(line) {
  return /^\s*\|?[\s:|-]+\|?\s*$/.test(line) && line.includes('-');
}

function splitTableRow(line) {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim());
}

/**
 * Convert a Markdown document to Typst markup.
 * @param {string} markdown
 * @returns {string}
 */
export function markdownToTypst(markdown) {
  const lines = String(markdown ?? '').replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let i = 0;

  const isBlockStart = (line) => {
    const trimmed = line.trim();
    return (
      !trimmed ||
      /^```/.test(trimmed) ||
      /^#{1,6}\s/.test(trimmed) ||
      /^[-*+]\s+/.test(trimmed) ||
      /^\d+[.)]\s+/.test(trimmed) ||
      /^>\s?/.test(line) ||
      /^\s*\|/.test(trimmed) ||
      /^(?:-{3,}|\*{3,}|_{3,})$/.test(trimmed)
    );
  };

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    if (!trimmed) {
      out.push('');
      i += 1;
      continue;
    }

    if (/^```/.test(trimmed)) {
      const lang = trimmed.slice(3).trim().replace(/[^\w+#.-]/g, '');
      const body = [];
      i += 1;
      while (i < lines.length && !/^```\s*$/.test(lines[i].trim())) {
        body.push(lines[i]);
        i += 1;
      }
      i += 1;
      const fence = '`'.repeat(Math.max(3, maxBacktickRun(body.join('\n')) + 1));
      out.push(`${fence}${lang}\n${body.join('\n')}\n${fence}`, '');
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(trimmed);
    if (heading) {
      const level = heading[1].length;
      out.push(`${'='.repeat(level)} ${renderInlineTypst(heading[2].replace(/\s+#+\s*$/, ''))}`, '');
      i += 1;
      continue;
    }

    if (/^(?:-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      out.push('#line(length: 100%, stroke: 0.7pt + rgb("#d9dde5"))', '');
      i += 1;
      continue;
    }

    if (/^>\s?/.test(line)) {
      const parts = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) {
        parts.push(renderInlineTypst(lines[i].replace(/^>\s?/, '')));
        i += 1;
      }
      out.push(`#quote(block: true)[${parts.join('\n\n')}]`, '');
      continue;
    }

    if (/^[-*+]\s+/.test(trimmed)) {
      const items = [];
      while (i < lines.length && /^[-*+]\s+/.test(lines[i].trim())) {
        items.push(renderInlineTypst(lines[i].trim().replace(/^[-*+]\s+/, '')));
        i += 1;
      }
      out.push(items.map((item) => `- ${item}`).join('\n'), '');
      continue;
    }

    if (/^\d+[.)]\s+/.test(trimmed)) {
      const items = [];
      while (i < lines.length && /^\d+[.)]\s+/.test(lines[i].trim())) {
        items.push(renderInlineTypst(lines[i].trim().replace(/^\d+[.)]\s+/, '')));
        i += 1;
      }
      out.push(items.map((item) => `+ ${item}`).join('\n'), '');
      continue;
    }

    if (/^\s*\|/.test(trimmed) && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
      const header = splitTableRow(trimmed);
      i += 2;
      const rows = [];
      while (i < lines.length && /^\s*\|/.test(lines[i].trim())) {
        rows.push(splitTableRow(lines[i].trim()));
        i += 1;
      }
      const columns = Math.max(header.length, ...rows.map((row) => row.length));
      const cell = (value) => `[${renderInlineTypst(value ?? '')}]`;
      const headerCells = Array.from({ length: columns }, (_, index) => cell(header[index]));
      const bodyRows = rows.map((row) =>
        Array.from({ length: columns }, (_, index) => cell(row[index])).join(', ')
      );
      out.push(
        `#table(columns: ${columns}, align: left, stroke: 0.7pt + rgb("#dfe3ea"), inset: 7pt,\n` +
          `  table.header(${headerCells.join(', ')})${bodyRows.length ? ',\n  ' + bodyRows.join(',\n  ') : ''}\n)`,
        ''
      );
      continue;
    }

    const paragraph = [];
    while (i < lines.length && !isBlockStart(lines[i])) {
      paragraph.push(lines[i].trim());
      i += 1;
    }
    if (paragraph.length === 0) {
      // Defensive: an unclassified line must still make progress.
      paragraph.push(trimmed);
      i += 1;
    }
    out.push(paragraph.map(renderInlineTypst).join(' '), '');
  }

  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

const PALETTES = {
  light: {
    page: '#ffffff',
    text: '#1c1d21',
    muted: '#666c78',
    border: '#e2e5ea',
    code: '#f2f4f7',
    accent: '#2f6feb',
  },
  dark: {
    page: '#15171c',
    text: '#e8eaed',
    muted: '#a0a6b2',
    border: '#2c313a',
    code: '#23272f',
    accent: '#79a6ff',
  },
};

/**
 * Build the complete Typst document for one text card.
 * @param {Object} options
 * @param {string} options.body Typst markup
 * @param {string} [options.title]
 * @param {string} [options.subtitle]
 * @param {number} [options.width]
 * @param {'light'|'dark'} [options.theme]
 * @param {string} [options.footer]
 * @returns {string}
 */
export function buildTypstDocument({
  body,
  title = '',
  subtitle = '',
  width = 900,
  theme = 'light',
  footer = '',
}) {
  const palette = PALETTES[theme === 'dark' ? 'dark' : 'light'];
  const cssWidth = Math.max(320, Math.min(2400, Math.round(Number(width) || 900)));
  // Typst has no CSS px unit: 1px = 0.75pt at the 96dpi CSS reference.
  const P = (px) => `${(Number(px) * 0.75).toFixed(2)}pt`;

  return `#set page(width: ${P(cssWidth)}, height: auto, margin: (x: ${P(34)}, y: ${P(30)}), fill: rgb("${palette.page}"))
#set text(font: ("${CJK_FONT}", "${EMOJI_FONT}"), size: ${P(16)}, fill: rgb("${palette.text}"), lang: "zh")
#set par(leading: 0.78em, spacing: 1.05em)
#show heading: set text(fill: rgb("${palette.text}"))
#show heading.where(level: 1): set text(size: ${P(27)}, weight: "bold")
#show heading.where(level: 2): set text(size: ${P(22)}, weight: "bold")
#show heading.where(level: 3): set text(size: ${P(18)}, weight: "bold")
#show heading.where(level: 4): set text(size: ${P(16)}, weight: "bold")
#show heading.where(level: 5): set text(size: ${P(15)}, weight: "bold")
#show heading.where(level: 6): set text(size: ${P(14)}, weight: "bold")
#show heading: it => block(above: 1.15em, below: 0.55em, it)
#show raw: set text(font: (${MONO_FONTS}), size: ${P(13)})
#show raw.where(block: true): block.with(fill: rgb("${palette.code}"), inset: ${P(10)}, radius: ${P(7)}, width: 100%)
#show link: set text(fill: rgb("${palette.accent}"))
${
  title
    ? `#text(size: ${P(27)}, weight: "bold", fill: rgb("${palette.accent}"))[${renderInlineTypst(title)}]
#v(${P(2)})
#line(length: 100%, stroke: 0.8pt + rgb("${palette.border}"))
#v(${P(12)})
`
    : ''
}${subtitle ? `#text(size: ${P(14)}, fill: rgb("${palette.muted}"))[${renderInlineTypst(subtitle)}]\n#v(${P(8)})\n` : ''}
${body}
${footer ? `#v(${P(12)})\n#align(right)[#text(size: ${P(11)}, fill: rgb("${palette.muted}"))[${renderInlineTypst(footer)}]]\n` : ''}`;
}

/**
 * Parse width/height from a PNG IHDR chunk.
 * @param {Buffer} bytes
 * @returns {{width:number,height:number}|null}
 */
function parsePngSize(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 24) return null;
  if (!bytes.subarray(0, 8).equals(PNG_SIGNATURE)) return null;
  if (bytes.toString('ascii', 12, 16) !== 'IHDR') return null;
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  return width && height ? { width, height } : null;
}

/**
 * Render Markdown/plain text into a PNG with Typst.
 *
 * @param {Object} options
 * @param {string} options.text
 * @param {string} [options.title]
 * @param {string} [options.subtitle]
 * @param {number} [options.width]
 * @param {'light'|'dark'} [options.theme]
 * @param {string} options.outPath
 * @param {Console|Object} [options.logger]
 * @returns {Promise<{path:string,width:number,height:number,bytes:number,mediaType:'image/png',engine:'typst'}|null>}
 */
export async function renderTextWithTypst({
  text = '',
  typstBody = '',
  title = '',
  subtitle = '',
  width = 900,
  theme = 'light',
  outPath,
  logger = console,
} = {}) {
  if (!outPath || typeof outPath !== 'string') return null;
  const assets = resolveTypstAssets();
  if (!assets) return null;

  let tmpDir = null;
  try {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-typst-'));
    const typPath = path.join(tmpDir, 'doc.typ');
    const source = buildTypstDocument({
      body: typstBody || markdownToTypst(text),
      title,
      subtitle,
      width,
      theme,
      footer: `DSH QQ 适配器 · ${new Date().toLocaleString('zh-CN', { hour12: false })}`,
    });
    await fsp.writeFile(typPath, source, 'utf8');
    await fsp.mkdir(path.dirname(outPath), { recursive: true });

    const args = ['compile', '--format', 'png', '--ppi', String(PNG_EXPORT_PPI), '--ignore-system-fonts'];
    for (const dir of assets.fontDirs) args.push('--font-path', dir);
    args.push(typPath, outPath);

    const result = await runProcess({
      command: assets.typstPath,
      args,
      stdoutPath: path.join(tmpDir, 'out.txt'),
      stderrPath: path.join(tmpDir, 'err.txt'),
      timeoutMs: TYPST_TIMEOUT_MS,
    });

    if (!result.ok) {
      let detail = '';
      try {
        detail = (await fsp.readFile(path.join(tmpDir, 'err.txt'), 'utf8')).trim().split('\n').slice(-3).join(' ');
      } catch {
        // ignore
      }
      logger?.warn?.(
        `[adapter-qq] Typst 渲染失败 (${result.timedOut ? 'timeout' : result.code}): ${detail || '未知错误'}`
      );
      return null;
    }

    const png = await fsp.readFile(outPath);
    const size = parsePngSize(png);
    if (!size) {
      logger?.warn?.('[adapter-qq] Typst 输出不是有效 PNG');
      return null;
    }
    return {
      path: outPath,
      width: size.width,
      height: size.height,
      bytes: png.length,
      mediaType: 'image/png',
      engine: 'typst',
    };
  } catch (error) {
    logger?.warn?.(`[adapter-qq] Typst 渲染异常: ${error?.message ?? error}`);
    return null;
  } finally {
    if (tmpDir) await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}
