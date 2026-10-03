import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ApprovalHandler } from '../lib/sync/approval-handler.js';

/**
 * The `approval/request` waterfall when the Web UI does not decide.
 *
 * `unavailable` is not a decision: dsh-api-remotes resolves it when no Client is
 * attached, when the Client delegates, and (through dsh-user-approval's
 * normalization) whenever a downstream answerer throws. None of those may settle
 * the race while the QQ card is the only live answerer, or the request fails
 * closed with an unanswerable card left in the chat.
 *
 * These live in their own file rather than in approval-handler.test.js so the
 * change stays independent of concurrent work on that file's question cases.
 */
describe('ApprovalHandler — Web UI did not decide', () => {
  /**
   * ApprovalHandler with an observable approval waterfall listener and outbound messages.
   * @param {Object} [options]
   * @param {boolean} [options.sendFails] - Make the QQ card send reject
   */
  function createHarness({ sendFails = false } = {}) {
    let waterfallListener = null;
    const sentMessages = [];
    const mockCtx = {
      on: (event, handler) => {
        if (event === 'approval/request') {
          waterfallListener = handler;
        }
        return () => {
          waterfallListener = null;
        };
      },
    };
    const mockApiClient = {
      sendC2CMessage: async (openid, msg) => {
        if (sendFails && msg.markdown) throw new Error('QQ API unavailable');
        sentMessages.push({ openid, msg });
        return { id: `msg_${sentMessages.length}` };
      },
    };
    const handler = new ApprovalHandler({
      ctx: mockCtx,
      apiClient: mockApiClient,
      sessionManager: { getActiveSessionId: async () => 'sess_active_123' },
      getUserOpenid: () => 'user_target_openid',
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    });
    handler.start();
    return { handler, sentMessages, listener: () => waterfallListener };
  }

  /** An approval request for the active session; the caller always supplies a signal. */
  function approvalRequest(signal) {
    return {
      agent: { session: { id: 'sess_active_123', header: { title: 'Active Session' } } },
      toolName: 'pwsh',
      reason: 'Sandbox write outside workspace',
      signal: signal ?? new AbortController().signal,
    };
  }

  it('should keep the QQ approval alive when the Web UI has no answerer', async () => {
    const harness = createHarness();

    const approvalPromise = harness.listener()(approvalRequest(), async () => 'unavailable');
    await new Promise((r) => setTimeout(r, 10));

    // The card is still answerable, and QQ was not told the Web UI decided.
    assert.equal(harness.sentMessages.length, 1);
    assert.equal(harness.handler.pendingApprovals.size, 1);
    const pendingId = [...harness.handler.pendingApprovals.keys()][0];
    assert.equal(harness.handler.handleUserDecision(pendingId, 'allowed-once'), true);

    assert.equal(await approvalPromise, 'allowed-once');
    assert.equal(harness.sentMessages.length, 1, 'no Web UI decision notice may be sent for `unavailable`');

    harness.handler.stop();
  });

  it('should ignore a downstream rejection instead of failing the approval closed', async () => {
    const harness = createHarness();

    const approvalPromise = harness.listener()(approvalRequest(), async () => {
      throw new Error('downstream answerer exploded');
    });
    await new Promise((r) => setTimeout(r, 10));

    const pendingId = [...harness.handler.pendingApprovals.keys()][0];
    assert.equal(harness.handler.handleUserDecision(pendingId, 'rejected'), true);
    assert.equal(await approvalPromise, 'rejected');

    harness.handler.stop();
  });

  it('should fail closed when the approval card could not be delivered and the Web UI has no answerer', async () => {
    // Nothing can decide, so the request must fail closed exactly as it would
    // without this listener, rather than waiting for a card nobody received.
    const harness = createHarness({ sendFails: true });

    const outcome = await harness.listener()(approvalRequest(), async () => 'unavailable');
    assert.equal(outcome, 'unavailable');
    assert.equal(harness.sentMessages.length, 0);

    harness.handler.stop();
  });

  it('should fail closed immediately when the request arrives already aborted', async () => {
    // An already-aborted signal never fires an abort listener, so the race must
    // resolve it up front rather than parking forever on a dead turn.
    const harness = createHarness();
    const controller = new AbortController();
    controller.abort(new Error('turn already cancelled'));

    const outcome = await harness.listener()(
      approvalRequest(controller.signal),
      async () => new Promise(() => {}),
    );
    assert.equal(outcome, 'cancelled');

    harness.handler.stop();
  });
});
