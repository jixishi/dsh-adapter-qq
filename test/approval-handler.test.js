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

  /**
   * ApprovalHandler with an observable waterfall listener, outbound messages,
   * and a model of the cards actually visible in the QQ chat: a card enters
   * `liveCards` when the API accepts it and leaves when it is recalled. That
   * makes the "at most two cards on screen" rule directly assertable.
   * @param {Object} [options]
   * @param {boolean} [options.sendFails] - Make every QQ send reject, simulating an API outage
   */
  function createQuestionHarness({ sendFails = false } = {}) {
    let questionListener = null;
    const sentMessages = [];
    const liveCards = new Map();
    const recalls = [];
    let messageSeq = 0;

    const mockCtx = {
      on: (event, handler) => {
        if (event === 'user-questions/request') {
          questionListener = handler;
        }
        return () => {
          questionListener = null;
        };
      },
    };

    const mockApiClient = {
      sendC2CMessage: async (openid, msg) => {
        if (sendFails) throw new Error('QQ API unavailable');
        sentMessages.push({ openid, msg });
        const id = `msg_${++messageSeq}`;
        // Cards are markdown messages; the sync/completion notices are plain
        // content, so this tracks exactly the cards the chat would show.
        if (msg.markdown) liveCards.set(id, msg.markdown);
        return { id };
      },
      recallC2CMessage: async (openid, messageId) => {
        recalls.push(messageId);
        liveCards.delete(messageId);
        return true;
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

    return { handler, sentMessages, liveCards, recalls, listener: () => questionListener };
  }

  /**
   * A request whose agent targets the active session. The tool always supplies a
   * cancellation signal, so the default here does too (never aborted).
   * @param {Array<Object>} questions
   * @param {AbortSignal} [signal]
   */
  function questionRequest(questions, signal) {
    return {
      agent: { session: { id: 'sess_active_123', header: { title: 'Active Session' } } },
      questions,
      signal: signal ?? new AbortController().signal,
    };
  }

  /** A `next()` that never answers: the Web UI stays open for the whole case. */
  const openWebUi = async () => new Promise(() => {});

  /** Markdown of every card currently on screen. */
  const liveMarkdown = (harness) => [...harness.liveCards.values()].join('\n---\n');

  /** Every button of the last card sent, as `action.data` strings. */
  const lastCardButtons = (harness) => {
    const rows = harness.sentMessages.at(-1).msg.keyboard?.content?.rows ?? [];
    return rows.flatMap((row) => row.buttons).map((button) => button.action.data);
  };

  it('should open a single question directly and resolve on answer', async () => {
    const harness = createQuestionHarness();

    const questionPromise = harness.listener()(questionRequest([
      {
        id: 'q1',
        header: '确认选择',
        question: '请问你要选择哪种方案？',
        options: [
          { label: '方案 A', description: '快速方案' },
          { label: '方案 B', description: '稳健方案' },
        ],
      },
    ]), openWebUi);

    await new Promise((r) => setTimeout(r, 10));

    // One card only: a single question has nothing to navigate.
    assert.equal(harness.liveCards.size, 1);
    assert.equal(harness.sentMessages.length, 1);
    const card = harness.sentMessages[0].msg;
    assert.ok(card.markdown.includes('请问你要选择哪种方案？'));
    assert.ok(card.markdown.includes('第 1/1 题'));
    assert.deepEqual(lastCardButtons(harness), [
      `/answer 1 ${encodeURIComponent('方案 A')}`,
      `/answer 1 ${encodeURIComponent('方案 B')}`,
    ]);

    const outcome = await harness.handler.handleQuestionAnswer('1', '方案 A');
    assert.equal(outcome.status, 'completed');

    assert.deepEqual(await questionPromise, {
      answers: [{ id: 'q1', selected: ['方案 A'] }],
    });

    // The answered card is recalled; no card is left behind.
    assert.equal(harness.liveCards.size, 0);
    assert.equal(harness.recalls.length, 1);

    harness.handler.stop();
  });

  it('should keep a question list on screen and open one question at a time', async () => {
    const harness = createQuestionHarness();
    const questions = [
      { id: 'q1', question: '第一个问题？', options: [{ label: 'A1' }, { label: 'B1' }] },
      { id: 'q2', question: '第二个问题？', options: [{ label: 'A2' }, { label: 'B2' }] },
      { id: 'q3', question: '第三个问题？', options: [{ label: 'A3' }, { label: 'B3' }] },
    ];

    let settled = null;
    const questionPromise = harness.listener()(questionRequest(questions), openWebUi)
      .then((result) => { settled = result; return result; });

    await new Promise((r) => setTimeout(r, 10));

    // Only the list is on screen, listing every question and offering one button each.
    assert.equal(harness.liveCards.size, 1);
    const listCard = harness.sentMessages[0].msg;
    assert.ok(listCard.markdown.includes('本次共 3 题，已答 0 题'));
    for (const text of ['第一个问题？', '第二个问题？', '第三个问题？']) {
      assert.ok(listCard.markdown.includes(text), text);
    }
    assert.deepEqual(lastCardButtons(harness), ['/pick 1', '/pick 2', '/pick 3']);

    // Picking a question puts exactly one card next to the list.
    const picked = await harness.handler.pickQuestion('2');
    assert.equal(picked.status, 'opened');
    assert.equal(harness.liveCards.size, 2);
    assert.ok(liveMarkdown(harness).includes('第 2/3 题'));

    // Picking another replaces the open question card — never a third card.
    await harness.handler.pickQuestion('3');
    assert.equal(harness.liveCards.size, 2);
    assert.ok(liveMarkdown(harness).includes('第 3/3 题'));
    assert.ok(!liveMarkdown(harness).includes('第 2/3 题'), 'the previously open card must be recalled');

    // Answering recalls that question's card and refreshes the list in place.
    const answered = await harness.handler.handleQuestionAnswer('3', 'B3');
    assert.equal(answered.status, 'recorded');
    assert.equal(harness.liveCards.size, 1, 'only the list may remain after answering');
    assert.ok(liveMarkdown(harness).includes('已答 1 题'));
    assert.ok(liveMarkdown(harness).includes('第 3 题已记录：B3'));
    assert.ok(liveMarkdown(harness).includes('✅ **3.**'));
    assert.equal(settled, null, 'the call must not settle while a question is unanswered');

    // Out-of-order answering is fine; the batch still comes out in request order.
    await harness.handler.handleQuestionAnswer('2', 'A2');
    const last = await harness.handler.handleQuestionAnswer('1', 'B1');
    assert.equal(last.status, 'completed');

    assert.deepEqual(await questionPromise, {
      answers: [
        { id: 'q1', selected: ['B1'] },
        { id: 'q2', selected: ['A2'] },
        { id: 'q3', selected: ['B3'] },
      ],
    });

    // The finished list stays behind as the record; no question card remains.
    assert.equal(harness.liveCards.size, 1);
    assert.ok(liveMarkdown(harness).includes('已答 3 题'));

    harness.handler.stop();
  });

  it('should resolve a board letter against the question it was opened for', async () => {
    const harness = createQuestionHarness();
    const questions = [
      { id: 'q1', question: '第一题？', options: [{ label: '甲一' }, { label: '甲二' }] },
      { id: 'q2', question: '第二题？', options: [{ label: '乙一' }, { label: '乙二' }] },
    ];

    const questionPromise = harness.listener()(questionRequest(questions), openWebUi);
    await new Promise((r) => setTimeout(r, 10));

    await harness.handler.pickQuestion('1');
    await harness.handler.handleQuestionAnswer('1', 'A');
    await harness.handler.pickQuestion('2');
    await harness.handler.handleQuestionAnswer('2', 'B');

    // 'B' on question 2 is 乙二, not 甲二.
    assert.deepEqual(await questionPromise, {
      answers: [
        { id: 'q1', selected: ['甲一'] },
        { id: 'q2', selected: ['乙二'] },
      ],
    });

    harness.handler.stop();
  });

  it('should take free-form text for an option-less question and honour skip tokens', async () => {
    const harness = createQuestionHarness();
    const questions = [
      { id: 'free', question: '项目叫什么名字？' },
      { id: 'pick', question: '用哪个方案？', options: [{ label: 'X' }, { label: 'Y' }] },
    ];

    const questionPromise = harness.listener()(questionRequest(questions), openWebUi);
    await new Promise((r) => setTimeout(r, 10));

    await harness.handler.pickQuestion('1');
    const openCard = harness.sentMessages.at(-1).msg;
    assert.equal(openCard.keyboard, undefined, 'an option-less question ships no board');
    assert.ok(openCard.markdown.includes('/answer 1 你的回答'));
    assert.equal(harness.liveCards.size, 2, 'its card still counts as the second card');

    await harness.handler.handleQuestionAnswer('1', '我的项目');
    assert.equal(harness.liveCards.size, 1, 'answering recalls it like any other question');
    await harness.handler.pickQuestion('2');
    await harness.handler.handleQuestionAnswer('2', '-');

    assert.deepEqual(await questionPromise, {
      answers: [
        { id: 'free', selected: [], custom: '我的项目' },
        { id: 'pick', selected: [] },
      ],
    });

    harness.handler.stop();
  });

  it('should accept several labels for a multi-select question', async () => {
    const harness = createQuestionHarness();
    const questions = [
      { id: 'plain', question: '随便一题？', options: [{ label: 'P' }] },
      {
        id: 'multi',
        question: '要包含哪些？',
        multiSelect: true,
        options: [{ label: '甲' }, { label: '乙' }, { label: '丙' }],
      },
    ];

    const questionPromise = harness.listener()(questionRequest(questions), openWebUi);
    await new Promise((r) => setTimeout(r, 10));

    await harness.handler.pickQuestion('2');
    assert.ok(harness.sentMessages.at(-1).msg.markdown.includes('多选'));

    await harness.handler.handleQuestionAnswer('2', '甲, 丙');
    await harness.handler.handleQuestionAnswer('1', 'P');

    assert.deepEqual(await questionPromise, {
      answers: [
        { id: 'plain', selected: ['P'] },
        { id: 'multi', selected: ['甲', '丙'] },
      ],
    });

    harness.handler.stop();
  });

  it('should report an answered question and refuse an ambiguous id-less reply', async () => {
    const harness = createQuestionHarness();
    const questions = [
      { id: 'q1', question: '第一题？', options: [{ label: 'A1' }] },
      { id: 'q2', question: '第二题？', options: [{ label: 'A2' }] },
    ];

    harness.listener()(questionRequest(questions), openWebUi);
    await new Promise((r) => setTimeout(r, 10));

    // Two questions are still open, so a bare answer cannot be attributed.
    const ambiguous = await harness.handler.handleQuestionAnswer('', 'A1');
    assert.equal(ambiguous.status, 'ambiguous');
    assert.equal(ambiguous.candidates.length, 2);

    await harness.handler.handleQuestionAnswer('1', 'A1');
    const duplicate = await harness.handler.handleQuestionAnswer('1', 'A1');
    assert.equal(duplicate.status, 'duplicate');
    assert.equal(duplicate.answerText, 'A1');

    // Re-opening an answered question is refused the same way.
    assert.equal((await harness.handler.pickQuestion('1')).status, 'duplicate');

    // With exactly one question left, the reference may be omitted.
    assert.equal((await harness.handler.handleQuestionAnswer('', 'A2')).status, 'completed');

    harness.handler.stop();
  });

  it('should still settle a call whose questions repeat an id', async () => {
    // The timed tool variant validates id uniqueness, the blocking one does not,
    // so a duplicate id must not make the second question unanswerable.
    const harness = createQuestionHarness();
    const questions = [
      { id: 'dup', question: '第一题？', options: [{ label: 'A1' }] },
      { id: 'dup', question: '第二题？', options: [{ label: 'A2' }] },
    ];

    const questionPromise = harness.listener()(questionRequest(questions), openWebUi);
    await new Promise((r) => setTimeout(r, 10));

    assert.equal((await harness.handler.handleQuestionAnswer('1', 'A1')).status, 'recorded');
    assert.equal((await harness.handler.handleQuestionAnswer('2', 'A2')).status, 'completed');

    // Both answers are reported, in request order, under the id the harness used.
    assert.deepEqual(await questionPromise, {
      answers: [
        { id: 'dup', selected: ['A1'] },
        { id: 'dup', selected: ['A2'] },
      ],
    });

    harness.handler.stop();
  });

  it('should treat a blank answer as a typo rather than an explicit skip', async () => {
    const harness = createQuestionHarness();
    const questions = [
      { id: 'q1', question: '第一题？', options: [{ label: 'A1' }] },
      { id: 'q2', question: '第二题？', options: [{ label: 'A2' }] },
    ];

    let settled = null;
    const questionPromise = harness.listener()(questionRequest(questions), openWebUi)
      .then((result) => { settled = result; return result; });
    await new Promise((r) => setTimeout(r, 10));

    const blank = await harness.handler.handleQuestionAnswer('1', '');
    assert.equal(blank.status, 'empty');
    assert.equal(settled, null, 'a blank command must not submit anything');

    // The explicit skip token still works.
    assert.equal((await harness.handler.handleQuestionAnswer('1', '-')).status, 'recorded');
    assert.equal((await harness.handler.handleQuestionAnswer('2', 'A2')).status, 'completed');

    assert.deepEqual(await questionPromise, {
      answers: [
        { id: 'q1', selected: [] },
        { id: 'q2', selected: ['A2'] },
      ],
    });

    harness.handler.stop();
  });

  it('should settle with the Web UI batch, drop the QQ cards, and notify', async () => {
    const harness = createQuestionHarness();
    const webBatch = {
      answers: [
        { id: 'q1', selected: ['方案 A'] },
        { id: 'q2', selected: ['方案 C'] },
      ],
    };
    const questions = [
      { id: 'q1', question: '第一题？', options: [{ label: '方案 A' }] },
      { id: 'q2', question: '第二题？', options: [{ label: '方案 C' }] },
    ];

    const result = await harness.listener()(questionRequest(questions), async () => webBatch);
    assert.deepEqual(result, webBatch);

    // The list card is gone and the synchronisation notice is the last message.
    assert.equal(harness.liveCards.size, 0);
    const last = harness.sentMessages.at(-1).msg;
    assert.ok(last.content.includes('Web UI'));
    assert.ok(last.content.includes('方案 A'));

    // The QQ side is no longer pending, so a late tap is reported as such.
    assert.equal((await harness.handler.handleQuestionAnswer('1', '方案 A')).status, 'not-found');

    harness.handler.stop();
  });

  it('should keep the QQ path alive when the Web UI answerer rejects', async () => {
    const harness = createQuestionHarness();
    const questions = [{ id: 'q1', question: '唯一一题？', options: [{ label: 'A' }] }];

    // What the forwarded waterfall does with no connected Client (and again once
    // a Client's countdown ends): the request reaches the fallback and rejects.
    const questionPromise = harness.listener()(questionRequest(questions), async () => {
      const failure = new Error('no user-questions answerer accepted the request');
      failure.code = 'NO_PROVIDER';
      throw failure;
    });

    await new Promise((r) => setTimeout(r, 10));
    assert.equal(harness.liveCards.size, 1);

    // The card is still answerable: the rejection must not have settled the call.
    assert.equal((await harness.handler.handleQuestionAnswer('1', 'A')).status, 'completed');
    assert.deepEqual(await questionPromise, { answers: [{ id: 'q1', selected: ['A'] }] });

    harness.handler.stop();
  });

  it('should propagate caller cancellation and drop the cards instead of faking an answer', async () => {
    const harness = createQuestionHarness();
    const controller = new AbortController();
    const reason = new Error('ask_user_question timed out before the user answered');
    reason.code = 'ASK_TIMED_OUT';

    const questionPromise = harness.listener()(
      {
        ...questionRequest([{ id: 'q1', question: '题目？', options: [{ label: 'A' }] }]),
        signal: controller.signal,
      },
      openWebUi,
    );

    await new Promise((r) => setTimeout(r, 10));
    assert.equal(harness.liveCards.size, 1);
    controller.abort(reason);

    // The harness maps its own ASK_TIMED_OUT reason to the pending result, so the
    // listener must rethrow it rather than resolve with an invented answer.
    await assert.rejects(questionPromise, (error) => error === reason);
    assert.equal(harness.liveCards.size, 0, 'dead cards must not keep live-looking buttons');

    harness.handler.stop();
  });

  it('should fail fast when no card reached QQ and the Web UI answerer is out', async () => {
    // QQ API outage plus no connected Client: nothing can answer, so parking the
    // wait would hang the call until its deadline instead of failing as before.
    const harness = createQuestionHarness({ sendFails: true });
    const questions = [{ id: 'q1', question: '题目？', options: [{ label: 'A' }] }];

    const questionPromise = harness.listener()(questionRequest(questions), async () => {
      const failure = new Error('no user-questions answerer accepted the request');
      failure.code = 'NO_PROVIDER';
      throw failure;
    });

    await assert.rejects(questionPromise, (error) => error.code === 'NO_PROVIDER');
    assert.equal(harness.liveCards.size, 0);

    harness.handler.stop();
  });
});
