import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  DEFAULT_INTERVAL_MINUTES,
  SUBSCRIPTION_INTERVALS,
  SubscriptionScheduler,
  SubscriptionStore,
  buildSubscriptionDigest,
  intervalLabel,
  normalizeIntervalMinutes,
  previewMessage,
} from '../lib/sync/subscriptions.js';
import { formatDueIn } from '../lib/sync/display-time.js';

const silent = { warn() {}, info() {}, error() {} };

/** Fake clock so the coalescing windows are deterministic. */
function makeClock(start = 1_700_000_000_000) {
  let value = start;
  return {
    now: () => value,
    advance(ms) {
      value += ms;
    },
    set(ms) {
      value = ms;
    },
  };
}

describe('subscription intervals', () => {
  it('offers the documented buckets and default', () => {
    assert.deepEqual([...SUBSCRIPTION_INTERVALS], [1, 5, 15, 30, 60]);
    assert.equal(DEFAULT_INTERVAL_MINUTES, 5);
  });

  it('snaps unknown values to the nearest supported bucket', () => {
    assert.equal(normalizeIntervalMinutes(5), 5);
    assert.equal(normalizeIntervalMinutes(7), 5);
    assert.equal(normalizeIntervalMinutes(12), 15);
    assert.equal(normalizeIntervalMinutes(28), 30);
    assert.equal(normalizeIntervalMinutes(999), 60);
    // Invalid input falls back to the default rather than producing NaN timers.
    assert.equal(normalizeIntervalMinutes(0), DEFAULT_INTERVAL_MINUTES);
    assert.equal(normalizeIntervalMinutes(-5), DEFAULT_INTERVAL_MINUTES);
    assert.equal(normalizeIntervalMinutes('abc'), DEFAULT_INTERVAL_MINUTES);
    assert.equal(normalizeIntervalMinutes(undefined), DEFAULT_INTERVAL_MINUTES);
  });

  it('labels intervals in Chinese', () => {
    assert.equal(intervalLabel(5), '5 分钟');
    assert.equal(intervalLabel(60), '1 小时');
    assert.equal(intervalLabel(7), '5 分钟');
  });
});

describe('subscription digest', () => {
  it('summarises one window of messages', () => {
    const at = Date.now();
    const digest = buildSubscriptionDigest({
      title: '后端重构',
      sessionId: 'sess-1',
      intervalMinutes: 5,
      messages: [
        { text: '开始重构', at },
        { text: '改了鉴权', at: at + 30_000 },
        { text: '测试通过', at: at + 60_000 },
      ],
    });
    assert.equal(digest.count, 3);
    assert.ok(digest.markdown.includes('后端重构'));
    assert.ok(digest.markdown.includes('后端重构') && digest.markdown.includes('5 分钟'));
    for (const needle of ['开始重构', '改了鉴权', '测试通过']) {
      assert.ok(digest.markdown.includes(needle), `digest must include ${needle}`);
    }
    // The reply affordance is what makes quick-reply discoverable.
    assert.ok(digest.markdown.includes('/unsubscribe'));
  });

  it('includes every buffered message instead of folding to a fixed count', () => {
    const at = Date.now();
    const messages = Array.from({ length: 12 }, (_, index) => ({
      text: `消息 ${index + 1}`,
      at: at + index * 1000,
    }));
    const digest = buildSubscriptionDigest({ title: '很多', sessionId: 's', messages });
    assert.equal(digest.count, 12);
    // No artificial "5 previews" cap: dropping content was never a requirement and
    // it also kept digests under the length budget, making the image fallback dead
    // code. Delivery form is decided by measured length, not by discarding text.
    assert.ok(!digest.markdown.includes('省略'), 'nothing may be elided');
    for (let i = 1; i <= 12; i += 1) {
      assert.ok(digest.markdown.includes(`消息 ${i}`), `digest must keep 消息 ${i}`);
    }
  });

  it('grows past the single-message budget once enough messages accumulate', () => {
    const at = Date.now();
    const make = (n) =>
      Array.from({ length: n }, (_, i) => ({
        text: `第${i + 1}条：${'内容'.repeat(120)}`,
        at: at + i * 1000,
      }));
    // This is what makes "too long -> send an image" reachable at all.
    const small = buildSubscriptionDigest({ title: 't', sessionId: 's', messages: make(5) });
    const large = buildSubscriptionDigest({ title: 't', sessionId: 's', messages: make(30) });
    assert.ok(small.markdown.length <= 3800, `5 条不该超限: ${small.markdown.length}`);
    assert.ok(large.markdown.length > 3800, `30 条应当超限: ${large.markdown.length}`);
  });

  it('handles an empty window without throwing', () => {
    const digest = buildSubscriptionDigest({ title: '', sessionId: 'abc', messages: [] });
    assert.equal(digest.count, 0);
    assert.ok(digest.markdown.includes('abc'));
  });

  it('strips internal tags from previews', () => {
    const preview = previewMessage('<think>hidden</think>真实内容<system-reminder>x</system-reminder>');
    assert.equal(preview, '真实内容');
    const long = previewMessage('a'.repeat(500));
    assert.ok(long.length <= 281, `preview too long: ${long.length}`);
    assert.ok(long.endsWith('…'));
  });
});

describe('SubscriptionStore', () => {
  let dir;
  let clock;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-sub-test-'));
    clock = makeClock();
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const makeStore = (name = 'store.json') =>
    new SubscriptionStore({ filePath: path.join(dir, name), now: clock.now, logger: silent });

  it('adds, lists and removes subscriptions', async () => {
    const store = makeStore();
    await store.subscribe({ sessionId: 'a', title: 'A', intervalMinutes: 5 });
    await store.subscribe({ sessionId: 'b', title: 'B', intervalMinutes: 15 });
    assert.equal(store.list().length, 2);
    assert.equal(store.has('a'), true);
    assert.equal(store.get('b').title, 'B');

    assert.equal(await store.unsubscribe('a'), true);
    assert.equal(store.has('a'), false);
    assert.equal(store.list().length, 1);
    // Removing a missing subscription reports it instead of silently succeeding.
    assert.equal(await store.unsubscribe('a'), false);
  });

  it('keeps createdAt on re-subscribe so the order is stable', async () => {
    const store = makeStore();
    const first = await store.subscribe({ sessionId: 'a', title: 'A', intervalMinutes: 5 });
    clock.advance(60_000);
    const second = await store.subscribe({ sessionId: 'a', title: 'A2', intervalMinutes: 15 });
    assert.equal(second.createdAt, first.createdAt);
    assert.equal(second.intervalMinutes, 15);
    assert.equal(second.title, 'A2');
  });

  it('buffers messages and only releases them once the window closes', async () => {
    const store = makeStore();
    await store.subscribe({ sessionId: 'a', intervalMinutes: 5 });

    const enqueued = store.enqueue('a', { text: 'one', at: clock.now() });
    assert.equal(enqueued.queued, true);
    assert.equal(enqueued.count, 1);
    assert.equal(enqueued.intervalMs, 5 * 60 * 1000);

    clock.advance(30_000);
    store.enqueue('a', { text: 'two', at: clock.now() });
    assert.equal(store.buffers.get('a').messages.length, 2);

    // Not yet due.
    assert.deepEqual(store.dueSessionIds(), []);

    clock.advance(4.5 * 60_000);
    assert.deepEqual(store.dueSessionIds(), ['a']);

    const digest = store.digestFor('a');
    assert.equal(digest.count, 2);
    // Building a digest must NOT consume the buffer: a failed send would
    // otherwise lose the messages. Only commit() (after delivery) drops them.
    assert.equal(store.buffers.get('a').messages.length, 2);
    assert.equal(store.commit('a'), true);
    assert.equal(store.buffers.get('a'), undefined);
    assert.equal(store.digestFor('a'), null);
  });

  it('starts the next window from the first message of that window', async () => {
    const store = makeStore();
    await store.subscribe({ sessionId: 'a', intervalMinutes: 5 });
    store.enqueue('a', { text: 'one', at: clock.now() });
    clock.advance(5 * 60_000);
    store.digestFor('a');
    store.commit('a');

    store.enqueue('a', { text: 'two', at: clock.now() });
    // A continuous stream must not push the deadline back.
    clock.advance(60_000);
    store.enqueue('a', { text: 'three', at: clock.now() });
    assert.equal(store.dueInMs('a'), 4 * 60_000);
  });

  it('ignores messages for unsubscribed sessions and empty text', async () => {
    const store = makeStore();
    assert.equal(store.enqueue('nobody', { text: 'x' }).queued, false);
    await store.subscribe({ sessionId: 'a', intervalMinutes: 5 });
    assert.equal(store.enqueue('a', { text: '   ' }).queued, false);
    assert.equal(store.pendingCount(), 0);
  });

  it('bounds the buffer so a chatty session cannot grow without limit', async () => {
    const store = makeStore();
    await store.subscribe({ sessionId: 'a', intervalMinutes: 60 });
    for (let i = 0; i < 60; i += 1) store.enqueue('a', { text: `m${i}`, at: clock.now() });
    assert.ok(store.buffers.get('a').messages.length <= 40);
    // The newest message is retained, the oldest is dropped.
    assert.ok(store.buffers.get('a').messages.some((m) => m.text === 'm59'));
    assert.ok(!store.buffers.get('a').messages.some((m) => m.text === 'm0'));
  });

  it('tracks independent intervals per session', async () => {
    const store = makeStore();
    await store.subscribe({ sessionId: 'fast', intervalMinutes: 1 });
    await store.subscribe({ sessionId: 'slow', intervalMinutes: 30 });
    store.enqueue('fast', { text: 'f', at: clock.now() });
    store.enqueue('slow', { text: 's', at: clock.now() });

    clock.advance(61_000);
    assert.deepEqual(store.dueSessionIds(), ['fast']);
    clock.advance(29 * 60_000);
    assert.deepEqual(store.dueSessionIds().sort(), ['fast', 'slow']);
  });

  it('persists atomically and reloads', async () => {
    const store = makeStore();
    await store.subscribe({ sessionId: 'a', title: '甲', intervalMinutes: 15 });
    await store.subscribe({ sessionId: 'b', title: '乙', intervalMinutes: 60 });

    const raw = JSON.parse(fs.readFileSync(store.filePath, 'utf8'));
    assert.equal(raw.version, 1);
    assert.equal(raw.subscriptions.length, 2);

    const reloaded = makeStore();
    const result = reloaded.load();
    assert.equal(result.ok, true);
    assert.equal(reloaded.list().length, 2);
    assert.equal(reloaded.get('a').intervalMinutes, 15);
    assert.equal(reloaded.get('b').title, '乙');
  });

  it('degrades to an empty store when the file is corrupt', () => {
    const store = makeStore('corrupt.json');
    fs.writeFileSync(store.filePath, '{ this is not json', 'utf8');
    const result = store.load();
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'bad-json');
    assert.equal(store.list().length, 0);
  });

  it('reports a missing file without warning', () => {
    const store = makeStore('absent.json');
    const result = store.load();
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'missing');
    // An absent file is the normal first-run state, not an error.
    assert.equal(store.list().length, 0);
  });

  it('exposes a snapshot for the UI', async () => {
    const store = makeStore();
    await store.subscribe({ sessionId: 'a', title: '甲', intervalMinutes: 5 });
    store.enqueue('a', { text: 'pending', at: clock.now() });
    const snapshot = store.snapshot();
    assert.equal(snapshot.subscriptions.length, 1);
    assert.equal(snapshot.subscriptions[0].pendingCount, 1);
    assert.equal(snapshot.subscriptions[0].intervalLabel, '5 分钟');
    assert.equal(snapshot.defaultInterval, 5);
    assert.deepEqual(snapshot.intervals, [1, 5, 15, 30, 60]);
    assert.equal(snapshot.pending, 1);
  });

  it('updates the interval and rejects unknown sessions', async () => {
    const store = makeStore();
    await store.subscribe({ sessionId: 'a', intervalMinutes: 5 });
    const updated = await store.setIntervalMinutes('a', 30);
    assert.equal(updated.intervalMinutes, 30);
    assert.equal(await store.setIntervalMinutes('nope', 30), null);
  });
});

describe('SubscriptionScheduler', () => {
  let dir;
  let clock;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-sub-sched-'));
    clock = makeClock();
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('flushes due windows and clears the buffer', async () => {
    const store = new SubscriptionStore({ filePath: '', now: clock.now, logger: silent });
    await store.subscribe({ sessionId: 'a', title: 'A', intervalMinutes: 5 });

    const flushed = [];
    const scheduler = new SubscriptionScheduler({
      store,
      flush: async (sessionId, digest) => {
        flushed.push({ sessionId, count: digest.count });
      },
      logger: silent,
    });

    store.enqueue('a', { text: 'one', at: clock.now() });
    // Move the shared clock past the deadline so arm() schedules a 0ms timeout.
    clock.advance(6 * 60_000);
    scheduler.arm();
    await new Promise((resolve) => setTimeout(resolve, 40));

    assert.deepEqual(flushed, [{ sessionId: 'a', count: 1 }]);
    assert.equal(store.buffers.get('a'), undefined);
    scheduler.stop();
  });

  it('inherits the store clock so deadlines always agree', () => {
    const store = new SubscriptionStore({ filePath: '', now: clock.now, logger: silent });
    const scheduler = new SubscriptionScheduler({
      store,
      flush: async () => {},
      // Deliberately different: the store's clock must win.
      now: () => 0,
      logger: silent,
    });
    assert.equal(scheduler.now, clock.now);
    scheduler.stop();
  });

  it('survives a throwing flush callback', async () => {
    const store = new SubscriptionStore({ filePath: '', now: clock.now, logger: silent });
    await store.subscribe({ sessionId: 'a', intervalMinutes: 1 });
    let attempts = 0;
    const scheduler = new SubscriptionScheduler({
      store,
      flush: async () => {
        attempts += 1;
        throw new Error('QQ down');
      },
      logger: silent,
    });
    store.enqueue('a', { text: 'one', at: clock.now() });
    clock.advance(2 * 60_000);
    scheduler.arm();
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(attempts, 1);
    // The failure must not leave a dangling timer that keeps firing.
    scheduler.stop();
  });

  it('does not arm anything when no window is open', () => {
    const store = new SubscriptionStore({ filePath: '', now: clock.now, logger: silent });
    const scheduler = new SubscriptionScheduler({ store, flush: async () => {}, logger: silent });
    scheduler.arm();
    assert.equal(scheduler.timer, null);
    scheduler.stop();
  });
});

describe('immediate flush ("立即推送")', () => {
  let dir;
  let clock;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-sub-flush-'));
    clock = makeClock();
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('flushes a window that is NOT yet due', async () => {
    const store = new SubscriptionStore({ filePath: '', now: clock.now, logger: silent });
    await store.subscribe({ sessionId: 'a', title: 'A', intervalMinutes: 15 });
    store.enqueue('a', { text: '刚刚到达的消息', at: clock.now() });

    // Nothing is due yet: this is exactly the case the button used to ignore.
    assert.deepEqual(store.dueSessionIds(), []);

    const sent = [];
    const scheduler = new SubscriptionScheduler({
      store,
      flush: async (sessionId, digest) => sent.push({ sessionId, count: digest.count }),
      logger: silent,
    });

    const flushed = await scheduler.flushAll();
    assert.deepEqual(flushed, ['a']);
    assert.deepEqual(sent, [{ sessionId: 'a', count: 1 }]);
    // The buffer is consumed, so the countdown disappears.
    assert.equal(store.buffers.get('a'), undefined);
    scheduler.stop();
  });

  it('flushes every buffered session, not just the earliest', async () => {
    const store = new SubscriptionStore({ filePath: '', now: clock.now, logger: silent });
    await store.subscribe({ sessionId: 'fast', intervalMinutes: 1 });
    await store.subscribe({ sessionId: 'slow', intervalMinutes: 60 });
    store.enqueue('fast', { text: 'f', at: clock.now() });
    store.enqueue('slow', { text: 's', at: clock.now() });

    const sent = [];
    const scheduler = new SubscriptionScheduler({
      store,
      flush: async (sessionId) => sent.push(sessionId),
      logger: silent,
    });

    const flushed = await scheduler.flushAll();
    assert.deepEqual(flushed.sort(), ['fast', 'slow']);
    assert.deepEqual(sent.sort(), ['fast', 'slow']);
    assert.equal(store.pendingCount(), 0);
    scheduler.stop();
  });

  it('reports nothing when the buffers are empty', async () => {
    const store = new SubscriptionStore({ filePath: '', now: clock.now, logger: silent });
    await store.subscribe({ sessionId: 'a', intervalMinutes: 5 });
    const scheduler = new SubscriptionScheduler({ store, flush: async () => {}, logger: silent });
    assert.deepEqual(await scheduler.flushAll(), []);
    scheduler.stop();
  });

  it('leaves due-only flushing unchanged', async () => {
    const store = new SubscriptionStore({ filePath: '', now: clock.now, logger: silent });
    await store.subscribe({ sessionId: 'a', intervalMinutes: 5 });
    store.enqueue('a', { text: 'x', at: clock.now() });

    const sent = [];
    const scheduler = new SubscriptionScheduler({
      store,
      flush: async (sessionId) => sent.push(sessionId),
      logger: silent,
    });
    // runDue keeps honouring the window.
    assert.deepEqual(await scheduler.runDue(), []);
    assert.deepEqual(sent, []);
    scheduler.stop();
  });
});

describe('next push countdown', () => {
  it('formats the remaining wait for the pane', () => {
    assert.equal(formatDueIn(-1), '');
    assert.equal(formatDueIn(0), '即将推送');
    assert.equal(formatDueIn(900), '1秒后推送');
    assert.equal(formatDueIn(59_000), '59秒后推送');
    assert.equal(formatDueIn(252_000), '4分12秒后推送');
    assert.equal(formatDueIn(3_720_000), '1小时2分后推送');
    // Junk must not leak NaN into the UI.
    assert.equal(formatDueIn(undefined), '');
    assert.equal(formatDueIn('abc'), '');
  });

  it('exposes the countdown on each subscription in the snapshot', async () => {
    const store = new SubscriptionStore({ filePath: '', now: () => 1_000_000, logger: silent });
    await store.subscribe({ sessionId: 'a', intervalMinutes: 5 });
    // No buffered message -> no countdown.
    assert.equal(store.snapshot().subscriptions[0].dueInLabel, '');

    store.enqueue('a', { text: 'x', at: 1_000_000 });
    const snap = store.snapshot().subscriptions[0];
    assert.equal(snap.dueInMs, 5 * 60 * 1000);
    assert.equal(snap.dueInLabel, '5分0秒后推送');
  });
});
