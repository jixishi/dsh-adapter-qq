import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { KeyboardBuilder } from '../lib/ui/keyboard.js';
import { SessionManager } from '../lib/sync/session-manager.js';
import { MessageBridge } from '../lib/sync/message-bridge.js';
import { QQApiClient } from '../lib/qq/client.js';

/**
 * PR #4 by @heerxingen: while a turn is running, a plain QQ message can either
 * interject immediately (`steer`) or wait for the next turn (`queue`). The choice
 * is a setting, overridable per message, and the user is only told about
 * deliveries they would otherwise be surprised by.
 */

function bridgeWith({ config = {}, inbox = { nextTurn: [], nextStep: [] }, running = false } = {}) {
  const sent = [];
  let cfg = { userOpenid: 'u1', allowFrom: ['*'], busyDelivery: 'steer', ...config };
  const admitted = [];
  // The receipt matches queued/steered rows by the requestId the prompt was
  // admitted with, so the fake inbox is told which one that was.
  let lastRequestId = null;

  const sessionManager = {
    getActiveSessionId: async () => 'sess-1',
    getActiveSessionInfo: async () => ({ sessionId: 'sess-1', title: 't', cwd: 'W:/p' }),
    getSessionInfoById: async (id) => ({ sessionId: id, title: 't', cwd: 'W:/p' }),
    getInbox: () => (typeof inbox === 'function' ? inbox(lastRequestId) : inbox),
    steerQueueItem: async () => ({ accepted: true }),
    removeQueueItem: async () => ({ accepted: true }),
  };

  const ctx = {
    get: (name) => {
      if (name === 'agents') return { get: () => (running ? { status: 'running' } : { status: 'idle' }) };
      if (name === 'sessionController')
        return {
          prompt: async (req) => {
            admitted.push(req);
            lastRequestId = req.requestId;
            return { accepted: true };
          },
        };
      return undefined;
    },
    on: () => () => {},
  };

  const bridge = new MessageBridge({
    ctx,
    apiClient: {
      sendC2CMessage: async (openid, msg) => {
        sent.push(msg);
        return { ok: true };
      },
      sendTyping: async () => ({ ok: true }),
    },
    gateway: { on: () => {}, send: async () => {} },
    sessionManager,
    approvalHandler: { handleUserDecision: () => true },
    inventory: null,
    getConfig: () => cfg,
    updateConfig: (patch) => {
      cfg = { ...cfg, ...patch };
    },
  });

  return { bridge, sent, admitted, getConfig: () => cfg };
}

describe('busyDelivery setting', () => {
  it('defaults to steer and can be switched by /delivery', async () => {
    const h = bridgeWith();
    assert.equal(h.getConfig().busyDelivery, 'steer');

    await h.bridge.cmdDelivery('u1', ['queue'], 'm1');
    assert.equal(h.getConfig().busyDelivery, 'queue');
    assert.match(h.sent.at(-1).content, /排队/);
  });

  it('accepts the Chinese aliases', async () => {
    const h = bridgeWith();
    await h.bridge.cmdDelivery('u1', ['插话'], 'm1');
    assert.equal(h.getConfig().busyDelivery, 'steer');
    await h.bridge.cmdDelivery('u1', ['排队'], 'm2');
    assert.equal(h.getConfig().busyDelivery, 'queue');
  });

  it('shows the current choice with a board when called without arguments', async () => {
    const h = bridgeWith({ config: { busyDelivery: 'queue' } });
    await h.bridge.cmdDelivery('u1', [], 'm1');
    const msg = h.sent.at(-1);
    assert.match(msg.markdown, /插话方式/);
    assert.match(msg.markdown, /← 当前/);
    assert.ok(msg.keyboard, 'the card offers the switch buttons');
  });

  it('ignores an unknown argument instead of corrupting the setting', async () => {
    const h = bridgeWith();
    await h.bridge.cmdDelivery('u1', ['nonsense'], 'm1');
    assert.equal(h.getConfig().busyDelivery, 'steer');
    assert.match(h.sent.at(-1).markdown, /插话方式/, 'falls back to showing the card');
  });
});

describe('prompt delivery mode', () => {
  it('uses the configured default while a turn is running', async () => {
    const h = bridgeWith({ running: true, config: { busyDelivery: 'queue' } });
    await h.bridge.handleUserPrompt('u1', '你好', [], 'm1');
    assert.equal(h.admitted[0].mode, 'queue');
  });

  it('lets /steer override the default for one message', async () => {
    const h = bridgeWith({ running: true, config: { busyDelivery: 'queue' } });
    await h.bridge.cmdSteer('u1', ['立刻注入'], 'm1');
    assert.equal(h.admitted[0].mode, 'steer');
  });

  it('lets /queue override a steer default', async () => {
    const h = bridgeWith({ running: true, config: { busyDelivery: 'steer' } });
    await h.bridge.cmdQueue('u1', ['稍后再发'], 'm1');
    assert.equal(h.admitted[0].mode, 'queue');
  });

  it('always uses queue when the session is idle', async () => {
    // Steering does not exist outside a running turn; DSH's documented idle path
    // is `queue`, which simply starts the next turn.
    const h = bridgeWith({ running: false, config: { busyDelivery: 'steer' } });
    await h.bridge.cmdSteer('u1', ['随手一句'], 'm1');
    assert.equal(h.admitted[0].mode, 'queue');
  });
});

describe('delivery receipts stay quiet unless they matter', () => {
  it('says nothing for a message that was steered as configured', async () => {
    const h = bridgeWith({ running: true, inbox: (rid) => ({ nextTurn: [], nextStep: [{ id: 'x', source: { rpcId: rid } }] }) });
    await h.bridge.handleUserPrompt('u1', '你好', [], 'm1');
    assert.equal(h.sent.length, 0);
  });

  it('says nothing for a plain message sent while idle', async () => {
    const h = bridgeWith({ running: false });
    await h.bridge.handleUserPrompt('u1', '你好', [], 'm1');
    assert.equal(h.sent.length, 0);
  });

  it('reports a queued message with its position', async () => {
    const h = bridgeWith({
      running: true,
      config: { busyDelivery: 'queue' },
      inbox: (rid) => ({
        nextTurn: [{ id: 'a', source: {} }, { id: 'b', source: { rpcId: rid } }],
        nextStep: [],
      }),
    });
    await h.bridge.handleUserPrompt('u1', '排队这条', [], 'm1');
    const msg = h.sent.at(-1);
    assert.match(msg.markdown, /已排队/);
    assert.match(msg.markdown, /第 2 条/);
    assert.ok(msg.keyboard, 'queued messages get the steer/remove board');
  });

  it('tells the user when an explicit steer found no running turn', async () => {
    const h = bridgeWith({ running: false });
    await h.bridge.cmdSteer('u1', ['插话这句'], 'm1');
    assert.match(h.sent.at(-1).markdown, /没有运行中的轮次/);
  });
});

describe('queue listing and actions', () => {
  it('lists queued messages with a board', async () => {
    const h = bridgeWith({
      inbox: { nextTurn: [{ id: 'a', content: [{ type: 'text', text: '第一条' }], source: {} }], nextStep: [] },
    });
    await h.bridge.cmdQueueList('u1', 'm1');
    const msg = h.sent.at(-1);
    assert.match(msg.markdown, /第一条/);
    assert.ok(msg.keyboard);
  });

  it('says the queue is empty when it is', async () => {
    const h = bridgeWith();
    await h.bridge.cmdQueueList('u1', 'm1');
    assert.match(h.sent.at(-1).content, /没有排队中的消息/);
  });

  it('describes a text-less message by its source kind', () => {
    const h = bridgeWith();
    const line = h.bridge.describeQueuedMessage({ content: [], source: { kind: 'user' } });
    assert.match(line, /user/);
  });

  it('turns a queue failure into an explanation', () => {
    const h = bridgeWith();
    assert.match(
      h.bridge.describeQueueError({ code: 'session/steer-unavailable' }),
      /下一轮正常发送/,
    );
    assert.match(
      h.bridge.describeQueueError({ code: 'session/queue-item-not-found' }),
      /已开始执行/,
    );
  });

  it('reports a failed steer rather than throwing', async () => {
    const h = bridgeWith();
    h.bridge.sessionManager.steerQueueItem = async () => {
      const err = new Error('gone');
      err.code = 'session/queue-item-not-found';
      throw err;
    };
    await h.bridge.cmdQueueSteer('u1', ['abc'], 'm1');
    assert.match(h.sent.at(-1).content, /已开始执行/);
  });
});

describe('delivery menu', () => {
  it('is registered as a submenu, the same way as 权限模式 and 模型与思考', () => {
    const client = new QQApiClient({ appId: '123', clientSecret: 'sec' });
    const { items } = client.getDefaultMenu({ usage: true });
    const delivery = items.find((item) => item.name === '插话方式');

    assert.ok(delivery, 'the menu carries an 插话方式 entry');
    assert.equal(delivery.type, 'menu', 'it is a submenu, not a flat send_message row');
    assert.ok(Array.isArray(delivery.sub_menu_items));
    assert.ok(delivery.sub_menu_items.length <= 5, 'QQ allows at most 5 sub-items');
    assert.ok(items.length <= 10, 'top-level items must stay <= 10');

    const targets = delivery.sub_menu_items.map((sub) => sub.send_message);
    assert.deepEqual(targets, ['/delivery steer', '/delivery queue', '/delivery']);
  });

  it('does not occupy a top-level slot of its own', () => {
    const client = new QQApiClient({ appId: '123', clientSecret: 'sec' });
    const { items } = client.getDefaultMenu();
    const flat = items.filter((item) => item.type !== 'menu').map((item) => item.name);
    assert.ok(!flat.includes('插话方式'), 'it moved into a submenu');
  });
});

describe('delivery boards', () => {
  it('marks the active choice', () => {
    const board = KeyboardBuilder.buildDeliveryBoard('queue');
    const text = JSON.stringify(board);
    assert.match(text, /✅ 📥 排队/);
    assert.match(text, /\/delivery steer/);
    assert.match(text, /\/delivery queue/);
  });

  it('caps the queue board at five actionable rows', () => {
    const items = Array.from({ length: 9 }, (_, i) => ({ itemId: `id${i}` }));
    const board = KeyboardBuilder.buildQueueListBoard(items);
    const text = JSON.stringify(board);
    assert.match(text, /\/qsteer id4/);
    assert.doesNotMatch(text, /\/qsteer id5/, 'only the first five are actionable');
    assert.match(text, /\/qdrop id0/);
  });
});

describe('SessionManager.getInbox', () => {
  it('reads both queues from the inbox projection', () => {
    const live = { id: 's' };
    const m = new SessionManager({
      ctx: {
        get: (name) => {
          if (name === 'sessions') return new Map([['s', live]]);
          if (name === 'sessionProjections')
            return { stateOf: () => ({ 'next-turn': [{ id: '1' }], 'next-step': [{ id: '2' }] }) };
          return undefined;
        },
        on: () => () => {},
      },
      getActiveSessionId: async () => 's',
      setActiveSessionId: async () => {},
      logger: null,
    });
    const inbox = m.getInbox('s');
    assert.equal(inbox.nextTurn.length, 1);
    assert.equal(inbox.nextStep.length, 1);
  });

  it('degrades to empty queues when the projection is unavailable', () => {
    const m = new SessionManager({
      ctx: { get: () => undefined, on: () => () => {} },
      getActiveSessionId: async () => null,
      setActiveSessionId: async () => {},
      logger: null,
    });
    assert.deepEqual(m.getInbox('s'), { nextTurn: [], nextStep: [] });
  });
});
