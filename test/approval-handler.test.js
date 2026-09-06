import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ApprovalHandler } from '../lib/sync/approval-handler.js';

describe('ApprovalHandler', () => {
  it('should intercept approval/request waterfall and resolve via QQ user decision', async () => {
    let waterfallListener = null;
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

    let sentC2CMessage = null;
    const mockApiClient = {
      sendC2CMessage: async (openid, msg) => {
        sentC2CMessage = { openid, msg };
        return { id: 'msg_appr_1' };
      },
    };

    const mockSessionManager = {
      getActiveSessionId: async () => 'sess_active_123',
    };

    const handler = new ApprovalHandler({
      ctx: mockCtx,
      apiClient: mockApiClient,
      sessionManager: mockSessionManager,
      getUserOpenid: () => 'user_target_openid',
    });

    handler.start();
    assert.ok(waterfallListener !== null, 'Waterfall listener must be registered');

    // Simulate approval/request arriving in DSH
    const mockReq = {
      agent: {
        session: { id: 'sess_active_123', header: { title: 'Active Session' } },
      },
      toolName: 'pwsh',
      reason: 'Sandbox write outside workspace',
    };

    const approvalPromise = waterfallListener(mockReq, async () => {
      // Simulate waiting web UI
      return new Promise(() => {});
    });

    // Wait a tick for async sendC2CMessage
    await new Promise((r) => setTimeout(r, 10));

    // Check that notification card was sent to QQ
    assert.ok(sentC2CMessage);
    assert.equal(sentC2CMessage.openid, 'user_target_openid');
    assert.ok(sentC2CMessage.msg.markdown.includes('pwsh'));
    assert.ok(sentC2CMessage.msg.keyboard);

    // Verify pending approvals map
    assert.equal(handler.pendingApprovals.size, 1);
    const pendingId = Array.from(handler.pendingApprovals.keys())[0];

    // Simulate QQ user clicking [允许] button
    const handled = handler.handleUserDecision(pendingId, 'allowed-once');
    assert.equal(handled, true);

    const outcome = await approvalPromise;
    assert.equal(outcome, 'allowed-once');
    assert.equal(handler.pendingApprovals.size, 0);

    handler.stop();
  });

  it('should resolve via Web UI decision and notify QQ', async () => {
    let waterfallListener = null;
    const mockCtx = {
      on: (event, handler) => {
        if (event === 'approval/request') {
          waterfallListener = handler;
        }
        return () => {};
      },
    };

    const sentMessages = [];
    const mockApiClient = {
      sendC2CMessage: async (openid, msg) => {
        sentMessages.push({ openid, msg });
        return { id: 'msg_ok' };
      },
    };

    const mockSessionManager = {
      getActiveSessionId: async () => 'sess_active_123',
    };

    const handler = new ApprovalHandler({
      ctx: mockCtx,
      apiClient: mockApiClient,
      sessionManager: mockSessionManager,
      getUserOpenid: () => 'user_target_openid',
    });

    handler.start();

    const mockReq = {
      agent: {
        session: { id: 'sess_active_123', header: { title: 'Active Session' } },
      },
      toolName: 'edit',
      reason: 'Edit file outside cwd',
    };

    // Simulate Web UI answering 'rejected'
    const approvalPromise = waterfallListener(mockReq, async () => 'rejected');

    const outcome = await approvalPromise;
    assert.equal(outcome, 'rejected');

    // Should have sent the initial card + the sync notice to QQ
    assert.equal(sentMessages.length, 2);
    assert.ok(sentMessages[1].msg.content.includes('Web UI'));
    assert.ok(sentMessages[1].msg.content.includes('已拒绝'));

    handler.stop();
  });
});
