import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { ApprovalHandler } from '../lib/sync/approval-handler.js';

/**
 * PR #2 by @heerxingen: `unavailable` from the approval waterfall is not a
 * decision — it only means the Web UI did not take the request. Treating it as a
 * rejection failed the agent closed while the QQ card was still on screen, left
 * dead buttons, and pushed a false "handled in the Web UI: rejected" notice.
 *
 * These cases drive the real waterfall listener with the four shapes that matter.
 */

function harness({ decide, sendFails = false } = {}) {
  let listener = null;
  const sent = [];
  const apiClient = {
    sendC2CMessage: async (openid, msg) => {
      if (sendFails) throw new Error('QQ down');
      sent.push({ openid, msg });
      return { id: `msg_${sent.length}` };
    },
  };
  const ctx = {
    on: (event, handler) => {
      if (event === 'approval/request') listener = handler;
      return () => {
        listener = null;
      };
    },
  };
  const sessionManager = {
    getActiveSessionId: async () => 'sess_1',
    getActiveSessionInfo: async () => ({ title: '测试会话' }),
  };
  const handler = new ApprovalHandler({
    ctx,
    apiClient,
    sessionManager,
    getUserOpenid: () => 'openid_1',
  });
  handler.start();
  assert.ok(listener, 'listener registered');

  // DSH always supplies the caller's signal; without one the handler cannot bound
  // a wait and must fail closed instead (covered by its own case).
  const controller = new AbortController();
  const req = { agent: { id: 'sess_1' }, toolName: 'pwsh', reason: 'need write', signal: controller.signal };
  const run = (nextFn) => listener(req, nextFn || decide);
  return { handler, sent, run, apiClient, controller };
}

const approve = (id) => {
  // What the QQ button click does.
  return id;
};

describe('approval survives a Web UI that does not decide', () => {
  it('keeps the QQ card authoritative when the Web UI returns unavailable', async () => {
    const h = harness();
    // Web UI abstains immediately; the waterfall resolves 'unavailable'.
    const outcomePromise = h.run(async () => 'unavailable');
    await new Promise((r) => setTimeout(r, 10));

    // The card must still be pending: the QQ user can decide.
    const pending = [...h.handler.pendingApprovals.values()];
    assert.equal(pending.length, 1, 'approval must still be waiting for QQ');
    assert.equal(pending[0].id, pending[0].id);

    // A real QQ decision is then accepted.
    const accepted = h.handler.handleUserDecision(pending[0].id, 'allowed-once');
    assert.equal(accepted, true);
    const outcome = await outcomePromise;
    assert.equal(outcome, 'allowed-once');
    void approve;
  });

  it('does not send the false "handled in the Web UI" notice', async () => {
    const h = harness();
    const outcomePromise = h.run(async () => 'unavailable');
    await new Promise((r) => setTimeout(r, 10));

    const pending = [...h.handler.pendingApprovals.values()][0];
    h.handler.handleUserDecision(pending.id, 'allowed-once');
    await outcomePromise;

    const texts = h.sent.map((s) => s.msg?.content || s.msg?.markdown || '').join('\n');
    assert.doesNotMatch(texts, /审批同步/, 'no sync notice may be claimed for an abstention');
    assert.doesNotMatch(texts, /已拒绝/);
  });

  it('passes a real Web UI rejection through and mirrors it', async () => {
    const h = harness();
    const outcome = await h.run(async () => 'rejected');
    assert.equal(outcome, 'rejected');
    const texts = h.sent.map((s) => s.msg?.content || '').join('\n');
    assert.match(texts, /审批同步/);
    assert.match(texts, /已拒绝/);
  });

  it('passes a real Web UI approval through', async () => {
    const h = harness();
    const outcome = await h.run(async () => 'allowed-once');
    assert.equal(outcome, 'allowed-once');
    const texts = h.sent.map((s) => s.msg?.content || '').join('\n');
    assert.match(texts, /允许执行/);
  });

  it('treats a downstream reject as "no decision" instead of failing closed', async () => {
    const h = harness();
    const outcomePromise = h.run(async () => {
      throw new Error('web client went away');
    });
    await new Promise((r) => setTimeout(r, 10));

    const pending = [...h.handler.pendingApprovals.values()];
    assert.equal(pending.length, 1, 'the QQ path must not be killed by a reject');
    h.handler.handleUserDecision(pending[0].id, 'allowed-once');
    assert.equal(await outcomePromise, 'allowed-once');
  });

  it('fails closed when the card never reached the user', async () => {
    const h = harness({ sendFails: true });
    // Nothing can be answered on QQ, so the Web UI's abstention must settle it.
    const outcome = await h.run(async () => 'unavailable');
    assert.equal(outcome, 'unavailable');
    assert.equal(h.handler.pendingApprovals.size, 0);
  });
});

describe('approval with an already-aborted caller signal', () => {
  it('does not hang forever waiting for an abort that already happened', async () => {
    let listener = null;
    const sent = [];
    const handler = new ApprovalHandler({
      ctx: {
        on: (event, fn) => {
          if (event === 'approval/request') listener = fn;
          return () => {};
        },
      },
      apiClient: {
        sendC2CMessage: async (openid, msg) => {
          sent.push(msg);
          return { id: 'm1' };
        },
      },
      sessionManager: {
        getActiveSessionId: async () => 'sess_1',
        getActiveSessionInfo: async () => ({ title: 't' }),
      },
      getUserOpenid: () => 'openid_1',
    });
    handler.start();

    const controller = new AbortController();
    controller.abort();
    const req = { agent: { id: 'sess_1' }, toolName: 'pwsh', signal: controller.signal };

    // Both the QQ wait and the Web UI would never settle; the aborted signal must.
    const result = await Promise.race([
      listener(req, () => new Promise(() => {})),
      new Promise((resolve) => setTimeout(() => resolve('TIMEOUT'), 1500)),
    ]);
    assert.notEqual(result, 'TIMEOUT', 'an already-aborted signal must settle the race');
    assert.equal(result, 'cancelled');
  });
});
