import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { SubscriptionScheduler, SubscriptionStore } from '../lib/sync/subscriptions.js';
import { MessageBridge } from '../lib/sync/message-bridge.js';

/**
 * Lifecycle regression: MessageBridge#start() begins with `this.stop()`.
 *
 * stop() used to null out `subscriptionScheduler`, so every later enqueue() called
 * arm() on null. The pane kept counting buffered messages ("N 条待推送") while no
 * timer ever fired and "立即推送" reported "没有待推送的消息" because the buffer had
 * already been consumed by digestFor(). Both symptoms came from this one line.
 *
 * The scheduler's lifetime belongs to index.js (which disposes it with the
 * plugin), not to the bridge's start/stop cycle.
 */

const silent = { warn() {}, info() {}, error() {} };

function makeBridge() {
  const store = new SubscriptionStore({ filePath: '', now: () => Date.now(), logger: silent });
  const scheduler = new SubscriptionScheduler({
    store,
    flush: async () => true,
    logger: silent,
  });
  const bridge = Object.create(MessageBridge.prototype);
  Object.assign(bridge, {
    subscriptionStore: store,
    subscriptionScheduler: scheduler,
    eventDisposers: [],
    streamTimers: new Map(),
    streamState: new Map(),
    assistantBuffers: new Map(),
    recentRpcIds: new Set(),
    userNewSessionState: new Map(),
    userModelPageState: new Map(),
    userSessionPageState: new Map(),
    userSkillsPageState: new Map(),
    userMcpPageState: new Map(),
    lastAssistantText: new Map(),
    userReplyTarget: new Map(),
    subscriptionNoticeByMsgId: new Map(),
    toolAggregateTimer: null,
    toolBuffer: null,
  });
  return { bridge, store, scheduler };
}

describe('subscription scheduler lifecycle', () => {
  it('survives the stop() that start() performs', () => {
    const { bridge, scheduler } = makeBridge();
    bridge.stop();

    assert.ok(bridge.subscriptionScheduler, 'scheduler must stay attached across start/stop');
    assert.equal(scheduler.stopped, false, 'stop() must not permanently stop the scheduler');
  });

  it('can still arm after a start/stop cycle', async () => {
    const { bridge, store, scheduler } = makeBridge();
    bridge.stop();

    await store.subscribe({ sessionId: 'sess-x', intervalMinutes: 1 });
    const queued = store.enqueue('sess-x', { text: '后台新消息', at: Date.now() });
    assert.equal(queued.queued, true);

    let armed = false;
    const original = scheduler.arm.bind(scheduler);
    scheduler.arm = () => {
      armed = true;
      return original();
    };
    bridge.subscriptionScheduler?.arm?.();
    assert.equal(armed, true, 'bridge must be able to arm the scheduler');
    assert.notEqual(scheduler.timer, null, 'a real timer must be scheduled');

    scheduler.stop();
    store.dispose();
  });

  it('clears one-shot reply targets but keeps subscriptions', async () => {
    const { bridge, store } = makeBridge();
    await store.subscribe({ sessionId: 'keep-me', intervalMinutes: 5 });
    bridge.setReplyTarget('openid', 'sess-x', 'title');
    assert.equal(bridge.userReplyTarget.size, 1);

    bridge.stop();

    // Persisted subscriptions are user data and must outlive a restart.
    assert.equal(store.has('keep-me'), true);
    // A pending directed reply is per-process state and must not leak.
    assert.equal(bridge.userReplyTarget.size, 0);
  });
});

describe('digest delivery does not lose messages', () => {
  it('keeps the buffer until commit() is called', async () => {
    const store = new SubscriptionStore({ filePath: '', now: () => Date.now(), logger: silent });
    await store.subscribe({ sessionId: 'a', intervalMinutes: 1 });
    store.enqueue('a', { text: 'one', at: Date.now() });
    store.enqueue('a', { text: 'two', at: Date.now() });

    const digest = store.digestFor('a');
    assert.equal(digest.count, 2);
    // Building a digest must not consume it.
    assert.equal(store.pendingCount(), 2);

    assert.equal(store.commit('a'), true);
    assert.equal(store.pendingCount(), 0);
    assert.equal(store.get('a').totalNotified, 2);
  });

  it('leaves messages buffered when delivery reports failure', async () => {
    const store = new SubscriptionStore({ filePath: '', now: () => Date.now(), logger: silent });
    await store.subscribe({ sessionId: 'a', intervalMinutes: 1 });
    store.enqueue('a', { text: 'one', at: Date.now() });

    const scheduler = new SubscriptionScheduler({
      store,
      // The bridge returns false when it cannot deliver (no bound user, gateway down).
      flush: async () => false,
      logger: silent,
    });

    const flushed = await scheduler.flushAll();
    assert.deepEqual(flushed, [], 'nothing counts as flushed');
    assert.equal(store.pendingCount(), 1, 'the message must survive a failed send');
    assert.equal(store.get('a').totalNotified, 0);

    scheduler.stop();
  });

  it('backs off instead of spinning on repeated failures', async () => {
    const store = new SubscriptionStore({ filePath: '', now: () => Date.now(), logger: silent });
    await store.subscribe({ sessionId: 'a', intervalMinutes: 5 });
    store.enqueue('a', { text: 'one', at: Date.now() });

    let attempts = 0;
    const scheduler = new SubscriptionScheduler({
      store,
      flush: async () => {
        attempts += 1;
        throw new Error('QQ down');
      },
      logger: silent,
    });

    await scheduler.flushAll();
    assert.equal(attempts, 1);
    const failure = scheduler.failures.get('a');
    assert.ok(failure, 'a failed delivery must be recorded');
    assert.ok(failure.retryAt > Date.now(), 'the next attempt must be pushed into the future');

    // A second immediate flush is allowed (user-initiated) but the timer must not
    // be armed at 0ms, which is what caused the retry storm.
    scheduler.arm();
    assert.ok(scheduler.armedFor > Date.now(), 'arm() must respect the backoff deadline');

    scheduler.stop();
  });
});
