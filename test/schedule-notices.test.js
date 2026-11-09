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

  it('separates two tasks firing in one session within the same second', () => {
    // Two scheduled tasks bound to one session can fire together; they are two
    // deliveries, and keying by session alone collapsed them into one notice.
    assert.notEqual(deliveryKey('s1', 1_000, 'task-a'), deliveryKey('s1', 1_000, 'task-b'));
    assert.equal(deliveryKey('s1', 1_000, 'task-a'), deliveryKey('s1', 1_000, 'task-a'));
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

  /** First tracked run of a session (the map holds a queue per session). */
  const firstRun = (bridge, sessionId = 'sess-1') => (bridge.scheduleRuns.get(sessionId) || [])[0];

  it('recognises a schedule delivery', async () => {
    const { bridge } = harness();
    bridge.noteScheduleRun('sess-1', scheduleEvent());
    const run = firstRun(bridge);
    assert.ok(run, 'the run is tracked');
    assert.match(run.text, /每日备份/);
    bridge.scheduleRuns.clear();
  });

  it('reports the result when that turn ends', async () => {
    const { bridge, sent } = harness();
    bridge.noteScheduleRun('sess-1', scheduleEvent());
    const run = firstRun(bridge);
    run.taskId = 't1';
    run.title = '每日备份';
    await bridge.notifyScheduleRun('u1', 'sess-1', run, { lastText: '备份完成，共 12 个文件' }, 'completed');
    assert.equal(sent.length, 1);
    assert.match(sent[0].markdown, /每日备份/);
    assert.match(sent[0].markdown, /备份完成，共 12 个文件/);
    // A delivery is a push, not a reply: it must not repeat the action board.
    assert.equal(sent[0].keyboard, undefined, 'no action board under a task notice');
  });

  it('keeps every delivery when a session accumulates a queue', async () => {
    const { bridge } = harness();
    bridge.noteScheduleRun('sess-1', scheduleEvent('提醒一'));
    bridge.noteScheduleRun('sess-1', scheduleEvent('提醒二'));
    const runs = bridge.scheduleRuns.get('sess-1');
    assert.equal(runs.length, 2, 'a busy session queues deliveries instead of overwriting them');
    assert.match(runs[0].text, /提醒一/);
    assert.match(runs[1].text, /提醒二/);
    bridge.scheduleRuns.clear();
  });

  it('reports each queued delivery once the shared turn ends', async () => {
    const { bridge, sent } = harness();
    bridge.noteScheduleRun('sess-1', scheduleEvent('提醒一'));
    bridge.noteScheduleRun('sess-1', scheduleEvent('提醒二'));
    const runs = bridge.scheduleRuns.get('sess-1');
    runs[0].taskId = 't1';
    runs[0].title = '任务一';
    runs[1].taskId = 't2';
    runs[1].title = '任务二';

    await bridge.trackScheduleEvent('sess-1', { type: 'turn/start', data: { turn: 't9' } }, 'u1');
    await bridge.trackScheduleEvent(
      'sess-1',
      { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '两个任务都完成' }] } } },
      'u1'
    );
    await bridge.trackScheduleEvent('sess-1', { type: 'turn/end', data: { turn: 't9', reason: { kind: 'completed' } } }, 'u1');
    await new Promise((r) => setTimeout(r, 5));

    assert.equal(sent.length, 2, 'both deliveries are announced');
    assert.ok(sent.some((m) => /任务一/.test(m.markdown)));
    assert.ok(sent.some((m) => /任务二/.test(m.markdown)));
    assert.equal(bridge.scheduleRuns.size, 0, 'the queue drains');
  });

  it('tracks a reminder the host queued on a busy session', async () => {
    const { bridge } = harness();
    // A busy session gets `agent/inbox/spliced` instead of `user/message`.
    await bridge.handleDshSessionEvent(
      { id: 'sess-1' },
      {
        type: 'agent/inbox/spliced',
        data: {
          target: 'next-turn',
          inserted: [
            {
              content: [{ type: 'text', text: '[SCHEDULE REMINDER] reminder_prompt_json: "每日备份"' }],
              source: { kind: 'schedule' },
            },
          ],
        },
      }
    );

    const run = firstRun(bridge);
    assert.ok(run, 'the queued reminder is tracked');
    assert.match(run.text, /每日备份/);
    bridge.scheduleRuns.clear();
  });

  it('does not label a turn that was already running when the reminder arrived', async () => {
    const { bridge, sent } = harness();
    // A manual turn is in flight; the reminder is queued behind it.
    bridge.noteScheduleRun('sess-1', scheduleEvent());
    await bridge.trackScheduleEvent('sess-1', { type: 'turn/end', data: { turn: 'manual-turn', reason: { kind: 'completed' } } }, 'u1');
    await new Promise((r) => setTimeout(r, 5));

    assert.equal(sent.length, 0, 'the queued delivery must not borrow another turn');
    assert.ok(firstRun(bridge), 'the run waits for the turn it starts');
    bridge.scheduleRuns.clear();
  });

  it('reports the run once its own turn ends', async () => {
    const { bridge, sent } = harness();
    bridge.noteScheduleRun('sess-1', scheduleEvent());
    const run = firstRun(bridge);
    run.taskId = 't1';
    run.title = '每日备份';

    await bridge.trackScheduleEvent('sess-1', { type: 'turn/start', data: { turn: 'schedule-turn' } }, 'u1');
    assert.equal(run.turn, 'schedule-turn', 'the delivery binds to the turn it starts');

    await bridge.trackScheduleEvent(
      'sess-1',
      { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '备份完成，共 12 个文件' }] } } },
      'u1'
    );
    await bridge.trackScheduleEvent('sess-1', { type: 'turn/end', data: { turn: 'schedule-turn', reason: { kind: 'completed' } } }, 'u1');
    await new Promise((r) => setTimeout(r, 5));

    assert.equal(sent.length, 1);
    assert.match(sent[0].markdown, /每日备份/);
    assert.match(sent[0].markdown, /备份完成，共 12 个文件/);
    assert.equal(bridge.scheduleRuns.size, 0, 'the run is consumed once');
  });

  it('reports a task that fires in a session which is not the active one', async () => {
    const { bridge, sent } = harness();
    // The active session is sess-1; the task is bound to sess-2.
    const session = { id: 'sess-2' };

    await bridge.handleDshSessionEvent(session, scheduleEvent());
    const run = firstRun(bridge, 'sess-2');
    assert.ok(run, 'the delivery is tracked before the active-session filter');
    run.taskId = 't2';
    run.title = '夜间巡检';

    await bridge.handleDshSessionEvent(session, { type: 'turn/start', data: { turn: 't7' } });
    await bridge.handleDshSessionEvent(session, {
      type: 'assistant/message',
      data: { message: { content: [{ type: 'text', text: '巡检通过，无异常' }] } },
    });
    await bridge.handleDshSessionEvent(session, { type: 'turn/end', data: { turn: 't7', reason: { kind: 'completed' } } });
    await new Promise((r) => setTimeout(r, 5));

    assert.equal(sent.length, 1, 'a background session still notifies');
    assert.match(sent[0].markdown, /夜间巡检/);
    assert.match(sent[0].markdown, /巡检通过，无异常/);
  });

  it('drops a delivery that never got its own turn', async () => {
    const { bridge } = harness();
    bridge.noteScheduleRun('sess-1', scheduleEvent());
    const run = firstRun(bridge);
    run.at = Date.now() - 31 * 60 * 1000;

    await bridge.trackScheduleEvent('sess-1', { type: 'turn/start', data: { turn: 'later-turn' } }, 'u1');
    assert.equal(bridge.scheduleRuns.size, 0, 'a stale delivery is discarded, not rebound');
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

describe('subscription pane task section', () => {
  // The section used to disappear when there were no tasks, which is
  // indistinguishable from "the feature is missing" — it must always render and
  // explain itself.
  const CLIENT = fs.readFileSync(
    new URL('../lib/client.js', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'),
    'utf8'
  );

  it('always renders the task section', () => {
    assert.match(CLIENT, /const taskNode = React\.createElement\(/, 'rendered unconditionally');
    assert.doesNotMatch(CLIENT, /const taskNode =\s*\n\s*state\.tasks\.length > 0/, 'no early null');
    assert.match(CLIENT, /taskNode\s*\n\s*\);/, 'rendered inside the task tab pane');
  });

  it('explains all three states', () => {
    assert.match(CLIENT, /当前没有定时任务/);
    assert.match(CLIENT, /未启用官方定时任务/);
    assert.match(CLIENT, /读取定时任务失败/);
  });

  it('fetches the task list from the subscription route', () => {
    assert.match(CLIENT, /postSubscriptions\("tasks"\)/);
    assert.match(CLIENT, /postSubscriptions\("toggleTask"/);
  });
});

describe('subscription pane tabs', () => {
  // Both features share one panel, so they are separated by tabs rather than
  // stacked — a task list under a subscription list read as one tangled page.
  const CLIENT = fs.readFileSync(
    new URL('../lib/client.js', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'),
    'utf8'
  );

  it('declares two tabs', () => {
    assert.match(CLIENT, /className: "dsh-sub-tabs", role: "tablist"/);
    assert.match(CLIENT, /`会话订阅\$\{/, 'the subscription tab shows its count');
    assert.match(CLIENT, /`定时任务\$\{/, 'the task tab shows its count');
  });

  it('switches the visible pane', () => {
    assert.match(CLIENT, /state\.tab === "tasks" \? tasksView : subscriptionsView/);
    assert.match(CLIENT, /patch\(\{ tab: "tasks" \}\)/);
    assert.match(CLIENT, /patch\(\{ tab: "subscriptions" \}\)/);
  });

  it('styles the active tab', () => {
    assert.match(CLIENT, /\.dsh-sub-tab-active \{/);
    assert.match(CLIENT, /dsh-sub-tab\$\{state\.tab === "tasks" \? " dsh-sub-tab-active" : ""\}/);
  });

  it('keeps the task section out of the subscription view', () => {
    // subscriptionsView lists exactly the subscription nodes.
    const view = /const subscriptionsView = \[([\s\S]*?)\];/.exec(CLIENT);
    assert.ok(view, 'subscriptionsView exists');
    assert.doesNotMatch(view[1], /taskNode/, 'the task list is not stacked under subscriptions');
  });
});

describe('pane chrome survives the tab split', () => {
  // The tab rewrite once dropped the action row, leaving a panel with no way to
  // refresh, add or push. Pin every node of the original tree.
  const CLIENT = fs.readFileSync(
    new URL('../lib/client.js', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'),
    'utf8'
  );
  const view = /const subscriptionsView = \[([\s\S]*?)\];/.exec(CLIENT);

  it('keeps the action row in the subscription view', () => {
    assert.ok(view, 'subscriptionsView exists');
    for (const node of ['actions', 'errorNode', 'noticeNode', 'listNode', 'addNode', 'hint']) {
      assert.match(view[1], new RegExp(`\\b${node},`), `${node} must stay in the view`);
    }
  });

  it('keeps all three actions', () => {
    assert.match(CLIENT, /state\.loading \? "刷新中…" : "刷新"/);
    assert.match(CLIENT, /state\.showAdd \? "收起新增" : "新增订阅"/);
    assert.match(CLIENT, /state\.busy === "flush" \? "推送中…" : "立即推送"/);
  });

  it('gives the task tab its own refresh', () => {
    const pane = /const tasksView = React\.createElement\(([\s\S]*?)\n      \);/.exec(CLIENT);
    assert.ok(pane, 'tasksView exists');
    assert.match(pane[1], /"刷新"/, 'the task tab can be refreshed');
  });

  it('keeps the task switch compact instead of a full-width bar', () => {
    // The button used to be a direct child of the column-flex item, so it stretched
    // across the whole row. It now sits in the head row beside a stacked title.
    assert.match(CLIENT, /className: "dsh-sub-item-main"/);
    assert.match(CLIENT, /\.dsh-sub-item-head \.dsh-sub-btn \{ flex: 0 0 auto/);

    const block = /\.\.\.state\.tasks\.map\(\(task\) =>([\s\S]*?)\n\s*\)\n\s*\)\s*:/.exec(CLIENT);
    assert.ok(block, 'the task item block exists');
    const mainAt = block[1].indexOf('"dsh-sub-item-main"');
    const buttonAt = block[1].indexOf('dsh-sub-btn');
    assert.ok(mainAt > 0, 'the task row has a stacked main column');
    assert.ok(buttonAt > mainAt, 'the switch is rendered inside the head row, after the title column');
  });

  it('describes each task with status, plan time and last notice', () => {
    assert.match(CLIENT, /const formatTaskMoment = /);
    assert.match(CLIENT, /计划 \$\{planned\}/);
    assert.match(CLIENT, /上次通知 \$\{notified\}/);
    assert.match(CLIENT, /"尚未通知"/);
    assert.match(CLIENT, /\.dsh-sub-task-section \.dsh-sub-group-head \{\n      position: static;/);
  });
});