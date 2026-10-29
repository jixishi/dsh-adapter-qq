import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildAgentStatusMarkdown,
  buildJobsMarkdown,
  buildScheduleMarkdown,
  collectAgentOverview,
  describeScheduleRule,
  formatDuration,
  formatDateTime,
} from '../lib/sync/task-overview.js';

const sessionManager = {
  async getActiveSessionInfo() {
    return {
      sessionId: 'sess-main',
      title: '主会话',
      cwd: 'W:/work/app',
      agentPreset: 'standard',
      permission: 'workspace-write',
      running: true,
    };
  },
  async getModelCatalog() {
    return { current: { model: 'deepseek-v4', provider: 'gateway', reasoningEffort: 'high' } };
  },
};

function fakeCtx({ team, terminal = true, children = [], jobs = {}, agents = {} }) {
  const services = {
    agents: { get: (id) => agents[id] },
    subagents: { listChildren: async () => children },
    jobs: { list: (sessionId) => jobs[sessionId] || [] },
    terminals: terminal ? { list: () => [] } : undefined,
    agentTeams: team
      ? {
          listMembers: () => team,
        }
      : undefined,
  };
  return { get: (name) => services[name] };
}

describe('task overview formatting', () => {
  it('formats durations and date-times', () => {
    assert.equal(formatDuration(5000), '5s');
    assert.equal(formatDuration(65000), '1m 5s');
    assert.equal(formatDuration(3723000), '1h 2m');
    assert.equal(formatDateTime(0).length > 0, true);
    assert.equal(formatDateTime(null), '-');
  });

  it('describes every schedule rule kind', () => {
    assert.ok(describeScheduleRule({ kind: 'at', scheduledAt: '2026-10-30T01:00:00.000Z' }).startsWith('单次'));
    assert.equal(describeScheduleRule({ kind: 'every', everySeconds: 90 }), '每 1m 30s');
    assert.equal(describeScheduleRule({ kind: 'daily', time: '08:00:00', timeZone: 'Asia/Shanghai' }), '每日 08:00:00 (Asia/Shanghai)');
    assert.equal(
      describeScheduleRule({ kind: 'weekly', weekdays: [1, 3], time: '09:30:00' }),
      '每周 一、三 09:30:00'
    );
    assert.equal(describeScheduleRule({ kind: 'cron', expression: '*/15 9-17 * * 1-5' }), 'Cron */15 9-17 * * 1-5');
  });

  it('builds the schedule table with status and rule columns', () => {
    const markdown = buildScheduleMarkdown([
      { id: 't1', title: '每日巡检', kind: 'daily', time: '09:00:00', status: 'active', sessionId: 'sess-1', scheduledAt: '2026-10-30T01:00:00.000Z' },
      { id: 't2', title: '一次性提醒', kind: 'at', status: 'inactive', sessionId: 'sess-1', scheduledAt: '2026-10-29T01:00:00.000Z' },
    ]);
    assert.ok(markdown.includes('共 2 个任务（启用 1，已结束 1）'));
    assert.ok(markdown.includes('每日巡检'));
    assert.ok(markdown.includes('每日 09:00:00'));
    assert.ok(markdown.includes('已结束'));
  });

  it('builds the team status document with jobs', () => {
    const markdown = buildAgentStatusMarkdown({
      main: {
        sessionId: 'sess-main',
        title: '主会话',
        status: '🔄 运行中',
        model: 'deepseek-v4',
        provider: 'gateway',
        preset: '标准模式',
        permission: '工作区写入',
        cwd: 'W:/work/app',
      },
      children: [{ id: 'sess-a', name: 'alice', role: 'teammate', status: '🔄 运行中' }],
      jobs: [{ id: 'bash-1', label: 'npm test', kind: 'bash', status: 'running', startedAt: Date.now() - 5000 }],
      teamEnabled: true,
      terminalEnabled: true,
    });
    assert.ok(markdown.includes('团队成员（1）'));
    assert.ok(markdown.includes('alice'));
    assert.ok(markdown.includes('成员'));
    assert.ok(markdown.includes('npm test'));
    assert.ok(markdown.includes('运行中'));
  });

  it('explains a missing persistent terminal', () => {
    const markdown = buildAgentStatusMarkdown({ main: { title: 'x' }, children: [], jobs: [], terminalEnabled: false });
    assert.ok(markdown.includes('未启用官方持久终端'));
    assert.ok(markdown.includes('子代理（0）'));
  });

  it('builds a jobs-only document', () => {
    const markdown = buildJobsMarkdown([
      { id: 'bash-1', label: 'sleep 10', kind: 'bash', status: 'stopping', startedAt: Date.now() - 1000, progress: 'stopping' },
    ]);
    assert.ok(markdown.includes('sleep 10'));
    assert.ok(markdown.includes('停止中'));
  });
});

describe('collectAgentOverview capability gating', () => {
  it('uses the official Agent Teams roster and enabled terminal jobs', async () => {
    const overview = await collectAgentOverview({
      ctx: fakeCtx({
        team: [
          { id: 'sess-main', name: 'lead', role: 'lead', status: 'running' },
          { id: 'sess-a', name: 'alice', role: 'teammate', status: 'running' },
        ],
        terminal: true,
        children: [],
        agents: { 'sess-main': { status: 'running' }, 'sess-a': { status: 'running' } },
        jobs: {
          'sess-a': [
            { id: 'bash-1', label: 'npm test', kind: 'bash', status: 'running', startedAt: Date.now() },
            { id: 'bash-2', label: 'done', kind: 'bash', status: 'completed', startedAt: Date.now() },
          ],
        },
      }),
      sessionManager,
    });
    assert.equal(overview.teamEnabled, true);
    assert.equal(overview.terminalEnabled, true);
    assert.equal(overview.children.length, 1);
    assert.equal(overview.children[0].name, 'alice');
    assert.equal(overview.children[0].role, 'teammate');
    assert.equal(overview.jobs.length, 1);
    assert.equal(overview.jobs[0].label, 'npm test');
  });

  it('reports no jobs when the persistent terminal is disabled', async () => {
    const overview = await collectAgentOverview({
      ctx: fakeCtx({
        team: null,
        terminal: false,
        children: [{ kind: 'child', id: 'sess-b', label: 'helper' }],
        agents: { 'sess-b': { status: 'inactive' } },
        jobs: { 'sess-b': [{ id: 'bash-1', label: 'x', kind: 'bash', status: 'running', startedAt: Date.now() }] },
      }),
      sessionManager,
    });
    assert.equal(overview.teamEnabled, false);
    assert.equal(overview.terminalEnabled, false);
    assert.equal(overview.children.length, 1);
    assert.equal(overview.children[0].label, 'helper');
    assert.deepEqual(overview.jobs, []);
  });
});
