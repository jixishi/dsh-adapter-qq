/**
 * Render orchestration for QQ text images.
 *
 * Engine order (contract section 8):
 *   1. headless browser (markdown -> styled HTML -> real PNG, best looking)
 *   2. Pillow (plain text -> PNG)
 *   3. pure-JS SVG (always available)
 */

import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { markdownToHtml, markdownToPlainText } from './markdown.js';
import { buildHtmlDocument } from './html.js';
import { estimateDocumentHeight } from './layout.js';
import { renderHtmlWithBrowser } from './browser.js';
import { renderTextWithTypst } from './typst.js';
import { renderTextWithPillow } from './pillow.js';
import { renderTextAsSvg } from './svg.js';

const PLUGIN_ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));

/**
 * A render directory inside the plugin's own folder.
 *
 * This is the fallback that actually works in a confined host: the DSH process may
 * sandbox its children to the workspace, so a path under `$DSH_HOME` or `%TEMP%`
 * can be writable for the host yet denied to the spawned renderer (Typst). The
 * package folder is inside the workspace, so a child process can always write
 * there — which is what keeps the card layout from degrading to plain text.
 */
export function pluginOutputDir() {
  return path.join(PLUGIN_ROOT, '.renders');
}

/** Default output directory (DSH_HOME-aware), shared by the render tool and manual parses. */
export function defaultOutputDir() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  return path.join(home, 'adapter-qq', 'renders');
}

export const DEFAULT_OUTPUT_DIR = defaultOutputDir();

/**
 * Pick the directory renders are written to.
 *
 * The configured directory (`$DSH_HOME/adapter-qq/renders` by default) is used
 * whenever it accepts a write — that is the normal case, and it keeps images out
 * of the package. `mkdir` succeeding is not proof of that, though: a directory
 * can exist and still deny file creation, so the probe writes and removes a real
 * file before committing to it.
 *
 * A caller that has measured "denied" from a restricted shell is measuring that
 * shell, not the host: the plugin runs inside DSH, so its own probe is the
 * authority on what the host (and its children) may write.
 *
 * @param {string} dir
 * @param {Object} [logger]
 * @returns {Promise<string>} directory that is actually usable
 */
async function ensureOutputDir(dir, logger) {
  const writable = async (candidate) => {
    try {
      await fsp.mkdir(candidate, { recursive: true });
      const probe = path.join(candidate, `.write-probe-${process.pid}-${randomToken()}`);
      await fsp.writeFile(probe, '');
      await fsp.rm(probe, { force: true });
      return true;
    } catch {
      return false;
    }
  };

  if (await writable(dir)) return dir;

  // Only reached when the configured directory refused a write. A sandboxed
  // child may still not be allowed to create files the host can, so prefer a
  // directory inside the package before falling back to the OS temp dir.
  const local = pluginOutputDir();
  if (await writable(local)) {
    logger?.warn?.(`[adapter-qq] 渲染输出目录不可写（${dir}），改用插件目录 ${local}`);
    void pruneOldRenders(local);
    return local;
  }

  const fallback = path.join(os.tmpdir(), 'dsh-adapter-qq-renders');
  logger?.warn?.(`[adapter-qq] 插件目录也不可写（${local}），改用 ${fallback}`);
  if (await writable(fallback)) return fallback;

  // Last resort: a per-process temp dir. If even that fails, throwing is the
  // honest outcome — silently rendering nothing is worse.
  const lastResort = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-qq-render-'));
  logger?.warn?.(`[adapter-qq] 临时目录也不可写，改用 ${lastResort}`);
  return lastResort;
}

/**
 * Drop renders older than a day from the plugin-local directory.
 *
 * That directory is the fallback that survives a confined host, so it is also the
 * one that can fill up: every overview image lands here and nothing else removes
 * them.
 */
async function pruneOldRenders(dir, maxAgeMs = 24 * 60 * 60 * 1000) {
  try {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    const cutoff = Date.now() - maxAgeMs;
    await Promise.all(
      entries
        .filter((entry) => entry.isFile() && entry.name.startsWith('render-'))
        .map(async (entry) => {
          const full = path.join(dir, entry.name);
          try {
            const stat = await fsp.stat(full);
            if (stat.mtimeMs < cutoff) await fsp.rm(full, { force: true });
          } catch {
            // A file that vanished or is locked is not worth failing a render for.
          }
        }),
    );
  } catch {
    // Pruning is housekeeping: never let it break the render path.
  }
}
function randomToken() {
  return Math.random().toString(36).slice(2, 8);
}

function clampWidth(value, fallback = 900) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return fallback;
  return Math.max(320, Math.min(2400, Math.round(numeric)));
}

function formatStamp(date = new Date()) {
  try {
    return date.toLocaleString('zh-CN', { hour12: false });
  } catch {
    return date.toISOString();
  }
}

/**
 * Render Markdown/plain text into an image file.
 *
 * @param {Object} options
 * @param {string} options.text
 * @param {string} [options.title]
 * @param {string} [options.subtitle]
 * @param {'light'|'dark'} [options.theme]
 * @param {number} [options.width]
 * @param {number} [options.scale]
 * @param {string} [options.outDir]
 * @param {Console|Object} [options.logger]
 * @returns {Promise<{path:string, bytes:number, width:number, height:number,
 *   mediaType:'image/png'|'image/svg+xml', engine:'browser'|'pillow'|'svg'}>}
 */
export async function renderTextImage({
  text = '',
  typstBody = '',
  title = '',
  subtitle = '',
  theme = 'light',
  width = 900,
  scale = 2,
  outDir = '',
  logger = console,
} = {}) {
  const bodyText = String(text ?? '');
  const docTitle = String(title ?? '');
  const docSubtitle = String(subtitle ?? '');
  const safeTheme = theme === 'dark' ? 'dark' : 'light';
  const safeWidth = clampWidth(width);
  const safeScale = Number.isFinite(Number(scale)) ? Math.max(1, Math.min(3, Number(scale))) : 2;

  const outputDir = await ensureOutputDir(outDir ? path.resolve(String(outDir)) : DEFAULT_OUTPUT_DIR, logger);

  const baseName = `render-${Date.now()}-${randomToken()}`;
  const footer = `DSH QQ 适配器 · ${formatStamp()}`;

  // 1) Typst: embedded engine + LXGW Neo XiHei + Noto Color Emoji.
  //    Full-colour emoji and CJK come straight from the bundled fonts, and the
  //    document is laid out and rasterized in one pass.
  try {
    const outPath = path.join(outputDir, `${baseName}.png`);
    const result = await renderTextWithTypst({
      text: bodyText,
      typstBody: String(typstBody ?? ''),
      title: docTitle,
      subtitle: docSubtitle,
      theme: safeTheme,
      width: safeWidth,
      outPath,
      logger,
    });
    if (result) return result;
  } catch (error) {
    logger?.warn?.(`[adapter-qq] Typst 引擎不可用：${error?.message ?? error}`);
  }

  // 2) Headless browser.
  try {
    const bodyHtml = markdownToHtml(bodyText);
    const html = buildHtmlDocument({
      title: docTitle,
      subtitle: docSubtitle,
      bodyHtml,
      theme: safeTheme,
      width: safeWidth,
      footer,
    });
    const outPath = path.join(outputDir, `${baseName}.png`);
    const result = await renderHtmlWithBrowser({
      html,
      width: safeWidth,
      outPath,
      scale: safeScale,
      estimatedHeight: estimateDocumentHeight({
        bodyText,
        title: docTitle,
        subtitle: docSubtitle,
        width: safeWidth,
      }),
      logger,
    });
    if (result) {
      return {
        path: result.path,
        bytes: result.bytes,
        width: result.width,
        height: result.height,
        mediaType: 'image/png',
        engine: 'browser',
      };
    }
  } catch (error) {
    logger?.warn?.(`[adapter-qq] 浏览器渲染不可用：${error?.message ?? error}`);
  }

  // 3) Pillow (styled plain text, no Markdown layout).
  try {
    const outPath = path.join(outputDir, `${baseName}.png`);
    const result = await renderTextWithPillow({
      text: markdownToPlainText(bodyText),
      title: docTitle,
      width: safeWidth,
      outPath,
      theme: safeTheme,
      logger,
    });
    if (result) {
      return {
        path: result.path,
        bytes: result.bytes,
        width: result.width,
        height: result.height,
        mediaType: 'image/png',
        engine: 'pillow',
      };
    }
  } catch (error) {
    logger?.warn?.(`[adapter-qq] Pillow 渲染不可用：${error?.message ?? error}`);
  }

  // 4) Pure-JS SVG: always available.
  const outPath = path.join(outputDir, `${baseName}.svg`);
  const result = await renderTextAsSvg({
    text: markdownToPlainText(bodyText),
    title: docTitle,
    width: safeWidth,
    outPath,
  });
  return {
    path: result.path,
    bytes: result.bytes,
    width: result.width,
    height: result.height,
    mediaType: 'image/svg+xml',
    engine: 'svg',
  };
}