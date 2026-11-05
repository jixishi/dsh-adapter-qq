import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { formatRelativeTime, groupByWorkspace, workspaceLabel } from '../lib/sync/display-time.js';

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

describe('relative activity time', () => {
  const now = 1_700_000_000_000;

  it('uses the same units and wording as the DSH left sidebar', () => {
    // Mirrors the `time.*` locale keys: 刚刚 / N分钟 / N小时 / N天 / N个月 / N年
    assert.equal(formatRelativeTime(now - 5 * 1000, now), '刚刚');
    assert.equal(formatRelativeTime(now - 1 * MINUTE, now), '1分钟');
    assert.equal(formatRelativeTime(now - 5 * MINUTE, now), '5分钟');
    assert.equal(formatRelativeTime(now - 59 * MINUTE, now), '59分钟');
    assert.equal(formatRelativeTime(now - 1 * HOUR, now), '1小时');
    assert.equal(formatRelativeTime(now - 5 * HOUR, now), '5小时');
    assert.equal(formatRelativeTime(now - 2 * DAY, now), '2天');
    assert.equal(formatRelativeTime(now - 40 * DAY, now), '1个月');
    assert.equal(formatRelativeTime(now - 400 * DAY, now), '1年');
  });

  it('collapses edge cases instead of printing NaN or negatives', () => {
    // A missing timestamp has no meaningful label.
    assert.equal(formatRelativeTime(0, now), '');
    assert.equal(formatRelativeTime(null, now), '');
    assert.equal(formatRelativeTime(undefined, now), '');
    assert.equal(formatRelativeTime('', now), '');
    assert.equal(formatRelativeTime(Number.NaN, now), '');
    // Clock skew (a future timestamp) must not read as a negative duration.
    assert.equal(formatRelativeTime(now + 60_000, now), '刚刚');
  });

  it('never emits a fractional or negative number', () => {
    for (const delta of [0, 1, 59_999, MINUTE, 90 * MINUTE, 25 * HOUR, 29 * DAY, 364 * DAY]) {
      const label = formatRelativeTime(now - delta, now);
      assert.ok(/^(刚刚|\d+(分钟|小时|天|个月|年))$/.test(label), `bad label for ${delta}: ${label}`);
    }
  });
});

describe('workspace labelling and grouping', () => {
  it('labels a workspace by its final path segment', () => {
    assert.equal(workspaceLabel('W:/dsh-plugins/dsh-adapter-qq'), 'dsh-adapter-qq');
    assert.equal(workspaceLabel('C:\\Users\\RUNIC'), 'RUNIC');
    assert.equal(workspaceLabel('W:/trailing/slash/'), 'slash');
    assert.equal(workspaceLabel(''), '未指定工作区');
    assert.equal(workspaceLabel(null), '未指定工作区');
  });

  it('groups sessions by workspace, newest first', () => {
    const rows = [
      { sessionId: 'a', cwd: 'W:/x/proj1', updatedAt: 100 },
      { sessionId: 'b', cwd: 'W:/x/proj1', updatedAt: 300 },
      { sessionId: 'c', cwd: 'W:/y/proj2', updatedAt: 200 },
    ];
    const groups = groupByWorkspace(rows);
    assert.equal(groups.length, 2);
    // proj1 has the newest session, so it comes first.
    assert.equal(groups[0].label, 'proj1');
    assert.equal(groups[0].updatedAt, 300);
    // Within a group, newest first.
    assert.deepEqual(groups[0].sessions.map((s) => s.sessionId), ['b', 'a']);
    assert.equal(groups[1].label, 'proj2');
  });

  it('keeps same-named workspaces apart when their paths differ', () => {
    // Two projects can share a tail segment; grouping by label would merge them.
    const rows = [
      { sessionId: 'a', cwd: 'W:/x/proj', updatedAt: 100 },
      { sessionId: 'b', cwd: 'W:/z/proj', updatedAt: 200 },
    ];
    const groups = groupByWorkspace(rows);
    assert.equal(groups.length, 2);
    assert.equal(groups.filter((g) => g.label === 'proj').length, 2);
  });

  it('collects sessions without a cwd into one bucket', () => {
    const rows = [
      { sessionId: 'a', cwd: '', updatedAt: 10 },
      { sessionId: 'b', cwd: undefined, updatedAt: 20 },
    ];
    const groups = groupByWorkspace(rows);
    assert.equal(groups.length, 1);
    assert.equal(groups[0].label, '未指定工作区');
    assert.equal(groups[0].sessions.length, 2);
  });

  it('tolerates an empty or malformed list', () => {
    assert.deepEqual(groupByWorkspace([]), []);
    assert.deepEqual(groupByWorkspace(null), []);
    assert.deepEqual(groupByWorkspace([null, undefined]), []);
  });
});

describe('subscription API payload', () => {
  it('ships relative time and workspace groups to the pane', () => {
    const source = fs.readFileSync('W:/dsh-plugins/dsh-adapter-qq/lib/qq/subscription-route.js', 'utf8');
    // The pane cannot compute these itself (no session store in the browser), so
    // the host must send them.
    assert.match(source, /updatedLabel:\s*formatRelativeTime/);
    assert.match(source, /workspaceGroups:\s*groupByWorkspace/);
    assert.match(source, /workspace:\s*workspaceLabel/);
  });

  it('uses an injectable clock so the labels are testable', () => {
    const source = fs.readFileSync('W:/dsh-plugins/dsh-adapter-qq/lib/qq/subscription-route.js', 'utf8');
    assert.match(source, /now = \(\) => Date\.now\(\)/);
  });

  it('renders the picker grouped by workspace', () => {
    const source = fs.readFileSync('W:/dsh-plugins/dsh-adapter-qq/lib/client.js', 'utf8');
    assert.match(source, /availableWorkspaceSections/);
    assert.match(source, /dsh-sub-group-head/);
    assert.match(source, /最近活跃时间/);
  });
});
