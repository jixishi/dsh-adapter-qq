import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';

import { ScheduleNoticeStore, deliveryKey } from '../lib/sync/schedule-notices.js';
import { createSubscriptionRoute } from '../lib/qq/subscription-route.js';
import { MessageBridge } from '../lib/sync/message-bridge.js';

/**
 * Scheduled-task notifications (B + C).
 *
 * B: the official schedule plugin delivers a fired task as a user message with
 * `source.kind === 'schedule'`; the adapter reports the result when that turn
 * ends, because that is when the work produced something.
 * C: the 订阅管理 pane lists the tasks with a per-task switch.
 */

function tempStore(now = () => 1_000) {
  const dir = fs.mkdtempSync(join(os.tmpdir(), 'dsh-sched-'));
  const store = new ScheduleNoticeStore({ filePath: join(dir, 'schedule-notices.json'), now });
  store.load();
  return { store, dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

describe('ScheduleNoticeStore', () => {
  it('enables notifications by default', () => {
    const { store, cleanup } = tempStore();
    try {
      assert.equal(store.isEnabled('brand-new'), true);
      assert.equal(store.isEnabled(''), false);
    } finally {
      cleanup();
    }
  });

  it('remembers a switch across a reload', () => {
    const { store, dir, cleanup } = tempStore();
    try {
      store.update('t1', { enabled: false, title: '每日备份', sessionId: 'sess-1' });
      const second = new ScheduleNoticeStore({ filePath: join(dir, 'schedule-notices.json') });
      second.load();
      assert.equal(second.isEnabled('t1'), false);
      assert.equal(second.tasks.get('t1').title, '每日备份');
    } finally {
      cleanup();
    }
  });

  it('treats a corrupt file as empty instead of throwing', () => {
    const dir = fs.mkdtempSync(join(os.tmpdir(), 'dsh-sched-bad-'));
    try {
      const file = join(dir, 'schedule-notices.json');
      fs.writeFileSync(file, '{not json', 'utf8');
      const store = new ScheduleNoticeStore({ filePath: file });
      const result = store.load();
      assert.equal(result.ok, false);
      assert.equal(store.tasks.size, 0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('claims a delivery once and records when it was announced', () => {
    const { store, cleanup } = tempStore();
    try {
      const key = deliveryKey('sess-1', 5_000);
      assert.equal(store.claim('t1', key), true);
      assert.equal(store.claim('t1', key), false, 'the same firing is never announced twice');
      assert.equal(store.claim('t1', deliveryKey('sess-1', 6_000)), true, 'a later firing is new');
      assert.ok(store.tasks.get('t1').lastNotifiedAt > 0);
    } finally {
      cleanup();
    }
  });

  it('keys a delivery by session and second', () => {
    assert.equal(deliveryKey('a', 1_000), deliveryKey('a', 1_500));
    assert.notEqual(deliveryKey('a', 1_000), deliveryKey('b', 1_000));
    assert.notEqual(deliveryKey('a', 1_000), deliveryKey('a', 2_000));
  });
});

describe('subscription route task operations', () => {
  function call(handler, body) {
    const payload = JSON.stringify(body);
    return new Promise((resolve) => {
      const req = {
        method: 'POST',
        headers: { 'x-dsh-plugin': 'dsh-adapter-qq' },
        async *[Symbol.asyncIterator]() {
          yield payload;
        },
      };
      const res = {
        statusCode: 0,
        body: '',
        writeHead(code) {
          this.statusCode = code;
        },
        end(chunk) {
          this.body = chunk ?? '';
          resolve({ status: this.statusCode, json: JSON.parse(this.body) });
        },
      };
      void handler(req, res);
    });
  }

  const sessions = { list: async () => [], getActiveSessionId: async () => '' };

  it('lists tasks with their switch state', async () => {
    const { store, cleanup } = tempStore();
    try {
      store.update('t1', { enabled: false, title: '每日备份' });
      const handler = createSubscriptionRoute({
        store: { snapshot: () => [] },
        subscriptionStore: undefined,
        scheduleNotices: store,
        listScheduleTasks: async () => [
          { id: 't1', title: '每日备份', status: 'active', scheduledAt: '2026-11-06T12:00:00.000Z', sessionId: 's1' },
          { id: 't2', title: '周报', status: 'inactive', scheduledAt: '2026-11-01T12:00:00.000Z', sessionId: 's1' },
        ],
        ...sessions,
      });
      const { json } = await call(handler, { op: 'tasks' });
      assert.equal(json.ok, true);
      assert.equal(json.tasks.length, 2);
      assert.equal(json.tasks[0].enabled, false, 'the stored switch is reported');
      assert.equal(json.tasks[1].enabled, true, 'an unknown task defaults to on');
    } finally {
      cleanup();
    }
  });

  it('toggles one task and persists it', async () => {
    const { store, cleanup } = tempStore();
    try {
      const handler = createSubscriptionRoute({
        store: { snapshot: () => [] },
        scheduleNotices: store,
        listScheduleTasks: async () => [],
        ...sessions,
      });
      const { json } = await call(handler, { op: 'toggleTask', args: { id: 't9', enabled: false, title: '备份' } });
      assert.equal(json.ok, true);
      assert.equal(store.isEnabled('t9'), false);
    } finally {
      cleanup();
    }
  });

  it('reports NO_SCHEDULE when the store is missing', async () => {
    const handler = createSubscriptionRoute({ store: { snapshot: () => [] }, ...sessions });
    const { json } = await call(handler, { op: 'tasks' });
    assert.equal(json.ok, false);
    assert.equal(json.error.code, 'NO_SCHEDULE');
  });

  it('rejects a toggle without an id', async () => {
    const { store, cleanup } = tempStore();
    try {
      const handler = createSubscriptionRoute({ store: { snapshot: () => [] }, scheduleNotices: store, ...sessions });
      const { json } = await call(handler, { op: 'toggleTask', args: {} });
      assert.equal(json.ok, false);
      assert.equal(json.error.code, 'BAD_ARGS');
    } finally {
      cleanup();
    }
  });
});

describe('MessageBridge schedule notifications', () => {
  function harness({ enabled = true, tasks = [] } = {}) {
    const sent = [];
    const imageCalls = [];
    const store = {
      isEnabled: () => enabled,
      claimed: [],
      claim(taskId, key) {
        if (this.claimed.includes(key)) return false;
        this.claimed.push(key);
        return true;
      },
    };
    const bridge = new MessageBridge({
      ctx: { get: (name) => (name === 'schedule' ? { catalog: async () => tasks } : undefined), on: () => () => {} },
      apiClient: {
        sendC2CMessage: async (openid, msg) => {
          sent.push(msg);
          return { ok: true };
        },
        sendTyping: async () => ({ ok: true }),
      },
      gateway: { on: () => {}, send: async () => {} },
      sessionManager: {
        getActiveSessionId: async () => 'sess-1',
        getActiveSessions: async () => [],
        getSessionInfoById: async (id) => ({ sessionId: id, title: '会话', cwd: 'W:/p' }),
      },
      approvalHandler: { handleUserDecision: () => true },
      inventory: null,
      getConfig: () => ({ userOpenid: 'u1', allowFrom: ['*'] }),
      updateConfig: () => {},
    });
    bridge.scheduleNoticeStore = store;
    bridge.sendOverviewImage = async (openid, options) => {
      imageCalls.push(options);
    };
    return { bridge, sent, imageCalls, store };
  }

  const scheduleEvent = (text = '提醒事项：每日备份') => ({
    type: 'user/message',
    data: { source: { kind: 'schedule' }, content: [{ type: 'text', text }] },
  });

  it('recognises a schedule delivery', async () => {
    const { bridge } = harness();
    bridge.noteScheduleRun('sess-1', scheduleEvent());
    const run = bridge.scheduleRuns.get('sess-1');
    assert.ok(run, 'the run is tracked');
    assert.match(run.text, /每日备份/);
    bridge.scheduleRuns.clear();
  });

  it('reports the result when that turn ends', async () => {
    const { bridge, sent } = harness();
    bridge.noteScheduleRun('sess-1', scheduleEvent());
    bridge.scheduleRuns.get('sess-1').taskId = 't1';
    bridge.scheduleRuns.get('sess-1').title = '每日备份';
    await bridge.notifyScheduleRun('u1', 'sess-1', bridge.scheduleRuns.get('sess-1'), { lastText: '备份完成，共 12 个文件' }, 'completed');
    assert.equal(sent.length, 1);
    assert.match(sent[0].markdown, /每日备份/);
    assert.match(sent[0].markdown, /备份完成，共 12 个文件/);
  });

  it('sends a long result as an image', async () => {
    const { bridge, sent, imageCalls } = harness();
    const long = 'x'.repeat(1200);
    await bridge.notifyScheduleRun('u1', 'sess-1', { taskId: 't1', title: '长任务', at: 1000 }, { lastText: long }, 'completed');
    assert.equal(sent.length, 0, 'no plain message for a long result');
    assert.equal(imageCalls.length, 1);
    assert.ok(imageCalls[0].markdown.includes(long));
  });

  it('stays silent when the task switch is off', async () => {
    const { bridge, sent, imageCalls } = harness({ enabled: false });
    const result = await bridge.notifyScheduleRun('u1', 'sess-1', { taskId: 't1', title: 't', at: 1 }, { lastText: 'x' }, 'completed');
    assert.equal(result, false);
    assert.equal(sent.length + imageCalls.length, 0);
  });

  it('never reports the same firing twice', async () => {
    const { bridge, sent } = harness();
    const run = { taskId: 't1', title: 't', at: 5_000 };
    await bridge.notifyScheduleRun('u1', 'sess-1', run, { lastText: 'a' }, 'completed');
    await bridge.notifyScheduleRun('u1', 'sess-1', run, { lastText: 'a' }, 'completed');
    assert.equal(sent.length, 1);
  });

  it('mentions an abnormal end instead of claiming success', async () => {
    const { bridge, sent } = harness();
    await bridge.notifyScheduleRun('u1', 'sess-1', { taskId: 't1', title: '任务X', at: 1 }, { lastText: '部分结果' }, 'error');
    assert.match(sent[0].markdown, /未正常结束/);
  });

  it('does nothing without a store', async () => {
    const { bridge } = harness();
    bridge.scheduleNoticeStore = null;
    assert.equal(await bridge.notifyScheduleRun('u1', 's', { taskId: 't', at: 1 }, {}, 'completed'), false);
  });
});
