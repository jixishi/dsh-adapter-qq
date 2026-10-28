/**
 * Very cheap layout estimate for the headless screenshot engine.
 *
 * The browser is launched once with an estimated viewport height and the
 * resulting PNG is trimmed afterwards, so this only has to over-estimate
 * reliably (never clip). A safety factor absorbs font-metric differences.
 */

const CJK = /[\u1100-\u115f\u2e80-\u2e99\u2e9b-\u2ef3\u2f00-\u2fd5\u3005\u3007\u3021-\u3029\u3038-\u303b\u3040-\u30ff\u3105-\u312f\u3131-\u318e\u3190-\u31e3\u3400-\u4dbf\u4e00-\u9fff\ua000-\ua48c\ua960-\ua97c\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6]/;

/**
 * Approximate rendered width of one line of text.
 * @param {string} text
 * @returns {number} CSS pixels at a 16px base font
 */
export function displayWidth(text) {
  let width = 0;
  for (const char of String(text ?? '')) {
    width += CJK.test(char) ? 16 : 8.4;
  }
  return width;
}

/**
 * Number of wrapped lines for one paragraph.
 * @param {string} text
 * @param {number} maxWidth
 * @returns {number}
 */
export function wrappedLineCount(text, maxWidth) {
  const width = Math.max(80, Number(maxWidth) || 800);
  const raw = String(text ?? '');
  if (!raw) return 1;
  return Math.max(1, Math.ceil(displayWidth(raw) / width));
}

/**
 * Estimate the full document height (CSS px) for a Markdown body.
 * @param {{bodyText?:string,title?:string,subtitle?:string,width?:number}} options
 * @returns {number}
 */
export function estimateDocumentHeight({ bodyText = '', title = '', subtitle = '', width = 900 } = {}) {
  const cardWidth = Math.max(320, Number(width) || 900);
  const contentWidth = Math.max(180, cardWidth - 72);
  const LINE = 26;

  let height = 56; // card padding and borders
  if (title) height += 52;
  if (subtitle) height += 28;

  const lines = String(bodyText ?? '').split(/\r?\n/);
  let inCode = false;
  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      inCode = !inCode;
      height += 22;
      continue;
    }
    if (inCode) {
      height += 23;
      continue;
    }
    if (/^\s*$/.test(line)) {
      height += 14;
      continue;
    }
    if (/^\s*\|/.test(line)) {
      height += /^\s*\|[\s:|-]+\|\s*$/.test(line) ? 22 : 34;
      continue;
    }
    if (/^\s*#{1,6}\s/.test(line)) {
      const level = /^\s*(#{1,6})/.exec(line)[1].length;
      height += level === 1 ? 46 : level === 2 ? 40 : 34;
      continue;
    }
    if (/^\s*([-*+]|\d+\.)\s/.test(line)) {
      height += wrappedLineCount(line, contentWidth - 28) * LINE + 6;
      continue;
    }
    if (/^\s*>\s?/.test(line)) {
      height += wrappedLineCount(line, contentWidth - 24) * LINE + 10;
      continue;
    }
    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) {
      height += 22;
      continue;
    }
    height += wrappedLineCount(line, contentWidth) * LINE;
  }

  height += 44; // footer and bottom padding
  return Math.max(320, Math.min(12000, Math.round(height * 1.28 + 40)));
}
