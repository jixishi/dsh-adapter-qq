import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SessionManager } from '../lib/sync/session-manager.js';
import { MessageBridge } from '../lib/sync/message-bridge.js';

/**
 * The last-user-message line the session cards show. Two sources feed it: the
 * live session event stream (every user message, a mid-turn steer included) and
 * the `turnOutline` projection (each turn's first prompt only), which is all a
 * session this process has not observed can offer.
 */
describe('Session card last user message', () => {
  const tempRoots = [];
  const makeHome = (sessions = {}) => {
    const root = mkdtempSync(join(tmpdir(), 'qq-session-card-'));
    tempRoots.push(root);
    const dir = join(root, 'storages', 'session_projcache', 'sessions');
    mkdirSync(dir, { recursive: true });
    for (const [sid, rows] of Object.entries(sessions)) {
      writeFileSync(join(dir, `${sid}.json`), JSON.stringify({ version: 1, record: { rows } }));
    }
    return root;
  };

  after(() => {
    for (const root of tempRoots) rmSync(root, { recursive: true, force: true });
  });

  describe('lastPromptOf', () => {
    const manager = new SessionManager({ ctx: {} });

    it('should take the newest prompt that has text', () => {
      assert.equal(manager.lastPromptOf({ turns: [{ prompt: '第一句' }, { prompt: '第二句' }] }), '第二句');
      // A turn still in flight has no prompt yet, so the previous one is the last.
      assert.equal(manager.lastPromptOf({ turns: [{ prompt: '第一句' }, { prompt: '' }] }), '第一句');
    });

    it('should flatten one message into one card line', () => {
      assert.equal(manager.lastPromptOf({ turns: [{ prompt: '  换行\n和   空格  ' }] }), '换行 和 空格');
      // Backticks would open a code span and swallow the rest of the card.
      assert.equal(manager.lastPromptOf({ turns: [{ prompt: '试一下 `/queue 测试`' }] }), '试一下 /queue 测试');
    });

    it('should bound a long message and tolerate an absent outline', () => {
      const long = manager.lastPromptOf({ turns: [{ prompt: 'x'.repeat(200) }] });
      assert.equal(long.length, 80);
      assert.ok(long.endsWith('…'));
      assert.equal(manager.lastPromptOf(undefined), '');
      assert.equal(manager.lastPromptOf({ turns: [] }), '');
    });
  });

  describe('resolveLastUserMessage', () => {
    it('should prefer what the live event stream saw, and mark it exact', () => {
      const manager = new SessionManager({
        ctx: {
          sessions: { get: (id) => (id === 'sess-1' ? { id } : undefined) },
          sessionProjections: { stateOf: () => ({ turns: [{ prompt: '本轮开场消息' }] }) },
        },
      });
      manager.rememberUserMessage('sess-1', [{ type: 'text', text: '插话：先别删那个文件' }]);

      // The projection would say 本轮开场消息; the stream knows better.
      assert.deepEqual(manager.resolveLastUserMessage('sess-1'), {
        text: '插话：先别删那个文件',
        exact: true,
      });
    });

    it('should fall back to the live projection and mark it inexact', () => {
      const manager = new SessionManager({
        ctx: {
          sessions: { get: (id) => (id === 'sess-1' ? { id } : undefined) },
          sessionProjections: {
            stateOf: (session, key) => (key === 'turnOutline' ? { turns: [{ prompt: '实时投影里的消息' }] } : undefined),
          },
        },
      });
      assert.deepEqual(manager.resolveLastUserMessage('sess-1'), {
        text: '实时投影里的消息',
        exact: false,
      });
    });

    it('should read a cold session from the persisted projection cache', () => {
      const home = makeHome({
        'sess-cold': { turnOutline: { val: { turns: [{ prompt: '缓存里的消息' }] } } },
      });
      const previous = process.env.DSH_HOME;
      process.env.DSH_HOME = home;
      try {
        const manager = new SessionManager({ ctx: { sessions: { get: () => undefined } } });
        assert.deepEqual(manager.resolveLastUserMessage('sess-cold'), { text: '缓存里的消息', exact: false });
        assert.equal(manager.resolveLastUserMessage('sess-missing'), null);
        assert.equal(manager.resolveLastUserMessage(''), null);
      } finally {
        if (previous === undefined) delete process.env.DSH_HOME;
        else process.env.DSH_HOME = previous;
      }
    });

    it('should refuse a session id that could escape the cache directory', () => {
      const home = makeHome({
        'sess-cold': { turnOutline: { val: { turns: [{ prompt: '缓存里的消息' }] } } },
      });
      const previous = process.env.DSH_HOME;
      process.env.DSH_HOME = home;
      try {
        const manager = new SessionManager({ ctx: { sessions: { get: () => undefined } } });
        for (const sid of ['../evil', 'a/b', 'a\\b', '..']) {
          assert.equal(manager.resolveLastUserMessage(sid), null, `${sid} must not be read`);
        }
      } finally {
        if (previous === undefined) delete process.env.DSH_HOME;
        else process.env.DSH_HOME = previous;
      }
    });
  });

  describe('rememberUserMessage', () => {
    it('should keep one card-ready line per session', () => {
      const manager = new SessionManager({ ctx: {} });
      manager.rememberUserMessage('s1', [
        { type: 'text', text: '  第一段\n带换行  ' },
        { type: 'image', data: 'ignored' },
        { type: 'text', text: '第二段' },
      ]);
      assert.deepEqual(manager.resolveLastUserMessage('s1'), { text: '第一段 带换行 第二段', exact: true });

      // A newer message replaces the previous one.
      manager.rememberUserMessage('s1', [{ type: 'text', text: '更新了' }]);
      assert.deepEqual(manager.resolveLastUserMessage('s1'), { text: '更新了', exact: true });
    });

    it('should ignore empty content and stay bounded', () => {
      const manager = new SessionManager({ ctx: {} });
      manager.rememberUserMessage('s2', [{ type: 'text', text: '   ' }]);
      manager.rememberUserMessage('s2', []);
      manager.rememberUserMessage('', [{ type: 'text', text: '无会话' }]);
      assert.equal(manager.resolveLastUserMessage('s2'), null);

      for (let i = 0; i < 260; i += 1) {
        manager.rememberUserMessage(`bulk-${i}`, [{ type: 'text', text: `第 ${i} 条` }]);
      }
      assert.equal(manager.lastUserMessages.size, 200, 'the map keeps only recent sessions');
      assert.equal(manager.resolveLastUserMessage('bulk-0'), null, 'the oldest entry is evicted');
      assert.ok(manager.resolveLastUserMessage('bulk-259'));
    });
  });

  describe('cards', () => {
    /** MessageBridge whose session manager reports one active session. */
    function createHarness({ lastMessage = null, remember } = {}) {
      const sent = [];
      const resolvedSids = [];
      const ctx = new EventEmitter();
      const info = {
        sessionId: 'sess-1',
        title: '示例会话',
        agentPreset: 'standard',
        permission: 'danger-full-access',
        running: false,
        cwd: '/tmp/ws',
      };
      const sessionManager = {
        getActiveSessionId: async () => 'sess-1',
        getActiveSessionInfo: async () => info,
        resolveLastUserMessage: (sid) => {
          resolvedSids.push(sid);
          return lastMessage;
        },
        ...remember ? { rememberUserMessage: remember } : {},
        getModelCatalog: async () => ({ current: { provider: 'p', model: 'm', reasoningEffort: 'high' } }),
        setActiveSessionId: async () => true,
        listSessionsGroupedByWorkspace: async () => ({ allSessions: [{ sessionId: 'sess-1', index: 1, title: '示例会话' }] }),
      };
      const bridge = new MessageBridge({
        ctx,
        apiClient: {
          sendC2CMessage: async (openid, msg) => {
            sent.push(msg.markdown ?? msg.content);
            return { id: 'm1' };
          },
          sendTyping: async () => true,
        },
        gateway: new EventEmitter(),
        sessionManager,
        approvalHandler: {},
        getConfig: () => ({ userOpenid: 'user_target' }),
        updateConfig: () => {},
        logger: { info: () => {}, warn: () => {}, error: () => {} },
      });
      return { bridge, sent, resolvedSids, ctx };
    }

    it('should show the exact message above the status line on the switch card', async () => {
      const harness = createHarness({ lastMessage: { text: '把那个空会话删掉', exact: true } });
      await harness.bridge.cmdSwitchSession('user_target', '1', 'msg_in');

      const card = harness.sent.at(-1);
      assert.match(card, /> \*\*最后一条用户消息\*\*: 把那个空会话删掉/);
      assert.ok(
        card.indexOf('最后一条用户消息') < card.indexOf('**状态**'),
        'the message line sits above the status line'
      );
      // The card must ask about the session it just switched to, not the old one.
      assert.deepEqual(harness.resolvedSids, ['sess-1']);
    });

    it('should label a turn-outline fallback as the turn prompt, above the status line', async () => {
      const harness = createHarness({ lastMessage: { text: '本轮的开场提问', exact: false } });
      await harness.bridge.cmdCurrentSession('user_target', 'msg_in');

      const card = harness.sent.at(-1);
      assert.match(card, /> \*\*最近一轮提问\*\*: 本轮的开场提问/);
      assert.doesNotMatch(card, /最后一条用户消息/);
      assert.ok(card.indexOf('最近一轮提问') < card.indexOf('**运行状态**'));
      assert.deepEqual(harness.resolvedSids, ['sess-1']);
    });

    it('should omit the line when nothing is known', async () => {
      const harness = createHarness({ lastMessage: null });
      await harness.bridge.cmdCurrentSession('user_target', 'msg_in');
      assert.doesNotMatch(harness.sent.at(-1), /最后一条用户消息|最近一轮提问/);
    });

    it('should remember user messages from the session event stream', async () => {
      const recorded = [];
      const harness = createHarness({ remember: (sid, content) => recorded.push({ sid, content }) });

      // A non-active session returns right after the tracking hook, which is the
      // part under test here; a steer is a user message like any other.
      await harness.bridge.handleDshSessionEvent(
        { id: 'sess-other' },
        { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '插话内容' }] } }
      );
      assert.deepEqual(recorded, [{ sid: 'sess-other', content: [{ type: 'text', text: '插话内容' }] }]);

      // Only genuine user messages count: not injected plugin input, not turn events.
      await harness.bridge.handleDshSessionEvent(
        { id: 'sess-other' },
        { type: 'user/message', data: { source: { kind: 'plugin' }, content: [{ type: 'text', text: '注入' }] } }
      );
      await harness.bridge.handleDshSessionEvent({ id: 'sess-other' }, { type: 'turn/start', data: { turn: 2 } });
      assert.equal(recorded.length, 1);
    });
  });
});
