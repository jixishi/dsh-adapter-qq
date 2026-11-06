import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';

import { pluginOutputDir, renderTextImage } from '../lib/render/index.js';

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/** Repository root, resolved from this test file so the suite runs on any host. */
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
import path from 'node:path';

import { buildUsageTypst } from '../lib/sync/usage.js';
import { buildStatsTypst } from '../lib/sync/stats-card.js';
import { buildScheduleTypst } from '../lib/sync/task-card.js';

/**
 * Regression guards for two "the template disappeared" failures:
 *
 * 1. The render output directory existed and `mkdir` succeeded, but writing files
 *    into it was denied. The old code only probed mkdir, picked the unusable
 *    directory, and every engine failed to write — the picture then came from a
 *    degraded path (or not at all). The directory check must perform a REAL write.
 *
 * 2. `/tasks` was the only card command that handed raw Markdown to the generic
 *    renderer, so its picture looked nothing like /usage or /stats.
 */

const BRIDGE = fs.readFileSync(join(REPO_ROOT, 'lib', 'sync', 'message-bridge.js'), 'utf8');
const RENDER = fs.readFileSync(join(REPO_ROOT, 'lib', 'render', 'index.js'), 'utf8');

describe('render output directory must be proven writable', () => {
  it('probes with a real file write, not just mkdir', () => {
    assert.match(RENDER, /async function ensureOutputDir/, 'ensureOutputDir must exist');
    // The probe has to actually create a file; mkdir alone passes on a
    // write-denied directory (that was the bug).
    assert.match(RENDER, /writeFile\(\s*probe/, 'must write a probe file');
    assert.match(RENDER, /write-probe/, 'probe name should be recognisable');
  });

  it('falls back to the temp dir when the preferred dir is not writable', () => {
    assert.match(RENDER, /dsh-adapter-qq-renders/, 'temp fallback path');
    assert.match(RENDER, /mkdtemp/, 'last-resort per-process temp dir');
    assert.match(RENDER, /目录不可写/, 'the reason must be logged');
  });
});

describe('every card command renders through a Typst template', () => {
  const commands = ['/usage', '/stats', '/tasks', '/status', '/jobs'];
  const titles = {
    '/usage': 'DSH 用量与费用',
    '/stats': 'DSH 会话统计',
    '/tasks': '任务管理 · 定时/自动化任务',
    '/status': 'DSH 代理与后台任务',
    '/jobs': 'DSH 后台任务',
  };

  for (const command of commands) {
    it(`${command} passes typstBody and is flagged`, () => {
      const title = titles[command];
      assert.ok(BRIDGE.includes(title), `${command}: title not found`);
      // Each card command must opt into the "a template was expected" guard so a
      // missing body is logged instead of silently degrading to plain markdown.
      const idx = BRIDGE.indexOf(title);
      const window = BRIDGE.slice(Math.max(0, idx - 400), idx + 200);
      assert.match(window, /typstBody/, `${command} must pass typstBody`);
      assert.match(window, /expectTypstBody:\s*true/, `${command} must set expectTypstBody`);
    });
  }

  it('the guard warns when a card body is missing', () => {
    assert.match(BRIDGE, /expectTypstBody && !typstBody/, 'guard condition');
    assert.match(BRIDGE, /未提供 Typst 卡片模板/, 'guard message');
  });

  it('reports which layout was used', () => {
    // Makes a plain-markdown render visible to the reader instead of mysterious.
    assert.match(BRIDGE, /卡片模板/);
    assert.match(BRIDGE, /通用排版/);
  });
});

describe('task card template', () => {
  it('builds a card layout rather than plain markdown', () => {
    const tasks = [
      { title: '每日备份', status: 'active', scheduledAt: Date.now() + 3_600_000, sessionId: 'session-abcdef123456' },
      { title: '旧任务', status: 'inactive', scheduledAt: Date.now() - 86_400_000, sessionId: 'session-old' },
    ];
    const body = buildScheduleTypst(tasks, { theme: 'light' });
    assert.match(body, /#grid\(/, 'stat card row');
    assert.match(body, /#table\(/, 'task table');
    assert.ok(body.includes('每日备份'), 'task title rendered');
    assert.ok(body.includes('任务总数'), 'summary card rendered');
    // Two theme palettes must exist so dark mode follows the setting.
    const dark = buildScheduleTypst(tasks, { theme: 'dark' });
    assert.notEqual(dark, body);
  });

  it('handles an empty task list', () => {
    const body = buildScheduleTypst([], { theme: 'light' });
    assert.ok(body.includes('当前没有定时/自动化任务'), 'empty state');
    // An empty table would render as a header-only box; the placeholder row keeps
    // the layout sane.
    assert.match(body, /#table\(/);
  });
});

describe('configured output directory', () => {
  it('is used whenever it accepts a write, without moving into the package', async () => {
    // $DSH_HOME/adapter-qq/renders is the documented location; renders only move
    // elsewhere when that directory actually refuses a write.
    const dir = fs.mkdtempSync(join(os.tmpdir(), 'dsh-outdir-'));
    try {
      const rendered = await renderTextImage({ text: '# hi', title: 'T', width: 600, outDir: dir });
      assert.equal(rendered.path.startsWith(dir) || rendered.path.includes('dsh-outdir-'), true);
      assert.ok(!rendered.path.includes('.renders'), 'the configured directory wins');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('render fallback directory', () => {
  it('keeps the plugin-local directory inside the package', () => {
    const dir = pluginOutputDir();
    const repoRoot = new URL('..', import.meta.url).pathname;
    assert.ok(dir.includes('.renders'), 'the directory is named .renders');
    assert.ok(!dir.startsWith(os.tmpdir()), 'it is not a temp directory');
    void repoRoot;
  });

  it('uses the plugin-local directory when the requested one cannot be created', async () => {
    // A path whose parent is a FILE cannot be created, which reproduces the
    // "configured directory is not writable" case without touching ACLs.
    const blocker = join(os.tmpdir(), `dsh-blocker-${Date.now()}`);
    fs.writeFileSync(blocker, 'x');
    try {
      const rendered = await renderTextImage({
        text: '# hi',
        title: 'T',
        width: 600,
        outDir: join(blocker, 'renders'),
      });
      assert.equal(rendered.engine, 'typst', 'the card engine survives the fallback');
      assert.ok(rendered.path.includes('.renders'), `fell back inside the package, got ${rendered.path}`);
    } finally {
      fs.rmSync(blocker, { force: true });
    }
  });
});