import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { MessageBridge } from '../lib/sync/message-bridge.js';

/**
 * Issue #8 integration: the bridge must actually push a notice when a turn ends
 * abnormally, and must stay quiet for the cases that would be noise.
 *
 * The bridge is driven through `handleDshSessionEvent`, which is the real entry
 * point used by the session/event listener.
 */

function makeBridge({ config = {}, turnEnd } = {}) {
  const sent = [];
  let cfg = { userOpenid: 'user_1', allowFrom: ['*'], ...config };

  const apiClient = {
    sendC2CMessage: async (openid, payload) => {
      sent.push({ openid, ...payload });
      return { ok: true };
    },
    sendTyping: async () => ({ ok: true }),
  };

  const sessionManager = {
    getActiveSessionId: async () => 'sess-active',
    getActiveSessionInfo: async () => ({ sessionId: 'sess-active', title: '当前会话', cwd: 'W:/proj' }),
    getSessionInfoById: async (id) => ({ sessionId: id, title: '插件更新与功能优化任务', cwd: 'W:/proj' }),
    cancelActiveTurn: async () => true,
  };

  const bridge = new MessageBridge({
    ctx: { on: () => () => {}, effect: () => () => {} },
    apiClient,
    gateway: { on: () => {}, send: async () => {} },
    sessionManager,
    approvalHandler: { handleUserDecision: () => true },
    inventory: null,
    getConfig: () => cfg,
    updateConfig: (patch) => {
      cfg = { ...cfg, ...patch };
    },
  });

  return { bridge, sent, sessionManager, getConfig: () => cfg };
}

const TURN_END = (reason) => ({ type: 'turn/end', data: { turn: 1, reason } });

describe('abnormal turn-end notices (bridge integration)', () => {
  it('pushes a notice without a keyboard when the turn errors', async () => {
    const { bridge, sent } = makeBridge();
    bridge.onDshTurnStart('sess-active', { data: { turn: 1 } });
    bridge.noteTurnTool('sess-active', { data: { turn: 1 } }, 'bash');

    await bridge.handleDshSessionEvent({ id: 'sess-active' }, TURN_END({ kind: 'error', error: { code: 'E1', message: 'boom' } }));

    assert.equal(sent.length, 1, 'exactly one notice');
    const msg = sent[0];
    assert.match(msg.markdown, /执行出错/);
    assert.match(msg.markdown, /bash/);
    assert.match(msg.markdown, /boom/);
    // An automatic notice must not repeat the whole action board: the buttons
    // belong to messages the user asked for.
    assert.equal(msg.keyboard, undefined, 'no action board under a background notice');
    assert.equal(msg.openid, 'user_1');
  });

  it('stays silent when the turn completes', async () => {
    const { bridge, sent } = makeBridge();
    bridge.onDshTurnStart('sess-active', { data: { turn: 1 } });
    await bridge.handleDshSessionEvent({ id: 'sess-active' }, TURN_END({ kind: 'completed' }));
    assert.equal(sent.length, 0);
  });

  it('stays silent for the abort caused by our own /cancel', async () => {
    const { bridge, sent } = makeBridge();
    bridge.onDshTurnStart('sess-active', { data: { turn: 1 } });
    // Simulate the user pressing /cancel from QQ.
    await bridge.cmdCancel('user_1', 'msg-1');
    const before = sent.length; // the /cancel receipt
    assert.ok(before >= 1, 'cancel sends a receipt');

    await bridge.handleDshSessionEvent({ id: 'sess-active' }, TURN_END({ kind: 'aborted' }));
    assert.equal(sent.length, before, 'the abort must not add a second message');
  });

  it('stays silent when the switch is off', async () => {
    const { bridge, sent } = makeBridge({ config: { notifyTurnAbnormal: false } });
    bridge.onDshTurnStart('sess-active', { data: { turn: 1 } });
    await bridge.handleDshSessionEvent({ id: 'sess-active' }, TURN_END({ kind: 'error' }));
    assert.equal(sent.length, 0);
  });

  it('clears the assistant buffer on every turn end', async () => {
    const { bridge } = makeBridge();
    bridge.assistantBuffers.set('sess-active', 'leftover');
    await bridge.handleDshSessionEvent({ id: 'sess-active' }, TURN_END({ kind: 'completed' }));
    assert.equal(bridge.assistantBuffers.has('sess-active'), false);
  });

  it('does not throw when the session title cannot be read', async () => {
    const { bridge, sent } = makeBridge();
    bridge.sessionManager.getSessionInfoById = async () => {
      throw new Error('nope');
    };
    bridge.onDshTurnStart('sess-active', { data: { turn: 1 } });
    await bridge.handleDshSessionEvent({ id: 'sess-active' }, TURN_END({ kind: 'max-tokens' }));
    assert.equal(sent.length, 1, 'a missing title must not suppress the notice');
    assert.match(sent[0].markdown, /达到单轮输出上限/);
  });

  it('survives a turn/end with no reason at all', async () => {
    const { bridge, sent } = makeBridge();
    await bridge.handleDshSessionEvent({ id: 'sess-active' }, { type: 'turn/end', data: {} });
    // No reason means "unknown kind", which is reported rather than swallowed.
    assert.equal(sent.length, 1);
    assert.match(sent[0].markdown, /非正常结束/);
  });
});
