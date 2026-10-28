import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { markdownToHtml, markdownToPlainText, escapeHtml } from '../lib/render/markdown.js';
import { buildHtmlDocument } from '../lib/render/html.js';
import { findBrowserExecutable, renderHtmlWithBrowser, parsePngSize, measureDocumentHeight } from '../lib/render/browser.js';
import { renderTextWithPillow } from '../lib/render/pillow.js';
import { renderTextAsSvg } from '../lib/render/svg.js';
import { renderTextImage } from '../lib/render/index.js';
import { decodePng, encodePng, isLikelyBlankPng, trimPngBottom } from '../lib/render/png.js';
import { estimateDocumentHeight, wrappedLineCount } from '../lib/render/layout.js';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

async function makeTempDir(prefix = 'dsh-render-test-') {
  return fsp.mkdtemp(path.join(os.tmpdir(), prefix));
}

function syntheticPngHeader(width, height) {
  const buffer = Buffer.alloc(33);
  PNG_SIGNATURE.copy(buffer, 0);
  buffer.writeUInt32BE(13, 8);
  Buffer.from('IHDR', 'ascii').copy(buffer, 12);
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  buffer[24] = 8;
  buffer[25] = 6;
  return buffer;
}

/** Asserts the file looks like a real PNG and returns {width,height} from IHDR. */
function assertPngFile(buffer, label) {
  assert.ok(buffer.length > 8, `${label} 应非空`);
  assert.deepEqual([...buffer.subarray(0, 8)], [...PNG_SIGNATURE], `${label} 应有 PNG 魔数`);
  const size = parsePngSize(buffer);
  assert.ok(size, `${label} 应有可解析的 IHDR`);
  assert.ok(size.width > 0 && size.height > 0, `${label} 宽高应大于 0`);
  return size;
}

describe('markdownToHtml', () => {
  it('escapes HTML special characters and never emits raw tags', () => {
    assert.equal(escapeHtml('<script>"a" & \'b\'</script>'), '&lt;script&gt;&quot;a&quot; &amp; &#39;b&#39;&lt;/script&gt;');

    const html = markdownToHtml('<script>alert("x")</script>');
    assert.ok(!html.includes('<script'), '不得输出 <script 标签');
    assert.ok(html.includes('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;'));
    assert.ok(html.startsWith('<p>'));
  });

  it('renders headings h1-h6', () => {
    assert.equal(markdownToHtml('# 一级标题'), '<h1>一级标题</h1>');
    assert.equal(markdownToHtml('## 二级'), '<h2>二级</h2>');
    assert.equal(markdownToHtml('###### 六级'), '<h6>六级</h6>');
    assert.ok(markdownToHtml('####### 不是标题').includes('<p>####### 不是标题</p>'));
  });

  it('renders bold, italic and inline code', () => {
    const html = markdownToHtml('文字 **加粗** 与 *斜体* 以及 `code`');
    assert.ok(html.includes('<strong>加粗</strong>'));
    assert.ok(html.includes('<em>斜体</em>'));
    assert.ok(html.includes('<code>code</code>'));
  });

  it('renders fenced code blocks with language and escaping', () => {
    const html = markdownToHtml('```js\nconst a = 1 < 2 && true;\n```');
    assert.equal(html, '<pre><code class="language-js">const a = 1 &lt; 2 &amp;&amp; true;</code></pre>');
    assert.ok(!html.includes('<strong>'), '代码块内不应做行内格式');
    assert.ok(markdownToHtml('```\nplain\n```').includes('<pre><code>plain</code></pre>'));
  });

  it('renders unordered and ordered lists', () => {
    assert.equal(markdownToHtml('- 一\n- 二'), '<ul><li>一</li><li>二</li></ul>');
    assert.equal(markdownToHtml('1. 甲\n2. 乙'), '<ol><li>甲</li><li>乙</li></ol>');
  });

  it('renders blockquotes, rules and paragraphs with line breaks', () => {
    assert.equal(markdownToHtml('> 引用'), '<blockquote><p>引用</p></blockquote>');
    assert.equal(markdownToHtml('---'), '<hr>');
    assert.equal(markdownToHtml('第一行\n第二行'), '<p>第一行<br>第二行</p>');
    assert.equal(markdownToHtml('段落一\n\n段落二'), '<p>段落一</p>\n<p>段落二</p>');
  });

  it('renders pipe tables', () => {
    const html = markdownToHtml('| 名称 | 数量 |\n| --- | --- |\n| 苹果 | 2 |\n| 梨 | 3 |');
    assert.equal(
      html,
      '<table><thead><tr><th>名称</th><th>数量</th></tr></thead><tbody>'
        + '<tr><td>苹果</td><td>2</td></tr><tr><td>梨</td><td>3</td></tr></tbody></table>',
    );
  });

  it('allows only http/https links', () => {
    const safe = markdownToHtml('[官网](https://example.com/a?b=1&c=2)');
    assert.ok(safe.includes('<a href="https://example.com/a?b=1&amp;c=2"'));
    assert.ok(safe.includes('>官网</a>'));

    for (const unsafe of ['[x](javascript:alert(1))', '[x](data:text/html,hi)', '[x](file:///C:/secret)']) {
      const html = markdownToHtml(unsafe);
      assert.ok(!html.includes('<a '), `不应生成链接：${unsafe}`);
      assert.ok(!/href=/i.test(html));
    }
  });

  it('keeps unknown syntax as plain escaped text', () => {
    const html = markdownToHtml('~~删除线~~ 与 [无括号] 和 & < >');
    assert.ok(html.includes('~~删除线~~'));
    assert.ok(html.includes('&amp; &lt; &gt;'));
  });

  it('handles empty input', () => {
    assert.equal(markdownToHtml(''), '');
    assert.equal(markdownToHtml(null), '');
  });
});

describe('buildHtmlDocument', () => {
  const doc = buildHtmlDocument({
    title: '标题 <b>',
    subtitle: '副标题',
    bodyHtml: '<p>正文</p>',
    theme: 'light',
    width: 900,
    footer: '页脚文字',
  });

  it('returns a complete HTML document', () => {
    assert.ok(doc.startsWith('<!DOCTYPE html>'));
    assert.ok(doc.includes('<html lang="zh-CN"'));
    assert.ok(doc.includes('</html>'));
    assert.ok(doc.includes('<meta charset="utf-8">'));
  });

  it('contains the render root with width/height data attributes', () => {
    assert.ok(doc.includes('id="dsh-render-root"'));
    assert.ok(doc.includes('data-render-width="900"'));
    assert.ok(doc.includes('data-render-height="0"'), '初始高度占位需存在');
    assert.ok(doc.includes('setAttribute(\'data-render-height\''), '必须有内联测量脚本');
  });

  it('uses Chinese-friendly fonts, monospace code and wrapping', () => {
    assert.ok(doc.includes('"Microsoft YaHei"'));
    assert.ok(doc.includes('"PingFang SC"'));
    assert.ok(doc.includes('Consolas'));
    assert.ok(doc.includes('overflow-wrap: anywhere'));
    assert.ok(doc.includes('body {\n    background'), 'body 样式应存在');
    assert.ok(doc.includes('margin: 0;'));
  });

  it('escapes title/subtitle/footer and keeps body html', () => {
    assert.ok(doc.includes('标题 &lt;b&gt;'));
    assert.ok(!doc.includes('<h1>标题 <b>'));
    assert.ok(doc.includes('<p>正文</p>'));
    assert.ok(doc.includes('页脚文字'));
  });

  it('supports the dark theme and clamps the width', () => {
    const dark = buildHtmlDocument({ bodyHtml: '<p>x</p>', theme: 'dark', width: 10 });
    assert.ok(dark.includes('data-theme="dark"'));
    assert.ok(dark.includes('data-render-width="320"'), '宽度应被夹取到最小值');
    const wide = buildHtmlDocument({ bodyHtml: '<p>x</p>', width: 99999 });
    assert.ok(wide.includes('data-render-width="2400"'));
  });
});

describe('findBrowserExecutable / parsePngSize', () => {
  it('returns null or an existing absolute file path', () => {
    const found = findBrowserExecutable();
    if (found === null) return;
    assert.equal(typeof found, 'string');
    assert.ok(path.isAbsolute(found), '应为绝对路径');
    assert.ok(fs.existsSync(found), '返回路径必须存在');
  });

  it('prefers the QQ_ADAPTER_BROWSER override', async () => {
    const dir = await makeTempDir();
    const fake = path.join(dir, 'fake-browser');
    await fsp.writeFile(fake, '');
    const previous = process.env.QQ_ADAPTER_BROWSER;
    process.env.QQ_ADAPTER_BROWSER = fake;
    try {
      assert.equal(findBrowserExecutable(), fake);
    } finally {
      if (previous === undefined) delete process.env.QQ_ADAPTER_BROWSER;
      else process.env.QQ_ADAPTER_BROWSER = previous;
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  it('parses real PNG dimensions from the IHDR chunk', () => {
    assert.deepEqual(parsePngSize(syntheticPngHeader(1200, 640)), { width: 1200, height: 640 });
    assert.equal(parsePngSize(Buffer.from('not a png')), null);
    assert.equal(parsePngSize(Buffer.alloc(0)), null);
    assert.equal(parsePngSize(syntheticPngHeader(0, 10)), null);
  });

  it('reads the measured height out of the dumped DOM', () => {
    const dom = '<html data-render-height="880"><body><div id="dsh-render-root" data-render-width="900" data-render-height="864">正文</div></body></html>';
    assert.equal(measureDocumentHeight(dom), 880);
    assert.equal(
      measureDocumentHeight('<div id="dsh-render-root" data-render-height="1234">x</div>'),
      1234,
    );
    assert.equal(measureDocumentHeight('<div data-render-height="42"></div>'), 42);
    assert.equal(measureDocumentHeight('<div id="dsh-render-root">x</div>'), null);
    assert.equal(measureDocumentHeight(''), null);
  });

  it('returns null for missing arguments', async () => {
    assert.equal(await renderHtmlWithBrowser({ html: '', outPath: path.join(os.tmpdir(), 'x.png') }), null);
    assert.equal(await renderHtmlWithBrowser({ html: '<p>x</p>' }), null);
    assert.equal(await renderHtmlWithBrowser({}), null);
  });
});

describe('renderTextAsSvg', () => {
  it('writes an escaped SVG with one text element per line', async () => {
    const dir = await makeTempDir();
    const outPath = path.join(dir, 'out.svg');
    try {
      const result = await renderTextAsSvg({
        text: '第一行\n第二行 & <tag>',
        title: '标题 & 说明',
        width: 900,
        outPath,
      });
      assert.equal(result.path, outPath);
      const svg = await fsp.readFile(outPath, 'utf8');
      assert.ok(svg.startsWith('<svg'));
      assert.ok(svg.includes('viewBox="0 0 900 '));
      assert.ok(svg.includes('&amp;'));
      assert.ok(svg.includes('&lt;tag&gt;'));
      assert.ok(!svg.includes('<tag>'), '原文标签必须被转义');
      const textCount = (svg.match(/<text /g) ?? []).length;
      assert.ok(textCount >= 3, `应至少包含标题与两行正文，实际 ${textCount}`);
      assert.match(svg, /width="900" height="\d+"/);
      const heightMatch = /height="(\d+)"/.exec(svg);
      assert.equal(Number(heightMatch[1]), result.height);
      assert.equal(result.width, 900);
      assert.ok(result.bytes > 0);
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  it('wraps long lines instead of exceeding the width', async () => {
    const dir = await makeTempDir();
    const outPath = path.join(dir, 'wrap.svg');
    try {
      const result = await renderTextAsSvg({ text: '汉'.repeat(200), width: 480, outPath });
      const svg = await fsp.readFile(outPath, 'utf8');
      const textCount = (svg.match(/<text /g) ?? []).length;
      assert.ok(textCount > 1, '长文本应换行');
      assert.ok(result.height > 200);
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });
});

describe('renderTextImage orchestration', () => {
  it('returns a real image file with a consistent engine/mediaType', async () => {
    const dir = await makeTempDir();
    try {
      const result = await renderTextImage({
        text: '# 标题\n\n这是 **测试** 内容，包含 `code`。',
        title: '渲染测试',
        theme: 'light',
        width: 720,
        outDir: dir,
        logger: { warn() {} },
      });
      assert.ok(['typst', 'browser', 'pillow', 'svg'].includes(result.engine));
      assert.ok(['image/png', 'image/svg+xml'].includes(result.mediaType));
      assert.equal(path.dirname(result.path), dir);
      assert.ok(result.width > 0 && result.height > 0);
      assert.ok(result.bytes > 0);

      const buffer = await fsp.readFile(result.path);
      assert.equal(buffer.length, result.bytes);
      if (result.mediaType === 'image/png') {
        assert.ok(result.path.endsWith('.png'));
        assert.deepEqual(assertPngFile(buffer, 'renderTextImage'), {
          width: result.width,
          height: result.height,
        });
      } else {
        assert.ok(result.path.endsWith('.svg'));
        assert.ok(buffer.toString('utf8').startsWith('<svg'));
      }
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });
});

describe('headless browser rendering', () => {
  const browser = findBrowserExecutable();

  it('renders a real PNG from HTML', async (t) => {
    if (!browser) {
      t.skip('未找到 Chromium/Edge 可执行文件');
      return;
    }
    const dir = await makeTempDir();
    const outPath = path.join(dir, 'shot.png');
    try {
      const html = buildHtmlDocument({
        title: '浏览器渲染测试',
        bodyHtml: markdownToHtml('# 标题\n\n正文 **加粗**\n\n```js\nconst a = 1;\n```\n\n| a | b |\n| --- | --- |\n| 1 | 2 |'),
        width: 720,
        theme: 'light',
        footer: '页脚',
      });
      const result = await renderHtmlWithBrowser({ html, width: 720, outPath, scale: 2 });
      if (!result) {
        // A browser binary exists but cannot run here (e.g. a sandbox blocking
        // Chromium's mojo channels). Report it as a skip, not a failure.
        t.skip('浏览器可执行文件存在，但当前环境无法运行无头渲染');
        return;
      }
      const buffer = await fsp.readFile(outPath);
      const size = assertPngFile(buffer, '浏览器截图');
      assert.equal(size.width, result.width);
      assert.equal(size.height, result.height);
      assert.equal(result.bytes, buffer.length);
      assert.ok(size.width >= 720, `宽度应不小于 720，实际 ${size.width}`);
      assert.ok(size.height > 100);
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  it('returns null instead of throwing for a bad browser path', async () => {
    const dir = await makeTempDir();
    try {
      const result = await renderHtmlWithBrowser({
        html: buildHtmlDocument({ bodyHtml: '<p>x</p>' }),
        outPath: path.join(dir, 'nope.png'),
        browserPath: path.join(dir, 'missing-browser'),
      });
      assert.equal(result, null);
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });
});

describe('Pillow rendering', () => {
  it('renders a PNG or reports unavailability', async (t) => {
    const dir = await makeTempDir();
    try {
      const outPath = path.join(dir, 'pillow.png');
      let result = null;
      try {
        result = await renderTextWithPillow({
          text: '第一行\n第二行 【Pillow 测试】',
          title: 'Pillow',
          width: 600,
          outPath,
          theme: 'light',
          logger: { warn() {} },
        });
      } catch {
        result = null;
      }
      if (!result) {
        t.skip('未找到可用的 Python + Pillow');
        return;
      }
      const buffer = await fsp.readFile(outPath);
      const size = assertPngFile(buffer, 'Pillow 输出');
      assert.deepEqual(size, { width: result.width, height: result.height });
      assert.equal(result.bytes, buffer.length);
      assert.ok(result.width >= 600);
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });
});

describe('markdownToPlainText', () => {
  it('strips Markdown syntax while keeping structure hints', () => {
    const plain = markdownToPlainText(
      '# 标题\n\n**粗体** 与 `代码`\n\n- 项目一\n1. 第一\n\n> 引用\n\n---\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n\n[链接](https://example.com)'
    );
    assert.ok(!plain.includes('#'));
    assert.ok(!plain.includes('**'));
    assert.ok(!plain.includes('`'));
    assert.ok(!plain.includes('| --- |'));
    assert.ok(plain.includes('标题'));
    assert.ok(plain.includes('• 项目一'));
    assert.ok(plain.includes('1. 第一'));
    assert.ok(plain.includes('│ 引用'));
    assert.ok(plain.includes('a  b'));
    assert.ok(plain.includes('链接 (https://example.com)'));
  });

  it('keeps fenced code content and collapses extra blank lines', () => {
    const plain = markdownToPlainText('```js\nconst a = 1;\n```\n\n\n\n结束');
    assert.ok(plain.includes('const a = 1;'));
    assert.ok(!plain.includes('```'));
    assert.ok(!plain.includes('\n\n\n'));
  });
});

describe('render/layout height estimate', () => {
  it('grows with content and stays within clamp bounds', () => {
    const short = estimateDocumentHeight({ bodyText: 'hi', title: 'T', width: 900 });
    const long = estimateDocumentHeight({ bodyText: '中文内容\n'.repeat(200), width: 900 });
    assert.ok(short >= 320);
    assert.ok(long > short);
    assert.ok(long <= 12000);
    assert.ok(wrappedLineCount('a'.repeat(400), 200) >= 2);
  });
});

describe('render/png trim', () => {
  function makeImage(width, height, contentRows) {
    const data = Buffer.alloc(width * height * 3, 255);
    for (let y = 0; y < contentRows; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const p = (y * width + x) * 3;
        data[p] = 20;
        data[p + 1] = 20;
        data[p + 2] = 20;
      }
    }
    return { width, height, colorType: 2, channels: 3, data };
  }

  it('round-trips RGB pixels through encode/decode', () => {
    const image = makeImage(16, 40, 10);
    const decoded = decodePng(encodePng(image));
    assert.ok(decoded);
    assert.equal(decoded.width, 16);
    assert.equal(decoded.height, 40);
    assert.equal(decoded.data[0], 20);
    assert.equal(decoded.data[(39 * 16 + 15) * 3], 255);
  });

  it('trims the uniform tail and keeps a margin', () => {
    const image = makeImage(24, 200, 60);
    const trimmed = trimPngBottom(encodePng(image), { margin: 20, minHeight: 100 });
    assert.ok(trimmed);
    assert.equal(trimmed.trimmed, true);
    assert.equal(trimmed.clipped, false);
    assert.ok(trimmed.height >= 80 && trimmed.height < 200);
    assert.equal(trimmed.width, 24);
  });

  it('reports clipping when content reaches the last row', () => {
    const width = 24;
    const height = 80;
    const data = Buffer.alloc(width * height * 3, 255);
    // Only the bottom rows carry content, so the dominant background stays white.
    for (let y = 60; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const p = (y * width + x) * 3;
        data[p] = 20;
        data[p + 1] = 20;
        data[p + 2] = 20;
      }
    }
    const trimmed = trimPngBottom(encodePng({ width, height, colorType: 2, channels: 3, data }), {
      margin: 20,
      minHeight: 100,
    });
    assert.ok(trimmed);
    assert.equal(trimmed.clipped, true);
  });

  it('returns null for non-PNG input', () => {
    assert.equal(decodePng(Buffer.from('nope')), null);
    assert.equal(trimPngBottom(Buffer.from('nope')), null);
    assert.equal(isLikelyBlankPng(Buffer.from('nope')), true);
  });

  it('detects a uniformly painted screenshot as blank', () => {
    const uniform = Buffer.alloc(40 * 40 * 3, 255);
    assert.equal(isLikelyBlankPng(encodePng({ width: 40, height: 40, colorType: 2, channels: 3, data: uniform })), true);
    const withContent = makeImage(40, 40, 12);
    assert.equal(isLikelyBlankPng(encodePng(withContent)), false);
  });
});
