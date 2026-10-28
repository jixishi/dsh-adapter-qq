/**
 * Full standalone HTML document used by the headless browser engine.
 * The page measures itself and publishes its real height on
 * `<div id="dsh-render-root" data-render-height="NNN">` so the second
 * (`--screenshot`) pass can size the window exactly.
 */

import { escapeHtml } from './markdown.js';

const CJK_STACK = '"Microsoft YaHei", "PingFang SC", "Hiragino Sans GB", "Noto Sans CJK SC", "Source Han Sans SC", "WenQuanYi Micro Hei", sans-serif';
const MONO_STACK = 'Consolas, "Cascadia Mono", "Courier New", monospace';

/**
 * Build the complete HTML document for a rendered text image.
 *
 * @param {Object} options
 * @param {string} [options.title]
 * @param {string} [options.subtitle]
 * @param {string} [options.bodyHtml] already-rendered (escaped) HTML fragment
 * @param {'light'|'dark'} [options.theme]
 * @param {number} [options.width]
 * @param {string} [options.footer]
 * @returns {string}
 */
export function buildHtmlDocument({
  title = '',
  subtitle = '',
  bodyHtml = '',
  theme = 'light',
  width = 900,
  footer = '',
} = {}) {
  const safeWidth = clampWidth(width);
  const safeTheme = theme === 'dark' ? 'dark' : 'light';
  const hasHeader = Boolean(title || subtitle);
  const headerHtml = hasHeader
    ? `<header class="doc-header">${title ? `<h1>${escapeHtml(title)}</h1>` : ''}${subtitle ? `<p class="subtitle">${escapeHtml(subtitle)}</p>` : ''}</header>`
    : '';
  const footerHtml = footer ? `<footer class="doc-footer">${escapeHtml(footer)}</footer>` : '';

  return `<!DOCTYPE html>
<html lang="zh-CN" data-theme="${safeTheme}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title || 'DSH 文本渲染')}</title>
<style>
  :root {
    --page-bg: #eef0f3;
    --card-bg: #ffffff;
    --text: #1c1d21;
    --muted: #666c78;
    --border: #e2e5ea;
    --code-bg: #f2f4f7;
    --accent: #2f6feb;
    --quote-bg: #f6f8fb;
  }
  html[data-theme="dark"] {
    --page-bg: #101216;
    --card-bg: #1b1e24;
    --text: #e8eaed;
    --muted: #a0a6b2;
    --border: #2c313a;
    --code-bg: #23272f;
    --accent: #79a6ff;
    --quote-bg: #22262e;
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body {
    background: var(--page-bg);
    color: var(--text);
    font-family: ${CJK_STACK};
    font-size: 17px;
    line-height: 1.75;
    -webkit-font-smoothing: antialiased;
  }
  #dsh-render-root {
    width: ${safeWidth}px;
    max-width: 100%;
    margin: 0 auto 16px;
    padding: 34px 38px 30px;
    background: var(--card-bg);
    border: 1px solid var(--border);
    border-radius: 16px;
    overflow-wrap: anywhere;
    word-break: break-word;
  }
  .doc-header { margin: 0 0 22px; padding-bottom: 16px; border-bottom: 1px solid var(--border); }
  .doc-header h1 { margin: 0; font-size: 27px; line-height: 1.4; color: var(--text); }
  .doc-header .subtitle { margin: 8px 0 0; color: var(--muted); font-size: 16px; }
  .doc-body > :first-child { margin-top: 0; }
  .doc-body > :last-child { margin-bottom: 0; }
  .doc-body h1, .doc-body h2, .doc-body h3,
  .doc-body h4, .doc-body h5, .doc-body h6 {
    margin: 26px 0 12px; line-height: 1.4; font-weight: 700;
  }
  .doc-body h1 { font-size: 26px; }
  .doc-body h2 { font-size: 23px; }
  .doc-body h3 { font-size: 20px; }
  .doc-body h4 { font-size: 18px; }
  .doc-body h5 { font-size: 17px; }
  .doc-body h6 { font-size: 16px; color: var(--muted); }
  .doc-body p { margin: 12px 0; }
  .doc-body ul, .doc-body ol { margin: 12px 0; padding-left: 26px; }
  .doc-body li { margin: 5px 0; }
  .doc-body a { color: var(--accent); text-decoration: underline; text-underline-offset: 3px; }
  .doc-body strong { font-weight: 700; }
  .doc-body blockquote {
    margin: 14px 0; padding: 8px 18px;
    border-left: 4px solid var(--accent);
    background: var(--quote-bg);
    border-radius: 0 10px 10px 0;
    color: var(--muted);
  }
  .doc-body blockquote p { margin: 0; }
  .doc-body hr { margin: 22px 0; border: 0; border-top: 1px solid var(--border); }
  .doc-body code {
    font-family: ${MONO_STACK};
    font-size: 14px;
    background: var(--code-bg);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 1px 5px;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .doc-body pre {
    margin: 16px 0;
    padding: 16px 18px;
    background: var(--code-bg);
    border: 1px solid var(--border);
    border-radius: 12px;
    overflow-x: auto;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .doc-body pre code {
    display: block;
    padding: 0;
    border: 0;
    background: transparent;
    font-size: 14px;
    line-height: 1.6;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .doc-body table {
    width: 100%;
    margin: 16px 0;
    border-collapse: collapse;
    table-layout: fixed;
    font-size: 15px;
  }
  .doc-body th, .doc-body td {
    border: 1px solid var(--border);
    padding: 8px 10px;
    text-align: left;
    vertical-align: top;
    overflow-wrap: anywhere;
  }
  .doc-body th { background: var(--code-bg); font-weight: 700; }
  .doc-body img { max-width: 100%; height: auto; border-radius: 10px; }
  .doc-footer {
    margin: 26px 0 0;
    padding-top: 14px;
    border-top: 1px solid var(--border);
    color: var(--muted);
    font-size: 13px;
    letter-spacing: 0.02em;
  }
</style>
</head>
<body>
<div id="dsh-render-root" data-render-width="${safeWidth}" data-render-height="0">
${headerHtml}
<main class="doc-body">${bodyHtml}</main>
${footerHtml}
</div>
<script>
(function () {
  function publish() {
    var root = document.getElementById('dsh-render-root');
    if (!root) return;
    var rect = root.getBoundingClientRect();
    var height = Math.ceil(rect.height) + 16;
    root.setAttribute('data-render-height', String(height));
    document.documentElement.setAttribute('data-render-height', String(height));
  }
  function schedule() {
    publish();
    if (document.fonts && document.fonts.ready) {
      document.fonts.ready.then(publish).catch(function () {});
    }
    setTimeout(publish, 120);
  }
  if (document.readyState === 'complete') schedule();
  else window.addEventListener('load', schedule);
  window.addEventListener('resize', publish);
})();
</script>
</body>
</html>
`;
}

function clampWidth(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 900;
  return Math.max(320, Math.min(2400, Math.round(numeric)));
}
