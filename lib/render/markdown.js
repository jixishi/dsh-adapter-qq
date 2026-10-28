/**
 * Minimal, dependency-free Markdown -> HTML renderer for the QQ adapter.
 *
 * Safety rules (contract section 8):
 * - The source is never treated as raw HTML: `& < > " '` are always escaped.
 * - Links are only emitted when the target is http(s); anything else stays as
 *   plain text.
 * - Unknown syntax is preserved as escaped text.
 */

const HTML_ESCAPES = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/**
 * Escape the HTML-special characters. Must run before any markup is added.
 * @param {unknown} text
 * @returns {string}
 */
export function escapeHtml(text) {
  return String(text ?? '').replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch]);
}

const TOKEN_RE = /\u0000(\d+)\u0000/g;

/**
 * Inline formatting for one already-escaped line.
 * Code spans and links are stashed so later passes cannot touch them.
 * @param {string} raw
 * @returns {string}
 */
function renderInline(raw) {
  let text = escapeHtml(raw);
  /** @type {string[]} */
  const stash = [];
  const keep = (html) => {
    const token = `\u0000${stash.length}\u0000`;
    stash.push(html);
    return token;
  };

  // `inline code`
  text = text.replace(/`([^`\n]+)`/g, (_match, code) => keep(`<code>${code}</code>`));
  // **bold**
  text = text.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  // *italic* (not touching ** runs or standalone asterisks)
  text = text.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>');

  // [label](url) - only http/https survives
  text = text.replace(/\[([^\]\n]*)\]\(([^)\s]+)\)/g, (_match, label, url) => {
    if (!/^https?:\/\//i.test(url)) return _match;
    return keep(`<a href="${url}" target="_blank" rel="noopener noreferrer">${label}</a>`);
  });

  // Restore nested placeholders (a link may contain a code span).
  for (let pass = 0; pass < 8 && /\u0000\d+\u0000/.test(text); pass += 1) {
    text = text.replace(TOKEN_RE, (match, index) => stash[Number(index)] ?? '');
  }
  return text;
}

function isTableRow(trimmed) {
  return /^\|.*\|$/.test(trimmed);
}

function isTableSeparator(trimmed) {
  if (!/^[|\s:-]+$/.test(trimmed)) return false;
  return /-/.test(trimmed) && trimmed.includes('|');
}

function splitTableRow(trimmed) {
  const inner = trimmed.replace(/^\|/, '').replace(/\|$/, '');
  return inner.split('|').map((cell) => cell.trim());
}

function buildTable(header, rows) {
  const head = header.map((cell) => `<th>${renderInline(cell)}</th>`).join('');
  const body = rows
    .map((row) => {
      const cells = [];
      for (let i = 0; i < header.length; i += 1) {
        cells.push(`<td>${renderInline(row[i] ?? '')}</td>`);
      }
      return `<tr>${cells.join('')}</tr>`;
    })
    .join('');
  return `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

/**
 * Convert Markdown (or plain text) into an HTML fragment.
 *
 * Supported: headings 1-6, **bold**, *italic*, `code`, ```fenced code```,
 * `-` bullets, `1.` ordered lists, `>` quotes, `---` rules, [text](http url)
 * and pipe tables. Everything else is escaped plain text.
 *
 * @param {string} markdown
 * @returns {string}
 */
export function markdownToHtml(markdown) {
  const source = String(markdown ?? '').replace(/\r\n?/g, '\n').replace(/\u0000/g, '');
  const lines = source.split('\n');
  /** @type {string[]} */
  const out = [];
  /** @type {string[]} */
  let paragraph = [];

  const flushParagraph = () => {
    if (!paragraph.length) return;
    out.push(`<p>${paragraph.map(renderInline).join('<br>')}</p>`);
    paragraph = [];
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    // Fenced code blocks (must be handled before inline styling).
    if (/^```/.test(trimmed)) {
      flushParagraph();
      const lang = trimmed.slice(3).trim();
      const body = [];
      i += 1;
      while (i < lines.length && !/^```\s*$/.test(lines[i].trim())) {
        body.push(lines[i]);
        i += 1;
      }
      i += 1; // skip closing fence (or run past EOF)
      const safeLang = lang.replace(/[^\w+#.-]/g, '');
      const langClass = safeLang ? ` class="language-${escapeHtml(safeLang)}"` : '';
      out.push(`<pre><code${langClass}>${escapeHtml(body.join('\n'))}</code></pre>`);
      continue;
    }

    // Blank line closes a paragraph.
    if (!trimmed) {
      flushParagraph();
      i += 1;
      continue;
    }

    // Pipe table: header row followed by a separator row.
    if (isTableRow(trimmed) && i + 1 < lines.length && isTableSeparator(lines[i + 1].trim())) {
      flushParagraph();
      const header = splitTableRow(trimmed);
      i += 2;
      const rows = [];
      while (i < lines.length && isTableRow(lines[i].trim())) {
        rows.push(splitTableRow(lines[i].trim()));
        i += 1;
      }
      out.push(buildTable(header, rows));
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(trimmed);
    if (heading) {
      flushParagraph();
      const level = heading[1].length;
      const content = heading[2].replace(/\s+#+\s*$/, '');
      out.push(`<h${level}>${renderInline(content)}</h${level}>`);
      i += 1;
      continue;
    }

    if (/^(?:-{3,}|\*{3,}|_{3,})\s*$/.test(trimmed)) {
      flushParagraph();
      out.push('<hr>');
      i += 1;
      continue;
    }

    if (/^>\s?/.test(line)) {
      flushParagraph();
      const parts = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) {
        const quoteLine = lines[i].replace(/^>\s?/, '').trim();
        if (quoteLine) parts.push(`<p>${renderInline(quoteLine)}</p>`);
        i += 1;
      }
      out.push(`<blockquote>${parts.join('')}</blockquote>`);
      continue;
    }

    if (/^[-*+]\s+/.test(trimmed)) {
      flushParagraph();
      const items = [];
      while (i < lines.length && /^[-*+]\s+/.test(lines[i].trim())) {
        items.push(lines[i].trim().replace(/^[-*+]\s+/, ''));
        i += 1;
      }
      out.push(`<ul>${items.map((item) => `<li>${renderInline(item)}</li>`).join('')}</ul>`);
      continue;
    }

    if (/^\d+[.)]\s+/.test(trimmed)) {
      flushParagraph();
      const items = [];
      while (i < lines.length && /^\d+[.)]\s+/.test(lines[i].trim())) {
        items.push(lines[i].trim().replace(/^\d+[.)]\s+/, ''));
        i += 1;
      }
      out.push(`<ol>${items.map((item) => `<li>${renderInline(item)}</li>`).join('')}</ol>`);
      continue;
    }

    paragraph.push(line);
    i += 1;
  }

  flushParagraph();
  return out.join('\n');
}

/**
 * Convert Markdown to a clean plain-text layout for the Pillow/SVG fallbacks.
 *
 * The fallbacks draw raw text, so syntax markers (`#`, `**`, backticks, table
 * pipes) would otherwise show up literally. Structure hints (bullets, quotes,
 * numbered items, horizontal rules) are kept.
 *
 * @param {string} markdown
 * @returns {string}
 */
export function markdownToPlainText(markdown) {
  const source = String(markdown ?? '').replace(/\r\n?/g, '\n');
  const lines = source.split('\n');
  const out = [];
  let inCode = false;

  for (const raw of lines) {
    const trimmed = raw.trim();

    if (/^```/.test(trimmed)) {
      inCode = !inCode;
      continue;
    }
    if (inCode) {
      out.push(raw);
      continue;
    }
    if (!trimmed) {
      out.push('');
      continue;
    }

    if (/^\s*\|/.test(trimmed)) {
      if (/^\s*\|[\s:|-]+\|\s*$/.test(trimmed)) continue;
      out.push(trimmed.replace(/^\||\|$/g, '').split('|').map((cell) => cell.trim()).join('  '));
      continue;
    }

    let text = trimmed
      .replace(/^#{1,6}\s+/, '')
      .replace(/^>\s?/, '│ ')
      .replace(/^([-*+])\s+/, '• ')
      .replace(/^(\d+)[.)]\s+/, '$1. ');

    text = text
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)')
      .replace(/`([^`]+)`/g, '$1')
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .replace(/__([^_]+)__/g, '$1')
      .replace(/(\*|_)([^*_]+)\1/g, '$2')
      .replace(/~~([^~]+)~~/g, '$1');

    if (/^(?:-{3,}|\*{3,}|_{3,})$/.test(text)) {
      out.push('─'.repeat(24));
      continue;
    }
    out.push(text);
  }

  const collapsed = [];
  let blank = 0;
  for (const line of out) {
    if (!line.trim()) {
      blank += 1;
      if (blank > 1) continue;
    } else {
      blank = 0;
    }
    collapsed.push(line);
  }
  return collapsed.join('\n').trim();
}
