import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';

import { runProcess, DEFAULT_PROCESS_TIMEOUT_MS } from '../lib/render/process.js';
import { displayWidth } from '../lib/render/layout.js';
import { defaultOutputDir } from '../lib/render/index.js';
import { collectScheduleTasks, hasTerminalTool } from '../lib/sync/task-overview.js';
import { resetBrowserCooldown } from '../lib/render/browser.js';
import { sanitizePillowText } from '../lib/render/pillow.js';

/**
 * The remaining pure/infrastructure helpers that had no direct test: the
 * child-process wrapper every render engine goes through, the width model the SVG
 * renderer wraps on, the output-directory rule, the terminal capability probe and
 * the Pillow text sanitiser.
 */

function tempDir() {
  return fs.mkdtempSync(join(os.tmpdir(), 'dsh-helpers-'));
}

describe('runProcess', () => {
  it('reports ok and writes stdout to the given file', async () => {
    const dir = tempDir();
    try {
      const stdoutPath = join(dir, 'out.txt');
      const result = await runProcess({
        command: process.execPath,
        args: ['-e', 'process.stdout.write("hello")'],
        stdoutPath,
      });
      assert.equal(result.ok, true);
      assert.equal(result.code, 0);
      assert.equal(fs.readFileSync(stdoutPath, 'utf8'), 'hello');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports a non-zero exit instead of throwing', async () => {
    const result = await runProcess({ command: process.execPath, args: ['-e', 'process.exit(3)'] });
    assert.equal(result.ok, false);
    assert.equal(result.code, 3);
  });

  it('reports a spawn failure with an error', async () => {
    const result = await runProcess({ command: 'definitely-not-a-real-binary-xyz' });
    assert.equal(result.ok, false);
    assert.ok(result.error, 'the spawn error is surfaced');
  });

  it('kills a command that outlives its timeout', async () => {
    const started = Date.now();
    const result = await runProcess({
      command: process.execPath,
      args: ['-e', 'setTimeout(() => {}, 10000)'],
      timeoutMs: 300,
    });
    assert.equal(result.ok, false);
    assert.equal(result.timedOut, true);
    assert.ok(Date.now() - started < 8000, 'it does not wait for the child to finish');
  });

  it('exposes a default timeout', () => {
    assert.equal(typeof DEFAULT_PROCESS_TIMEOUT_MS, 'number');
    assert.ok(DEFAULT_PROCESS_TIMEOUT_MS > 0);
  });
});

describe('displayWidth', () => {
  it('counts a CJK glyph as wider than an ASCII one', () => {
    const ascii = displayWidth('ab');
    const cjk = displayWidth('中文');
    assert.ok(cjk > ascii, 'CJK takes two columns');
    assert.equal(displayWidth(''), 0);
  });

  it('is junk-safe', () => {
    for (const value of [undefined, null, 42]) {
      assert.equal(typeof displayWidth(value), 'number');
    }
  });
});

describe('defaultOutputDir', () => {
  it('honours DSH_HOME and falls back to ~/.dsh', () => {
    const previous = process.env.DSH_HOME;
    try {
      process.env.DSH_HOME = join(os.tmpdir(), 'custom-home');
      assert.equal(defaultOutputDir(), join(os.tmpdir(), 'custom-home', 'adapter-qq', 'renders'));

      delete process.env.DSH_HOME;
      assert.ok(defaultOutputDir().endsWith(join('adapter-qq', 'renders')));
      assert.ok(defaultOutputDir().includes('.dsh'));
    } finally {
      if (previous === undefined) delete process.env.DSH_HOME;
      else process.env.DSH_HOME = previous;
    }
  });
});

describe('hasTerminalTool', () => {
  const toolsWith = (names) => ({
    get: (id) => (names.includes(id) ? { id } : undefined),
  });

  it('detects either terminal tool on the agent context', () => {
    const agentCtx = { get: (name) => (name === 'tools' ? toolsWith(['terminal_send']) : undefined) };
    assert.equal(hasTerminalTool(agentCtx, { id: 'a' }, null), true);
  });

  it('falls back to the host context', () => {
    const hostCtx = { get: (name) => (name === 'tools' ? toolsWith(['terminal_open']) : undefined) };
    assert.equal(hasTerminalTool(null, { id: 'a' }, hostCtx), true);
  });

  it('reports false when the tools are absent or the agent is missing', () => {
    assert.equal(hasTerminalTool(null, { id: 'a' }, null), false);
    assert.equal(hasTerminalTool({ get: () => toolsWith(['terminal_send']) }, null, null), false);
    const emptyCtx = { get: () => toolsWith([]) };
    assert.equal(hasTerminalTool(emptyCtx, { id: 'a' }, null), false);
  });

  it('never throws on a hostile context', () => {
    const hostile = {
      get: () => {
        throw new Error('boom');
      },
    };
    assert.equal(hasTerminalTool(hostile, { id: 'a' }, null), false);
  });
});

describe('sanitizePillowText', () => {
  it('replaces the status emoji the Pillow font cannot draw', () => {
    assert.equal(sanitizePillowText('✅ 完成'), '[OK] 完成');
    assert.equal(sanitizePillowText('❌ 失败'), '[X] 失败');
    assert.ok(sanitizePillowText('⚠️ 注意').startsWith('[!]'));
  });

  it('drops emoji the font has no glyph for', () => {
    assert.equal(sanitizePillowText('测试 🚀 通过'), '测试 通过');
    assert.equal(sanitizePillowText('箭头 → 已处理'), '箭头 已处理');
    // A run of removed glyphs plus surrounding blanks collapses to one space.
    assert.equal(sanitizePillowText('a 🚀🚀🚀 b'), 'a b');
  });

  it('collapses the gaps the removals leave behind', () => {
    assert.equal(sanitizePillowText('a    b'), 'a b');
    assert.equal(sanitizePillowText('trailing   '), 'trailing');
  });

  it('is junk-safe', () => {
    for (const value of [undefined, null, 42]) {
      assert.equal(typeof sanitizePillowText(value), 'string');
    }
  });
});

describe('collectScheduleTasks', () => {
  it('returns null when the schedule service is absent', async () => {
    assert.equal(await collectScheduleTasks({ get: () => undefined }), null);
    assert.equal(await collectScheduleTasks({}), null);
    assert.equal(await collectScheduleTasks(null), null);
  });

  it('returns the catalog as an array', async () => {
    const ctx = { get: (name) => (name === 'schedule' ? { catalog: async () => [{ id: 't1' }] } : undefined) };
    assert.deepEqual(await collectScheduleTasks(ctx), [{ id: 't1' }]);
  });

  it('coerces a non-array catalog to an empty list', async () => {
    const ctx = { get: () => ({ catalog: async () => ({ not: 'an array' }) }) };
    assert.deepEqual(await collectScheduleTasks(ctx), []);
  });

  it('swallows a throwing catalog', async () => {
    const ctx = {
      get: () => ({
        catalog: async () => {
          throw new Error('service down');
        },
      }),
    };
    assert.deepEqual(await collectScheduleTasks(ctx), []);
  });
});

describe('resetBrowserCooldown', () => {
  it('is callable and returns nothing', () => {
    // Exposed so a test or an operator can clear the "browser failed" backoff.
    assert.equal(resetBrowserCooldown(), undefined);
  });
});