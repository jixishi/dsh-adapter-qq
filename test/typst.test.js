import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  buildTypstDocument,
  markdownToTypst,
  renderInlineTypst,
  renderTextWithTypst,
  resolveTypstAssets,
} from '../lib/render/typst.js';

describe('Typst markdown conversion', () => {
  it('escapes Typst markup characters in plain text', () => {
    const out = renderInlineTypst('a#b$c[d]*e*');
    assert.ok(out.includes('\\#'));
    assert.ok(out.includes('\\$'));
    assert.ok(out.includes('\\['));
    assert.ok(out.includes('\\]'));
  });

  it('converts bold, italic, inline code, strike and links', () => {
    assert.equal(renderInlineTypst('**粗**'), '*粗*');
    assert.equal(renderInlineTypst('*斜*'), '_斜_');
    assert.equal(renderInlineTypst('~~删~~'), '#strike[删]');
    assert.ok(renderInlineTypst('`code`').startsWith('#raw("code")'));
    assert.ok(renderInlineTypst('[站](https://example.com)').includes('#link("https://example.com")'));
  });

  it('converts headings, lists, quotes, tables and fenced code', () => {
    assert.equal(markdownToTypst('# 标题'), '= 标题');
    assert.ok(markdownToTypst('## 二级').startsWith('== 二级'));
    assert.equal(markdownToTypst('- 一\n- 二'), '- 一\n- 二');
    assert.equal(markdownToTypst('1. 一\n2. 二'), '+ 一\n+ 二');
    assert.ok(markdownToTypst('> 引用').startsWith('#quote(block: true)['));

    const table = markdownToTypst('| A | B |\n| --- | --- |\n| 1 | 2 |');
    assert.ok(table.includes('#table(columns: 2'));
    assert.ok(table.includes('table.header([A], [B])'));
    assert.ok(table.includes('[1], [2]'));

    const code = markdownToTypst('```js\nconst a = 1;\n```');
    assert.ok(code.startsWith('```js'));
    assert.ok(code.includes('const a = 1;'));
  });

  it('builds a document with the bundled fonts and pt units', () => {
    const doc = buildTypstDocument({ body: '正文 ✅ 🍎', title: '标题', width: 900, theme: 'dark' });
    assert.ok(doc.includes('LXGW Neo XiHei'));
    assert.ok(doc.includes('Noto Color Emoji'));
    assert.ok(doc.includes('width: 675.00pt'));
    assert.ok(!/\dpx/.test(doc));
    assert.ok(doc.includes('rgb("#15171c")'));
  });
});

describe('Typst engine rendering', () => {
  it('resolves the embedded binary and font packages', () => {
    const assets = resolveTypstAssets();
    assert.ok(assets, 'typst binary and font packages must be installed');
    assert.ok(assets.typstPath.toLowerCase().endsWith('typst.exe') || assets.typstPath.toLowerCase().endsWith('typst'));
    assert.equal(assets.fontDirs.length, 2);
  });

  it('renders CJK plus colour emoji to a 2x PNG', async (t) => {
    if (!resolveTypstAssets()) {
      t.skip('typst binary or fonts unavailable');
      return;
    }
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-typst-test-'));
    const outPath = path.join(dir, 'card.png');
    try {
      const started = Date.now();
      const result = await renderTextWithTypst({
        text: '# 标题\n\n中文 **加粗** 与全彩 Emoji：🍎 ✅ 😀\n\n| A | B |\n| --- | --- |\n| 1 | 2 |',
        title: 'Typst 测试',
        width: 900,
        theme: 'light',
        outPath,
        logger: { warn() {} },
      });
      assert.ok(result, 'renderTextWithTypst should return a result');
      assert.equal(result.engine, 'typst');
      assert.equal(result.mediaType, 'image/png');
      assert.equal(result.width, 1800);
      assert.ok(result.height > 200);
      assert.ok(result.bytes > 5000);
      assert.ok(Date.now() - started < 10000);

      const buffer = await fsp.readFile(outPath);
      assert.deepEqual([...buffer.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      assert.equal(buffer.readUInt32BE(16), result.width);
      assert.equal(buffer.readUInt32BE(20), result.height);
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });
});
