import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

import { SessionManager } from '../lib/sync/session-manager.js';

/**
 * PR #5 by @heerxingen: the session cards should show the last thing the user
 * said. Two sources feed that line, and they mean different things:
 *
 *  - the live event stream sees every user message (a mid-turn steer included),
 *    so its text is the true last message -> labelled 最后一条用户消息;
 *  - the `turnOutline` projection keeps only each turn's *opening* prompt, so the
 *    line is honest about that -> labelled 最近一轮提问.
 */

function manager(overrides = {}) {
  return new SessionManager({
    ctx: {
      // SessionManager resolves these services through the context, not through
      // constructor options.
      get: (name) => {
        if (name === 'sessions') return overrides.sessions ?? new Map();
        if (name === 'sessionProjections') return overrides.projections;
        return undefined;
      },
      on: () => () => {},
    },
    getActiveSessionId: async () => null,
    setActiveSessionId: async () => {},
    logger: null,
  });
}

describe('card line formatting', () => {
  it('collapses whitespace and newlines into one line', () => {
    const m = manager();
    assert.equal(m.cardLine('  hello\n\nworld\t!  '), 'hello world !');
  });

  it('strips backticks so a code span cannot swallow the card', () => {
    const m = manager();
    assert.equal(m.cardLine('run `npm test` now'), 'run npm test now');
  });

  it('bounds the length for a phone screen', () => {
    const m = manager();
    const line = m.cardLine('x'.repeat(500));
    assert.equal(line.length, 80, '79 chars plus the ellipsis');
    assert.ok(line.endsWith('…'));
  });

  it('is junk-safe', () => {
    const m = manager();
    for (const value of [undefined, null, 42, {}, '']) {
      assert.equal(typeof m.cardLine(value), 'string');
    }
  });

  it('flattens content blocks, ignoring non-text ones', () => {
    const m = manager();
    assert.equal(
      m.cardLineOf([
        { type: 'text', text: '帮我' },
        { type: 'image', url: 'x' },
        { type: 'text', text: '看下这个' },
      ]),
      '帮我 看下这个',
    );
    assert.equal(m.cardLineOf([]), '');
    assert.equal(m.cardLineOf(null), '');
  });
});

describe('resolveLastUserMessage', () => {
  it('prefers what the live stream saw and marks it exact', () => {
    const m = manager();
    m.rememberUserMessage('s1', [{ type: 'text', text: '最新的一句话' }]);
    const resolved = m.resolveLastUserMessage('s1');
    assert.deepEqual(resolved, { text: '最新的一句话', exact: true });
  });

  it('falls back to the live turnOutline, marked inexact', () => {
    const live = { id: 's2' };
    const m = manager({
      sessions: new Map([['s2', live]]),
      projections: {
        stateOf: () => ({ turns: [{ prompt: '第一轮' }, { prompt: '第二轮的问题' }] }),
      },
    });
    const resolved = m.resolveLastUserMessage('s2');
    assert.deepEqual(resolved, { text: '第二轮的问题', exact: false });
  });

  it('falls back to the persisted projection cache for a cold session', () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-projc-'));
    const previous = process.env.DSH_HOME;
    process.env.DSH_HOME = home;
    try {
      const dir = join(home, 'storages', 'session_projcache', 'sessions');
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, 's3.json'),
        JSON.stringify({ record: { rows: { turnOutline: { val: { turns: [{ prompt: '冷会话的提问' }] } } } } }),
      );
      const m = manager();
      assert.deepEqual(m.resolveLastUserMessage('s3'), { text: '冷会话的提问', exact: false });
    } finally {
      if (previous === undefined) delete process.env.DSH_HOME;
      else process.env.DSH_HOME = previous;
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('returns null when nothing is known', () => {
    const m = manager();
    assert.equal(m.resolveLastUserMessage('unknown'), null);
    assert.equal(m.resolveLastUserMessage(''), null);
    assert.equal(m.resolveLastUserMessage(undefined), null);
  });

  it('survives a corrupt cache file', () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-projc-bad-'));
    const previous = process.env.DSH_HOME;
    process.env.DSH_HOME = home;
    try {
      const dir = join(home, 'storages', 'session_projcache', 'sessions');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 's4.json'), '{not json');
      const m = manager();
      assert.equal(m.resolveLastUserMessage('s4'), null);
    } finally {
      if (previous === undefined) delete process.env.DSH_HOME;
      else process.env.DSH_HOME = previous;
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('projectionCachePath', () => {
  it('refuses ids that could escape the cache directory', () => {
    const m = manager();
    assert.equal(m.projectionCachePath('../../etc/passwd'), null);
    assert.equal(m.projectionCachePath('a/b'), null);
    assert.equal(m.projectionCachePath('a\\b'), null);
    assert.equal(m.projectionCachePath(''), null);
    assert.equal(m.projectionCachePath(null), null);
  });

  it('accepts a normal session id', () => {
    const m = manager();
    const p = m.projectionCachePath('sess-abc_123');
    assert.ok(p);
    assert.ok(p.endsWith(join('storages', 'session_projcache', 'sessions', 'sess-abc_123.json')));
  });
});

describe('rememberUserMessage', () => {
  it('keeps only the latest message per session', () => {
    const m = manager();
    m.rememberUserMessage('s1', [{ type: 'text', text: '第一条' }]);
    m.rememberUserMessage('s1', [{ type: 'text', text: '第二条' }]);
    assert.equal(m.resolveLastUserMessage('s1').text, '第二条');
  });

  it('ignores empty or useless content', () => {
    const m = manager();
    m.rememberUserMessage('s1', []);
    m.rememberUserMessage('s1', [{ type: 'image' }]);
    m.rememberUserMessage('', [{ type: 'text', text: '没有会话' }]);
    assert.equal(m.lastUserMessages.size, 0);
  });

  it('bounds memory across many sessions', () => {
    const m = manager();
    for (let i = 0; i < 260; i += 1) {
      m.rememberUserMessage(`s${i}`, [{ type: 'text', text: `第 ${i} 条` }]);
    }
    assert.ok(m.lastUserMessages.size <= 200, `size=${m.lastUserMessages.size}`);
    // The oldest entries are the ones evicted.
    assert.equal(m.lastUserMessages.has('s0'), false);
    assert.equal(m.lastUserMessages.has('s259'), true);
  });
});
