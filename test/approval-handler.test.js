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

    // Simulate approval/request arriving in DSH (0.2.1-rc.3: agent is a bare { id })
    const mockReq = {
      agent: { id: 'sess_active_123' },
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
      agent: { id: 'sess_active_123' },
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

  it('should intercept user-questions/request and resolve via QQ option selection', async () => {
    let questionListener = null;
    const mockCtx = {
      on: (event, handler) => {
        if (event === 'user-questions/request') {
          questionListener = handler;
        }
        return () => {};
      },
    };

    let sentMessages = [];
    const recalledMessages = [];
    const mockApiClient = {
      sendC2CMessage: async (openid, msg) => {
        sentMessages.push({ openid, msg });
        return { id: `msg_q_${sentMessages.length}` };
      },
      recallC2CMessage: async (openid, messageId) => {
        recalledMessages.push({ openid, messageId });
        return true;
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
    assert.ok(questionListener !== null, 'Question listener must be registered');

    const mockReq = {
      agent: { id: 'sess_active_123' },
      questions: [
        {
          id: 'q1',
          header: '确认选择',
          question: '请问你要选择哪种方案？',
          options: [
            { label: '方案 A', description: '快速方案' },
            { label: '方案 B', description: '稳健方案' },
          ],
        },
      ],
    };

    const questionPromise = questionListener(mockReq, async () => {
      return new Promise(() => {});
    });

    await new Promise((r) => setTimeout(r, 10));

    assert.equal(sentMessages.length, 1);
    assert.ok(sentMessages[0].msg.markdown.includes('请问你要选择哪种方案？'));
    assert.ok(sentMessages[0].msg.keyboard);

    // Answer from QQ
    const handled = await handler.handleQuestionAnswer('q1', '方案 A');
    assert.equal(handled.ok, true);

    const res = await questionPromise;
    assert.deepEqual(res, {
      answers: [
        {
          id: 'q1',
          selected: ['方案 A'],
        },
      ],
    });

    handler.stop();
  });

  it('should deliver every question of a multi-question batch and resolve one answer per question', async () => {
    let questionListener = null;
    const mockCtx = {
      on: (event, handler) => {
        if (event === 'user-questions/request') questionListener = handler;
        return () => {};
      },
    };
    const sentMessages = [];
    const mockApiClient = {
      sendC2CMessage: async (openid, msg) => {
        sentMessages.push({ openid, msg });
        return { id: `msg_multi_${sentMessages.length}` };
      },
      recallC2CMessage: async () => true,
    };
    const handler = new ApprovalHandler({
      ctx: mockCtx,
      apiClient: mockApiClient,
      sessionManager: { getActiveSessionId: async () => 'sess_active_123' },
      getUserOpenid: () => 'user_target_openid',
    });
    handler.start();

    const mockReq = {
      agent: { id: 'sess_active_123' },
      questions: [
        { id: 'q1', header: '第一步', question: '选择语言？', options: [{ label: 'TypeScript' }, { label: 'Python' }] },
        { id: 'q2', header: '第二步', question: '选择框架？', options: [{ label: 'React' }, { label: 'Vue' }] },
      ],
    };
    const questionPromise = questionListener(mockReq, async () => new Promise(() => {}));
    await new Promise((r) => setTimeout(r, 10));

    assert.equal(sentMessages.length, 1);
    assert.ok(sentMessages[0].msg.markdown.includes('第 1/2 题'));
    assert.ok(sentMessages[0].msg.markdown.includes('选择语言？'));
    assert.ok(!sentMessages[0].msg.markdown.includes('选择框架？'));

    const requestId = sentMessages[0].msg.keyboard.content.rows[0].buttons[0].action.data.split(' ')[1];
    const first = await handler.handleQuestionAnswer(requestId, 'A');
    assert.equal(first.ok, true);
    assert.equal(first.kind, 'advanced');
    await new Promise((r) => setTimeout(r, 10));

    assert.equal(sentMessages.length, 2);
    assert.ok(sentMessages[1].msg.markdown.includes('第 2/2 题'));
    assert.ok(sentMessages[1].msg.markdown.includes('选择框架？'));

    const second = await handler.handleQuestionAnswer(requestId, 'B');
    assert.equal(second.kind, 'submitted');
    const res = await questionPromise;
    assert.deepEqual(res, {
      answers: [
        { id: 'q1', selected: ['TypeScript'] },
        { id: 'q2', selected: ['Vue'] },
      ],
    });
    handler.stop();
  });

  it('should toggle multi-select options, mark them, and submit the selection', async () => {
    let questionListener = null;
    const mockCtx = {
      on: (event, handler) => {
        if (event === 'user-questions/request') questionListener = handler;
        return () => {};
      },
    };
    const sentMessages = [];
    const recalled = [];
    const mockApiClient = {
      sendC2CMessage: async (openid, msg) => {
        sentMessages.push({ openid, msg });
        return { id: `msg_ms_${sentMessages.length}` };
      },
      recallC2CMessage: async (openid, id) => {
        recalled.push(id);
        return true;
      },
    };
    const handler = new ApprovalHandler({
      ctx: mockCtx,
      apiClient: mockApiClient,
      sessionManager: { getActiveSessionId: async () => 'sess_active_123' },
      getUserOpenid: () => 'user_target_openid',
    });
    handler.start();

    const mockReq = {
      agent: { id: 'sess_active_123' },
      questions: [
        {
          id: 'q1',
          question: '需要哪些模块？',
          multiSelect: true,
          options: [{ label: '日志' }, { label: '告警' }, { label: '报表' }],
        },
      ],
    };
    const questionPromise = questionListener(mockReq, async () => new Promise(() => {}));
    await new Promise((r) => setTimeout(r, 10));

    assert.ok(sentMessages[0].msg.markdown.includes('多选'));
    const rows = sentMessages[0].msg.keyboard.content.rows;
    assert.ok(rows.at(-1).buttons.some((b) => b.action.data.includes('__submit__')));
    const requestId = rows[0].buttons[0].action.data.split(' ')[1];

    const toggled = await handler.handleQuestionAnswer(requestId, 'A');
    assert.equal(toggled.kind, 'toggled');
    assert.ok(sentMessages[1].msg.markdown.includes('日志'));
    assert.ok(sentMessages[1].msg.markdown.includes('已选'));

    await handler.handleQuestionAnswer(requestId, 'B');
    const submitted = await handler.handleQuestionAnswer(requestId, '__submit__');
    assert.equal(submitted.kind, 'submitted');

    const res = await questionPromise;
    assert.deepEqual(res, { answers: [{ id: 'q1', selected: ['日志', '告警'] }] });
    assert.ok(recalled.length >= 2, 'previous question cards should be recalled');
    handler.stop();
  });
});
