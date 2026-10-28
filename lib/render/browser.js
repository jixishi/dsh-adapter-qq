/**
 * Headless browser engine: locate a Chromium-family executable and render an
 * HTML document to a real PNG in two passes.
 *
 * Pass 1 (`--dump-dom`) reads the height published by the page.
 * Pass 2 (`--screenshot`) captures the page at that exact size.
 * Every failure resolves to `null`; nothing is thrown to the caller.
 *
 * Child processes write their stdio into files instead of pipes: this keeps
 * large DOM dumps off the pipe limits and works in environments that restrict
 * anonymous pipes.
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { runProcess } from './process.js';
import { isLikelyBlankPng, trimPngBottom } from './png.js';

const PROCESS_TIMEOUT_MS = 6000;
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

// A failed headless launch usually means the host cannot run Chromium here
// (sandbox, broken install, another instance). Skip the slow retries briefly
// so /render falls back to Pillow quickly instead of waiting every time.
const RETRY_COOLDOWN_MS = 60_000;
let retryAfter = 0;

/** Allow the browser engine to be tried again immediately (tests / manual reset). */
export function resetBrowserCooldown() {
  retryAfter = 0;
}

function firstExisting(candidates) {
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== 'string') continue;
    try {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
    } catch {
      // ignore unreadable paths
    }
  }
  return null;
}

function envBrowserCandidates() {
  const result = [];
  for (const key of ['QQ_ADAPTER_BROWSER', 'DSH_BROWSER']) {
    const value = process.env[key];
    if (!value) continue;
    const cleaned = String(value).trim().replace(/^"|"$/g, '');
    if (cleaned) result.push(cleaned);
  }
  return result;
}

function windowsCandidates() {
  const roots = [
    process.env.ProgramFiles,
    process.env['ProgramFiles(x86)'],
    'C:\\Program Files',
    'C:\\Program Files (x86)',
  ].filter(Boolean);
  const local = process.env.LOCALAPPDATA;
  // Edge first (present on nearly every Windows machine), then Chrome.
  const edge = roots.map((root) => path.join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
  const chrome = roots.map((root) => path.join(root, 'Google', 'Chrome', 'Application', 'chrome.exe'));
  if (local) {
    edge.push(path.join(local, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
    chrome.push(path.join(local, 'Google', 'Chrome', 'Application', 'chrome.exe'));
  }
  return [...edge, ...chrome];
}

function macCandidates() {
  return [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
  ];
}

function linuxCandidates() {
  return [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/snap/bin/chromium',
    '/opt/google/chrome/chrome',
    '/usr/local/bin/google-chrome',
    '/usr/local/bin/chromium',
  ];
}

/**
 * Locate a usable Chromium-family executable.
 * Order: env override -> platform default locations.
 * @returns {string|null} absolute path, or null when nothing is installed
 */
export function findBrowserExecutable() {
  // Explicit opt-out for hosts where Chromium headless cannot run.
  const override = String(process.env.QQ_ADAPTER_BROWSER || '').trim().toLowerCase();
  if (override === 'off' || override === 'none' || override === '0' || override === 'false') return null;
  const platform = process.platform;
  const platformCandidates =
    platform === 'win32' ? windowsCandidates() : platform === 'darwin' ? macCandidates() : linuxCandidates();
  return firstExisting([...envBrowserCandidates(), ...platformCandidates]);
}

/**
 * Parse the real pixel size out of a PNG (IHDR chunk).
 * @param {Buffer|Uint8Array} bytes
 * @returns {{width:number, height:number}|null}
 */
export function parsePngSize(bytes) {
  let buffer;
  try {
    buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes ?? []);
  } catch {
    return null;
  }
  if (buffer.length < 24) return null;
  for (let i = 0; i < PNG_SIGNATURE.length; i += 1) {
    if (buffer[i] !== PNG_SIGNATURE[i]) return null;
  }
  if (buffer.toString('ascii', 12, 16) !== 'IHDR') return null;
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  if (!width || !height) return null;
  return { width, height };
}

/**
 * Spawn a process with file-backed stdio and a hard timeout.
 * @param {{command:string, args:string[], stdoutPath?:string, stderrPath?:string, timeoutMs?:number}} options
 * @returns {Promise<{ok:boolean, code?:number|null, signal?:string|null, timedOut?:boolean, error?:Error}>}
 */
/**
 * Read the rendered height published by the page.
 * @param {string} dom dumped DOM (HTML)
 * @returns {number|null}
 */
export function measureDocumentHeight(dom) {
  const single = /data-render-height\s*=\s*["'](\d+)["']/.exec(dom);
  if (single) {
    const value = Number(single[1]);
    if (Number.isFinite(value) && value > 0) return value;
  }
  return null;
}

function buildCommonArgs(profileDir) {
  return [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--hide-scrollbars',
    '--disable-dev-shm-usage',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--run-all-compositor-stages-before-draw',
    '--default-background-color=ffffffff',
    `--user-data-dir=${profileDir}`,
  ];
}

/**
 * Render an HTML string to a PNG file.
 *
 * A single screenshot pass is used: the viewport height is estimated from the
 * source text, then the blank tail of the PNG is trimmed. (Running a second
 * Chromium pass after `--dump-dom` in the same process hangs on some Windows
 * Edge builds, so measuring through the CLI is deliberately avoided.)
 *
 * @param {Object} options
 * @param {string} options.html complete HTML document
 * @param {number} [options.width] CSS pixels, default 900
 * @param {string} options.outPath absolute PNG path
 * @param {number} [options.scale] device scale factor, default 2
 * @param {string} [options.browserPath] explicit executable
 * @param {number} [options.estimatedHeight] estimated CSS height of the content
 * @returns {Promise<{path:string,width:number,height:number,bytes:number}|null>}
 */
export async function renderHtmlWithBrowser({
  html,
  width = 900,
  outPath,
  scale = 2,
  browserPath,
  estimatedHeight,
  logger,
} = {}) {
  if (typeof html !== 'string' || !html.trim()) return null;
  if (!outPath || typeof outPath !== 'string') return null;

  const executable = browserPath || findBrowserExecutable();
  if (!executable) return null;
  if (Date.now() < retryAfter) return null;

  const scaleFactor = Number.isFinite(Number(scale)) && Number(scale) > 0 ? Number(scale) : 2;
  const cssWidth = Math.max(320, Math.min(2400, Math.round(Number(width) || 900)));
  const requestedHeight = Number.isFinite(Number(estimatedHeight))
    ? Number(estimatedHeight)
    : Math.round(cssWidth * 1.4);
  const firstHeight = Math.max(320, Math.min(12000, Math.round(requestedHeight)));

  const margin = Math.round(20 * scaleFactor);
  const minHeight = Math.round(120 * scaleFactor);
  let tmpDir = null;

  try {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-render-'));
    const htmlPath = path.join(tmpDir, 'page.html');
    await fsp.writeFile(htmlPath, html, 'utf8');
    const url = pathToFileURL(htmlPath).href;

    const attempt = async (cssHeight, suffix, variant) => {
      const shotPath = path.join(tmpDir, `shot-${suffix}.png`);
      const shot = await runProcess({
        command: executable,
        args: [
          ...buildCommonArgs(path.join(tmpDir, `profile-${suffix}`)),
          ...variant,
          `--screenshot=${shotPath}`,
          `--window-size=${cssWidth},${cssHeight}`,
          `--force-device-scale-factor=${scaleFactor}`,
        ],
        stderrPath: path.join(tmpDir, `shot-${suffix}.err`),
        timeoutMs: PROCESS_TIMEOUT_MS,
      });
      if (!shot.ok) {
        logger?.warn?.(
          `[adapter-qq] 无头浏览器截图失败（${suffix}${variant.join(' ')}）: ${shot.timedOut ? 'timeout' : shot.error?.message || `exit ${shot.code}`}`
        );
        return null;
      }

      const png = await fsp.readFile(shotPath).catch(() => null);
      if (!png) {
        logger?.warn?.(`[adapter-qq] 无头浏览器未写出截图文件（${suffix}）`);
        return null;
      }
      const size = parsePngSize(png);
      if (!size) {
        logger?.warn?.(`[adapter-qq] 无头浏览器输出不是有效 PNG（${suffix}）`);
        return null;
      }
      // A uniform capture means the page had not painted yet (or the window
      // stayed blank); reject it so the next variant is tried.
      if (isLikelyBlankPng(png)) {
        logger?.warn?.(`[adapter-qq] 无头浏览器截图为空白（${suffix}${variant.join(' ')}）`);
        return null;
      }

      const trimmed = trimPngBottom(png, { margin, minHeight });
      const finalPng = trimmed?.bytes ?? png;
      const finalSize = trimmed ? { width: trimmed.width, height: trimmed.height } : size;
      return { png: finalPng, width: finalSize.width, height: finalSize.height, clipped: Boolean(trimmed?.clipped) };
    };

    // Some Windows Edge builds hang on one headless mode while another works,
    // and a running desktop Edge can make the first launch flaky: try variants.
    const variants = [
      ['--headless=new', '--virtual-time-budget=3000'],
      ['--headless'],
    ];

    const renderAt = async (height, tag) => {
      for (let i = 0; i < variants.length; i += 1) {
        const rendered = await attempt(height, `${tag}${i}`, variants[i]);
        if (rendered) return rendered;
      }
      return null;
    };

    let rendered = await renderAt(firstHeight, 'a');
    if (rendered && rendered.clipped && firstHeight < 12000) {
      const retry = Math.min(12000, Math.round(firstHeight * 2));
      const second = await renderAt(retry, 'b');
      if (second) rendered = second;
    }
    if (!rendered) {
      retryAfter = Date.now() + RETRY_COOLDOWN_MS;
      return null;
    }

    await fsp.mkdir(path.dirname(outPath), { recursive: true });
    await fsp.writeFile(outPath, rendered.png);
    return { path: outPath, width: rendered.width, height: rendered.height, bytes: rendered.png.length };
  } catch {
    return null;
  } finally {
    if (tmpDir) {
      await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}
