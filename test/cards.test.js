import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { buildAgentStatusTypst, buildJobsTypst } from '../lib/sync/agent-card.js';
import {
  buildStatsMarkdown,
  buildStatsTypst,
  deriveStatsMetrics,
  formatStatsDuration,
  formatStatsTokens,
} from '../lib/sync/stats-card.js';
import { formatAgentStatus, shortSessionId } from '../lib/sync/task-overview.js';

/**
 * Coverage for the card builders behind /status, /jobs and /stats.
 *
 * These were shipped without direct tests: the render-template suite only checks
 * that the bridge hands over a typstBody, so a builder that produced an empty or
 * malformed document would still have passed. They are pure functions, so their
 * layout contract can be pinned cheaply.
 */

const NOW = 1_700_000_000_000;

const overview = {
  main: { title: '插件更新与功能优化任务', cwd: 'W:/proj', agentPreset: 'standard', permission: 'workspace-write' },
  children: [
    { id: 'sess-a', name: 'alice', role: 'teammate', status: '运行中' },
    { id: 'sess-b', name: 'bob', role: 'teammate', status: '空闲' },
  ],
  jobs: [{ label: 'npm test', kind: 'bash', status: 'running', sessionId: 'sess-a' }],
  teamEnabled: true,
  terminalEnabled: true,
};

describe('buildAgentStatusTypst', () => {
  it('renders stat cards plus both sections', () => {
    const body = buildAgentStatusTypst(overview, { theme: 'light', now: NOW });
    assert.match(body, /#grid\(/, 'stat card row');
    assert.match(body, /#table\(/, 'member/job table');
    assert.ok(body.includes('团队成员'), 'team label follows teamEnabled');
    assert.ok(body.includes('alice'), 'member names rendered');
    assert.ok(body.includes('npm test'), 'job label rendered');
  });

  it('labels subagents correctly when Agent Teams is off', () => {
    const body = buildAgentStatusTypst({ ...overview, teamEnabled: false }, { now: NOW });
    assert.ok(body.includes('子代理'));
    assert.ok(!body.includes('团队成员'));
  });

  it('explains a missing persistent terminal instead of showing an empty table', () => {
    const body = buildAgentStatusTypst({ ...overview, terminalEnabled: false }, { now: NOW });
    assert.match(body, /未启用官方持久终端/);
  });

  it('says so when there are no background jobs', () => {
    const body = buildAgentStatusTypst({ ...overview, jobs: [] }, { now: NOW });
    assert.match(body, /当前没有正在运行的后台任务/);
  });

  it('survives an empty overview', () => {
    const body = buildAgentStatusTypst({}, { now: NOW });
    assert.match(body, /#grid\(/);
    assert.doesNotMatch(body, /undefined/);
    assert.doesNotMatch(body, /\[object Object\]/);
  });

  it('changes palette with the theme', () => {
    const light = buildAgentStatusTypst(overview, { theme: 'light', now: NOW });
    const dark = buildAgentStatusTypst(overview, { theme: 'dark', now: NOW });
    assert.notEqual(light, dark);
  });
});

describe('buildJobsTypst', () => {
  it('counts running vs quiet jobs', () => {
    const body = buildJobsTypst(
      [
        { id: 'a', label: 'npm test', kind: 'bash', status: 'running', sessionId: 's1' },
        { id: 'b', label: 'sleep', kind: 'bash', status: 'exited', sessionId: 's1' },
      ],
      { now: NOW },
    );
    assert.match(body, /任务总数/);
    assert.ok(body.includes('npm test'));
    assert.match(body, /#table\(/);
  });

  it('keeps a placeholder row when nothing is running', () => {
    const body = buildJobsTypst([], { now: NOW });
    assert.match(body, /当前没有正在运行的后台任务/);
    assert.match(body, /#table\(/, 'the table still renders so the layout holds');
  });

  it('is junk-safe', () => {
    for (const jobs of [undefined, null, [{}]]) {
      const body = buildJobsTypst(jobs, { now: NOW });
      assert.equal(typeof body, 'string');
      assert.doesNotMatch(body, /undefined/);
    }
  });
});

describe('stats formatters', () => {
  it('formats durations at each magnitude', () => {
    assert.equal(formatStatsDuration(0), '0s');
    assert.equal(formatStatsDuration(-5), '0s');
    assert.equal(formatStatsDuration(1500), '1.5s');
    assert.equal(formatStatsDuration(65_000), '1m 5s');
    assert.equal(formatStatsDuration(3_725_000), '1h 2m');
    assert.equal(formatStatsDuration(undefined), '0s');
  });

  it('formats token counts', () => {
    assert.equal(formatStatsTokens(0), '0');
    assert.equal(formatStatsTokens(999), '999');
    assert.equal(formatStatsTokens(1500), '1.5k');
    assert.equal(formatStatsTokens(2_500_000), '2.5M');
    assert.equal(formatStatsTokens(1_500_000_000), '1.50B');
    assert.equal(formatStatsTokens(null), '0');
  });
});

describe('deriveStatsMetrics', () => {
  const data = {
    title: '插件更新与功能优化任务',
    modelSelection: { provider: 'cpa', model: 'flash' },
    stats: { turns: 12, steps: 45, llmMs: 65_000, toolMs: 12_000, ttftMs: 25_000, ttftSteps: 50, decodeMs: 40_000, decodeTokens: 6000 },
    tokenUsage: {
      totals: { cacheReadTokens: 450_000, uncachedInputTokens: 50_000, cacheWriteTokens: 0, outputTokens: 6000 },
    },
  };

  it('derives the headline numbers', () => {
    const m = deriveStatsMetrics(data);
    assert.equal(m.title, data.title);
    assert.equal(m.model, 'flash');
    assert.equal(m.turns, 12);
    assert.equal(m.steps, 45);
    assert.equal(m.totalInput, 500_000);
  });

  it('computes the cache hit rate only over real input', () => {
    const m = deriveStatsMetrics(data);
    assert.equal(Math.round(m.cacheRate), 90);
  });

  it('computes averages without dividing by zero', () => {
    const m = deriveStatsMetrics(data);
    assert.equal(m.ttftAvg, 0.5); // 25s over 50 steps
    assert.equal(m.decodeSpeed, 150); // 6000 tokens in 40s

    const empty = deriveStatsMetrics({});
    assert.equal(empty.ttftAvg, 0);
    assert.equal(empty.decodeSpeed, 0);
    assert.equal(empty.cacheRate, 0);
    assert.equal(empty.turns, 0);
  });

  it('falls back to the stats payload when tokenUsage is missing', () => {
    const m = deriveStatsMetrics({ stats: { decodeTokens: 1234 } });
    assert.equal(m.output, 1234);
  });

  it('is junk-safe', () => {
    for (const input of [undefined, null, {}, { stats: null, tokenUsage: null }]) {
      const m = deriveStatsMetrics(input);
      assert.equal(typeof m.turns, 'number');
      assert.equal(Number.isNaN(m.cacheRate), false);
    }
  });
});

describe('stats documents', () => {
  it('builds a card and a markdown summary from the same data', () => {
    const data = {
      title: '会话',
      modelSelection: { provider: 'cpa', model: 'flash' },
      stats: { turns: 3, steps: 9, llmMs: 5000, toolMs: 1000 },
      tokenUsage: { totals: { cacheReadTokens: 1000, uncachedInputTokens: 1000, outputTokens: 500 } },
    };
    const typst = buildStatsTypst(data, { theme: 'light' });
    const md = buildStatsMarkdown(data);
    assert.match(typst, /#grid\(/);
    assert.ok(md.length > 0);
    assert.equal(typeof md, 'string');
    // Neither may leak undefined into what the user reads.
    assert.doesNotMatch(typst, /undefined/);
    assert.doesNotMatch(md, /undefined/);
  });
});

describe('task-overview helpers', () => {
  it('maps agent statuses to Chinese labels', () => {
    for (const status of ['running', 'idle', 'inactive', 'unknown-status']) {
      const label = formatAgentStatus(status);
      assert.equal(typeof label, 'string');
      assert.ok(label.length > 0);
    }
    assert.notEqual(formatAgentStatus('running'), formatAgentStatus('idle'));
  });

  it('shortens a session id but keeps a short one intact', () => {
    const long = 'session-abcdefghijklmnopqrstuvwxyz';
    const short = shortSessionId(long);
    assert.ok(short.length < long.length, 'long ids are elided');
    assert.ok(!short.startsWith('session-'), 'the session- prefix is dropped');
    assert.equal(shortSessionId('abc'), 'abc');
    // A missing id renders as a dash placeholder rather than an empty cell.
    assert.equal(shortSessionId(''), '-');
    assert.equal(shortSessionId(undefined), '-');
  });
});
