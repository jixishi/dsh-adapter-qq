import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { MessageBridge } from '../lib/sync/message-bridge.js';

/**
 * The two delivery modes of a QQ prompt and the receipts that report them.
 *
 * `steer` injects into the running turn's next step; `queue` waits for the next
 * turn. Which one a plain message takes follows the harness's own composer rule
 * (a configured default while running, always `queue` when idle), and the `/steer`
 * and `/queue` prefixes override it for one message.
 *
 * These live in their own file with a purpose-built harness so the change stays
 * independent of concurrent work in message-bridge.test.js.
 */
describe('MessageBridge delivery modes', () => {
  /**
   * MessageBridge whose prompt spy mimics the harness: the admitted message lands
   * in `nextStep` for a steer and in `nextTurn` otherwise, carrying the requestId
   * as its `source.rpcId` — exactly what the receipt reads back.
   * @param {Object} [options]
   * @param {boolean} [options.running] - Whether the live agent reports as running
   * @param {'steer'|'queue'} [options.busyDelivery] - Configured default while running
   * @param {boolean} [options.downgradeSteer] - Make the harness land steers in nextTurn,
   *   as it does when the turn is already aborting
   */
  function createHarness({ running = true, busyDelivery = 'steer', downgradeSteer = false, claimSteer = false, allowFrom = ['*'] } = {}) {
    const prompts = [];
    const sentMessages = [];
    const queueUpdates = [];
    const inbox = { nextTurn: [], nextStep: [] };

    const ctx = new EventEmitter();
    ctx.sessionController = {
      prompt: async (request) => {
        prompts.push(request);
        const message = {
          id: `item_${prompts.length}`,
          content: request.content,
          source: { kind: 'user', rpcId: request.requestId },
        };
        if (claimSteer) return { accepted: true }; // consumed at the next step boundary
        if (request.mode === 'steer' && !downgradeSteer) inbox.nextStep.push(message);
        else inbox.nextTurn.push(message);
        return { accepted: true };
      },
      updateQueue: async (request) => {
        queueUpdates.push(request);
        return { accepted: true };
      },
    };
    ctx.sessions = { get: (id) => ({ id }) };
    ctx.agents = { get: (id) => ({ id, status: running ? 'running' : 'idle' }) };

    const queueErrors = new Map();
    const sessionManager = {
      getActiveSessionId: async () => 'sess-1',
      getActiveSessionInfo: async () => ({ sessionId: 'sess-1', title: 'T', cwd: '/tmp/ws' }),
      getInbox: () => inbox,
      steerQueueItem: async (itemId, sessionId) => {
        if (queueErrors.has(itemId)) throw Object.assign(new Error('nope'), { code: queueErrors.get(itemId) });
        queueUpdates.push({ sessionId: sessionId ?? 'sess-1', itemId, action: { kind: 'steer' } });
        return { accepted: true };
      },
      removeQueueItem: async (itemId, sessionId) => {
        if (queueErrors.has(itemId)) throw Object.assign(new Error('nope'), { code: queueErrors.get(itemId) });
        queueUpdates.push({ sessionId: sessionId ?? 'sess-1', itemId, action: { kind: 'remove' } });
        return { accepted: true };
      },
    };

    const mockApiClient = {
      sendC2CMessage: async (openid, msg) => {
        sentMessages.push({ openid, msg });
        return { id: `msg_${sentMessages.length}` };
      },
      sendTyping: async () => true,
    };

    let config = {
      userOpenid: 'user_target',
      allowFrom,
      defaultCwd: '',
      defaultPreset: 'standard',
      busyDelivery,
    };

    const bridge = new MessageBridge({
      ctx,
      apiClient: mockApiClient,
      gateway: new EventEmitter(),
      sessionManager,
      approvalHandler: { handleUserDecision: () => true },
      getConfig: () => config,
      updateConfig: (patch) => {
        config = { ...config, ...patch };
      },
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    });

    return {
      bridge,
      prompts,
      sentMessages,
      queueUpdates,
      inbox,
      setQueueError: (itemId, code) => queueErrors.set(itemId, code),
      getConfig: () => config,
      /** The last message sent back to QQ, as `{ text, keyboard }`. */
      lastReply: () => {
        const msg = sentMessages.at(-1)?.msg;
        return { text: msg?.content ?? msg?.markdown ?? '', keyboard: msg?.keyboard };
      },
    };
  }

  it('should steer a plain message while running when the default is steer', async () => {
    const harness = createHarness({ running: true, busyDelivery: 'steer' });

    await harness.bridge.handleUserPrompt('user_target', '先别删那个文件', [], 'msg_in', null);

    assert.equal(harness.prompts.length, 1);
    assert.equal(harness.prompts[0].mode, 'steer');
    assert.deepEqual(harness.prompts[0].content, [{ type: 'text', text: '先别删那个文件' }]);

    // A steer that did exactly what the default asked for needs no receipt.
    assert.equal(harness.sentMessages.length, 0, 'a plain steered message stays silent');
  });

  it('should queue a plain message while running when the default is queue', async () => {
    const harness = createHarness({ running: true, busyDelivery: 'queue' });

    await harness.bridge.handleUserPrompt('user_target', '顺便跑一下测试', [], 'msg_in', null);

    assert.equal(harness.prompts[0].mode, 'queue');
    assert.equal(harness.sentMessages.length, 1, 'the queued message is the one case that reports back');
    const reply = harness.lastReply();
    assert.match(reply.text, /已排队（第 1 条）/);

    // The queued message is steerable afterwards — the same action the Web UI
    // offers on its queue rows.
    const buttons = reply.keyboard.content.rows.flatMap((row) => row.buttons).map((b) => b.action.data);
    assert.deepEqual(buttons, ['/qsteer item_1 sess-1', '/qdrop item_1 sess-1']);
  });

  it('should let /steer and /queue override the configured default for one message', async () => {
    const harness = createHarness({ running: true, busyDelivery: 'queue' });

    await harness.bridge.handleCommand('user_target', '/steer 立刻停下', 'msg_in');
    assert.equal(harness.prompts[0].mode, 'steer');
    assert.equal(harness.sentMessages.length, 0, 'an explicit steer that landed needs no receipt');

    await harness.bridge.handleCommand('user_target', '/queue 做完再发这个', 'msg_in');
    assert.equal(harness.prompts[1].mode, 'queue');
    assert.match(harness.lastReply().text, /已排队/);
  });

  it('should always queue when the Agent is idle, even for an explicit /steer', async () => {
    const harness = createHarness({ running: false, busyDelivery: 'steer' });

    // Plain text: a normal send that starts the next turn, and says nothing back.
    await harness.bridge.handleUserPrompt('user_target', '开始吧', [], 'msg_in', null);
    assert.equal(harness.prompts[0].mode, 'queue', 'idle sessions take the documented queue path');
    assert.equal(harness.sentMessages.length, 0, 'an idle send needs no receipt');

    // Explicit steer has nothing to interrupt, so it degrades visibly.
    await harness.bridge.handleCommand('user_target', '/steer 打断一下', 'msg_in');
    assert.equal(harness.prompts[1].mode, 'queue');
    assert.match(harness.lastReply().text, /没有运行中的轮次/);
  });

  it('should report a steer the harness downgraded to a queued turn', async () => {
    // What the agent does when the turn is already aborting: the steer silently
    // lands in next-turn, and only the projection can reveal it.
    const harness = createHarness({ running: true, busyDelivery: 'steer', downgradeSteer: true });

    await harness.bridge.handleUserPrompt('user_target', '等等', [], 'msg_in', null);

    assert.equal(harness.prompts[0].mode, 'steer');
    assert.match(harness.lastReply().text, /已转为排队/);
  });

  it('should list the queue with per-item actions', async () => {
    const harness = createHarness({ running: true });
    harness.inbox.nextTurn.push(
      { id: 'item_a', content: [{ type: 'text', text: '第一条排队消息' }], source: { kind: 'user' } },
      { id: 'item_b', content: [{ type: 'text', text: '第二条排队消息' }], source: { kind: 'user' } },
    );

    await harness.bridge.handleCommand('user_target', '/queue', 'msg_in');

    const reply = harness.lastReply();
    assert.match(reply.text, /排队中（本轮结束后按序发送）：2 条/);
    assert.match(reply.text, /第一条排队消息/);
    assert.match(reply.text, /第二条排队消息/);

    const buttons = reply.keyboard.content.rows.flatMap((row) => row.buttons).map((b) => b.action.data);
    assert.deepEqual(buttons, [
      '/qsteer item_a sess-1',
      '/qdrop item_a sess-1',
      '/qsteer item_b sess-1',
      '/qdrop item_b sess-1',
    ]);
  });

  it('should say the queue is empty when nothing is pending', async () => {
    const harness = createHarness({ running: true });
    await harness.bridge.handleCommand('user_target', '/queue', 'msg_in');
    assert.match(harness.lastReply().text, /没有排队中的消息/);
  });

  it('should steer and drop queue items, explaining the failures', async () => {
    const harness = createHarness({ running: true });

    await harness.bridge.handleCommand('user_target', '/qsteer item_a', 'msg_in');
    assert.deepEqual(harness.queueUpdates.at(-1), {
      sessionId: 'sess-1',
      itemId: 'item_a',
      action: { kind: 'steer' },
    });
    assert.match(harness.lastReply().text, /已插话/);

    // A board rendered for another session still targets that session.
    await harness.bridge.handleCommand('user_target', '/qsteer item_a sess-other', 'msg_in');
    assert.equal(harness.queueUpdates.at(-1).sessionId, 'sess-other');

    await harness.bridge.handleCommand('user_target', '/qdrop item_b', 'msg_in');
    assert.deepEqual(harness.queueUpdates.at(-1), {
      sessionId: 'sess-1',
      itemId: 'item_b',
      action: { kind: 'remove' },
    });
    assert.match(harness.lastReply().text, /已从队列移除/);

    // The turn ended between rendering the board and the tap.
    harness.setQueueError('item_c', 'session/steer-unavailable');
    await harness.bridge.handleCommand('user_target', '/qsteer item_c', 'msg_in');
    assert.match(harness.lastReply().text, /下一轮正常发送/);

    // The item already started executing.
    harness.setQueueError('item_d', 'session/queue-item-not-found');
    await harness.bridge.handleCommand('user_target', '/qdrop item_d', 'msg_in');
    assert.match(harness.lastReply().text, /已开始执行或已被处理/);
  });

  it('should show and switch the default delivery mode', async () => {
    const harness = createHarness({ running: true, busyDelivery: 'steer' });

    // The mode card marks the configured mode and offers both switches.
    await harness.bridge.handleCommand('user_target', '/delivery', 'msg_in');
    const card = harness.lastReply();
    assert.match(card.text, /【插话方式】/);
    assert.match(card.text, /立即插话\*\*：.*\*\*← 当前\*\*/);
    const buttons = card.keyboard.content.rows.flatMap((row) => row.buttons);
    assert.deepEqual(buttons.map((b) => b.action.data), ['/delivery steer', '/delivery queue', '/current']);
    assert.ok(buttons[0].render_data.label.startsWith('✅ '));

    await harness.bridge.handleCommand('user_target', '/delivery queue', 'msg_in');
    assert.equal(harness.getConfig().busyDelivery, 'queue');
    assert.match(harness.lastReply().text, /已设为 📥 排队/);

    // The new default applies to the next plain message.
    await harness.bridge.handleUserPrompt('user_target', '顺便做这个', [], 'msg_in', null);
    assert.equal(harness.prompts[0].mode, 'queue');
  });

  it('should carry the delivery rule through the inbound plain-text path', async () => {
    const harness = createHarness({ running: true, busyDelivery: 'queue' });
    harness.bridge.start();

    harness.bridge.gateway.emit('c2c_message', {
      id: 'msg_in',
      author: { user_openid: 'user_target' },
      content: '从 QQ 直接发的一句话',
    });
    await new Promise((r) => setTimeout(r, 20));

    assert.equal(harness.prompts.length, 1);
    assert.equal(harness.prompts[0].mode, 'queue');

    harness.bridge.stop();
  });

  it('should omit the action board when only steered messages are pending', async () => {
    // Steered messages are already inside the running turn, so there is nothing
    // to act on — and an empty keyboard must not be sent.
    const harness = createHarness({ running: true });
    harness.inbox.nextStep.push({
      id: 'item_s',
      content: [{ type: 'text', text: '已经插话的消息' }],
      source: { kind: 'user' },
    });

    await harness.bridge.handleCommand('user_target', '/queue', 'msg_in');

    const reply = harness.lastReply();
    assert.match(reply.text, /已插话（下一个步骤注入）：1 条/);
    assert.match(reply.text, /已经插话的消息/);
    assert.equal(reply.keyboard, undefined);
  });

  it('should open the mode card from a QQ menu interaction that names the item', async () => {
    const harness = createHarness({ running: true, busyDelivery: 'queue' });
    harness.bridge.start();

    // A menu interaction can deliver the item's name rather than its command, and
    // a send_message item arrives as the plain text `/delivery`.
    harness.bridge.gateway.emit('interaction', {
      id: 'interact_delivery',
      type: 12,
      user_openid: 'user_target',
      data: { type: 12, resolved: { send_message: '插话方式' } },
    });
    await new Promise((r) => setTimeout(r, 20));

    const card = harness.lastReply();
    assert.match(card.text, /【插话方式】/);
    assert.match(card.text, /排队\*\*：.*\*\*← 当前\*\*/);
    const buttons = card.keyboard.content.rows.flatMap((row) => row.buttons);
    assert.deepEqual(buttons.map((b) => b.action.data), ['/delivery steer', '/delivery queue', '/current']);
    assert.ok(buttons[1].render_data.label.startsWith('✅ '));

    harness.bridge.stop();
  });

  it('should expose the mode entry in the QQ global menu', async () => {
    const { QQApiClient } = await import('../lib/qq/client.js');
    const client = new QQApiClient({ logger: { info: () => {}, warn: () => {}, error: () => {} } });
    const items = client.getDefaultMenu().items;

    const entry = items.find((item) => item.name === '插话方式');
    assert.deepEqual(entry, { type: 'send_message', name: '插话方式', send_message: '/delivery' });
    assert.deepEqual(items.map((item) => item.name), ['会话列表', '当前会话', '插话方式', '统计信息', '切换模型', '快捷操作']);
  });

  it('should stay silent when a steered message was already claimed', async () => {
    // The message left next-step because the next step boundary consumed it — that
    // is a steer that worked, not a downgrade, and only next-turn proves a downgrade.
    const harness = createHarness({ running: true, busyDelivery: 'steer', claimSteer: true });

    await harness.bridge.handleUserPrompt('user_target', '插话内容', [], 'msg_in', null);

    assert.equal(harness.prompts[0].mode, 'steer');
    assert.equal(harness.sentMessages.length, 0, 'an already-consumed steer must not be reported as queued');
  });

  it('should ignore a menu interaction from a user outside the allowlist', async () => {
    const harness = createHarness({ running: true, allowFrom: ['someone_else'] });
    harness.bridge.start();

    // The bound user is user_target, so this stranger is neither the owner nor allowlisted.
    harness.bridge.gateway.emit('interaction', {
      id: 'interact_blocked',
      type: 12,
      user_openid: 'intruder',
      data: { type: 12, resolved: { send_message: '/delivery' } },
    });
    await new Promise((r) => setTimeout(r, 20));

    assert.equal(harness.sentMessages.length, 0, 'a blocked interaction changes nothing');

    // The owner still gets through.
    harness.bridge.gateway.emit('interaction', {
      id: 'interact_owner',
      type: 12,
      user_openid: 'user_target',
      data: { type: 12, resolved: { send_message: '/delivery' } },
    });
    await new Promise((r) => setTimeout(r, 20));
    assert.match(harness.lastReply().text, /【插话方式】/);

    harness.bridge.stop();
  });
});
