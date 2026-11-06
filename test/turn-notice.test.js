import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { describeTurnEnd, formatTurnEndNotice, summarizeTurnEndReason, TURN_END_KINDS } from '../lib/sync/turn-notice.js';

/**
 * Issue #8: a turn that ends without an assistant message used to leave the QQ
 * user with nothing but a stopped typing indicator. These tests pin the decision
 * (what to report), the reason parsing (which fields really exist) and the
 * wording.
 */

describe('turn-end kinds', () => {
  it('only knows the kinds DSH actually produces', () => {
    // Read from @deepseek-ai/dsh-acp turnEndToStopReason(). `max-steps` and
    // `step-limit` were mentioned in the issue but do not exist.
    assert.deepEqual(Object.keys(TURN_END_KINDS).sort(), [
      'aborted',
      'blocked',
      'completed',
      'error',
      'interrupted',
      'max-tokens',
    ]);
    assert.ok(!('max-steps' in TURN_END_KINDS), 'max-steps is not a real kind');
    assert.ok(!('step-limit' in TURN_END_KINDS), 'step-limit is not a real kind');
  });
});

describe('describeTurnEnd', () => {
  it('stays silent on a completed turn', () => {
    const d = describeTurnEnd({ reason: { kind: 'completed' } });
    assert.equal(d.notify, false);
    assert.equal(d.why, 'completed');
  });

  it('reports every abnormal kind', () => {
    for (const kind of ['error', 'max-tokens', 'blocked', 'interrupted', 'aborted']) {
      const d = describeTurnEnd({ reason: { kind } });
      assert.equal(d.notify, true, `${kind} must be reported`);
      assert.ok(d.label.length > 0);
      assert.ok(d.icon.length > 0);
    }
  });

  it('reports an unknown kind instead of swallowing it', () => {
    // The type is documented as merge-extensible, so a future kind must not be
    // silently dropped.
    const d = describeTurnEnd({ reason: { kind: 'brand-new-kind' } });
    assert.equal(d.notify, true);
    assert.equal(d.why, 'unknown-kind');
    assert.equal(d.label, '非正常结束');
  });

  it('skips the abort that /cancel itself caused', () => {
    const d = describeTurnEnd({ reason: { kind: 'aborted' }, qqCancelled: true });
    assert.equal(d.notify, false);
    assert.equal(d.why, 'qq-cancelled');
  });

  it('still reports an abort that did NOT come from QQ', () => {
    const d = describeTurnEnd({ reason: { kind: 'aborted' }, qqCancelled: false });
    assert.equal(d.notify, true);
  });

  it('filters transient error codes the host retries itself', () => {
    for (const code of ['STREAM_CLOSED', 'ECONNRESET', 'EPIPE']) {
      const d = describeTurnEnd({ reason: { kind: 'error', error: { code } } });
      assert.equal(d.notify, false, `${code} should stay quiet`);
      assert.equal(d.why, 'transient');
    }
  });

  it('does not treat an unknown kind with no code as transient', () => {
    const d = describeTurnEnd({ reason: { kind: '' } });
    assert.equal(d.notify, true);
  });

  it('is junk-safe', () => {
    for (const reason of [undefined, null, {}, 'nope', 42]) {
      const d = describeTurnEnd({ reason });
      assert.equal(typeof d.notify, 'boolean');
    }
  });
});

describe('summarizeTurnEndReason', () => {
  it('reads the fields DSH actually sets, in order', () => {
    // Shapes observed in the DSH sources.
    assert.deepEqual(summarizeTurnEndReason({ kind: 'error', error: { code: 'E1', message: 'boom' } }), {
      code: 'E1',
      message: 'boom',
    });
    assert.equal(summarizeTurnEndReason({ kind: 'aborted', failure: { message: 'x' } }).message, 'x');
    assert.equal(summarizeTurnEndReason({ kind: 'error', message: 'plain' }).message, 'plain');
    assert.equal(summarizeTurnEndReason({ kind: 'error', text: 'textual' }).message, 'textual');
    assert.equal(summarizeTurnEndReason({ kind: 'aborted', reason: 'cause' }).message, 'cause');
  });

  it('prefers error over the fallbacks', () => {
    const s = summarizeTurnEndReason({
      kind: 'error',
      error: { code: 'FIRST' },
      failure: { message: 'second' },
      message: 'third',
    });
    assert.equal(s.code, 'FIRST');
  });

  it('returns empty when nothing is present', () => {
    assert.deepEqual(summarizeTurnEndReason({ kind: 'blocked' }), { code: '', message: '' });
  });

  it('truncates a huge message', () => {
    const s = summarizeTurnEndReason({ kind: 'error', message: 'x'.repeat(5000) });
    assert.ok(s.message.length <= 300);
  });
});

describe('formatTurnEndNotice', () => {
  it('names the failure, the tool it died in, and how to continue', () => {
    const now = 1_700_000_000_000;
    const text = formatTurnEndNotice({
      reason: { kind: 'error', error: { code: 'E_GATEWAY', message: 'upstream 502' } },
      sessionTitle: '插件更新与功能优化任务',
      turn: { lastTool: 'bash', lastToolAt: now - 90_000, sawOutput: false },
      now,
    });
    assert.match(text, /执行出错/);
    assert.match(text, /插件更新与功能优化任务/);
    assert.match(text, /bash/);
    assert.match(text, /E_GATEWAY/);
    assert.match(text, /upstream 502/);
    // The most important sentence for the reader: silence is recoverable.
    assert.match(text, /继续/);
    assert.match(text, /没有产出任何内容/);
  });

  it('says so when the turn did produce something first', () => {
    const text = formatTurnEndNotice({
      reason: { kind: 'max-tokens' },
      turn: { lastTool: null, sawOutput: true },
      now: Date.now(),
    });
    assert.match(text, /达到单轮输出上限/);
    assert.doesNotMatch(text, /没有产出任何内容/);
    assert.match(text, /没有更多的正文产出/);
  });

  it('works with no turn state and no session title', () => {
    const text = formatTurnEndNotice({ reason: { kind: 'interrupted' } });
    assert.match(text, /被中断/);
    assert.ok(text.length > 20);
  });

  it('does not leak undefined into the text', () => {
    const text = formatTurnEndNotice({ reason: { kind: 'error' }, turn: {}, now: Date.now() });
    assert.doesNotMatch(text, /undefined/);
    assert.doesNotMatch(text, /\[object Object\]/);
  });
});
