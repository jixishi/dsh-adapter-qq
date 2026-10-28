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

import { markdownToHtml, markdownToPlainText } from './markdown.js';
import { buildHtmlDocument } from './html.js';
import { estimateDocumentHeight } from './layout.js';
import { renderHtmlWithBrowser } from './browser.js';
import { renderTextWithTypst } from './typst.js';
import { renderTextWithPillow } from './pillow.js';
import { renderTextAsSvg } from './svg.js';

/** Default output directory (DSH_HOME-aware), shared by the render tool and manual parses. */
export function defaultOutputDir() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  return path.join(home, 'adapter-qq', 'renders');
}

export const DEFAULT_OUTPUT_DIR = defaultOutputDir();

/**
 * Create the output directory, falling back to the OS temp dir when the
 * preferred location is read-only (sandbox, locked profile, etc.).
 * @param {string} dir
 * @param {Object} [logger]
 * @returns {Promise<string>} directory that is actually usable
 */
async function ensureOutputDir(dir, logger) {
  try {
    await fsp.mkdir(dir, { recursive: true });
    return dir;
  } catch (error) {
    const fallback = path.join(os.tmpdir(), 'dsh-adapter-qq-renders');
    logger?.warn?.(`[adapter-qq] 渲染输出目录不可用（${dir}）：${error?.message ?? error}，改用 ${fallback}`);
    await fsp.mkdir(fallback, { recursive: true });
    return fallback;
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
