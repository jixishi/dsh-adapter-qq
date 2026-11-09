import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { TurnLedger, currentBootId, DEFAULT_MAX_AGE_MS } from '../lib/sync/turn-ledger.js';
import { formatRestartNotice } from '../lib/sync/turn-notice.js';
import { MessageBridge } from '../lib/sync/message-bridge.js';

/**
 * Issue #8, second layer: a turn that was running when the host process died
 * never emits `turn/end`, so the in-memory state is lost with the process. The
 * ledger on disk is what the next boot reads to explain the gap.
 *
 * The notice itself is opt-in — nobody gets a startup message until they ask.
 */

function tempLedger(bootId = 'boot-A', now = () => 1_000) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-ledger-'));
  const filePath = join(dir, 'active-turns.json');
  const ledger = new TurnLedger({ filePath, bootId, now });
  return { dir, filePath, ledger, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe('TurnLedger persistence', () => {
  it('starts empty when the file does not exist', () => {
    const { ledger, cleanup } = tempLedger();
    try {
      assert.deepEqual(ledger.load(), { ok: true, count: 0 });
    } finally {
      cleanup();
    }
  });

  it('round-trips an entry across "processes"', () => {
    const { filePath, ledger, cleanup } = tempLedger('boot-A');
    try {
      ledger.load();
      ledger.record('s1', { userOpenid: 'u1', turn: 3, tool: 'bash' });
      assert.ok(existsSync(filePath), 'the file is written');

      const second = new TurnLedger({ filePath, bootId: 'boot-B', now: () => 2_000 });
      assert.deepEqual(second.load(), { ok: true, count: 1 });
      const [entry] = second.pendingRecoveries();
      assert.equal(entry.sessionId, 's1');
      assert.equal(entry.userOpenid, 'u1');
      assert.equal(entry.tool, 'bash');
      assert.equal(entry.turn, 3);
    } finally {
      cleanup();
    }
  });

  it('treats a corrupt file as empty instead of throwing', () => {
    const { filePath, ledger, cleanup } = tempLedger();
    try {
      writeFileSync(filePath, '{not json', 'utf8');
      const result = ledger.load();
      assert.equal(result.ok, false);
      assert.equal(result.count, 0);
      assert.equal(ledger.entries.size, 0);
    } finally {
      cleanup();
    }
  });

  it('writes atomically, leaving no temp file behind', () => {
    const { dir, ledger, cleanup } = tempLedger();
    try {
      ledger.load();
      ledger.record('s1', { userOpenid: 'u1' });
      const leftovers = readdirSync(dir).filter((f) => f.endsWith('.tmp'));
      assert.deepEqual(leftovers, []);
    } finally {
      cleanup();
    }
  });

  it('does not rewrite the file when nothing the notice mentions changed', () => {
    const { filePath, ledger, cleanup } = tempLedger();
    try {
      ledger.load();
      ledger.record('s1', { userOpenid: 'u1', turn: 1, tool: 'bash' });
      const first = readFileSync(filePath, 'utf8');
      ledger.record('s1', { userOpenid: 'u1', turn: 1, tool: 'bash' });
      assert.equal(readFileSync(filePath, 'utf8'), first, 'an identical record is a no-op');
    } finally {
      cleanup();
    }
  });
});



describe('TurnLedger recovery selection', () => {
  it('only reports turns from an earlier boot', () => {
    const { ledger, cleanup } = tempLedger('boot-A');
    try {
      ledger.load();
      ledger.record('mine', { userOpenid: 'u1' });
      assert.equal(ledger.pendingRecoveries().length, 0, 'the current boot handles its own turns');
    } finally {
      cleanup();
    }
  });

  it('drops entries older than the age window', () => {
    const { filePath, ledger, cleanup } = tempLedger('boot-A', () => 1_000);
    try {
      ledger.load();
      ledger.record('old', { userOpenid: 'u1' });
      const later = new TurnLedger({
        filePath,
        bootId: 'boot-B',
        now: () => 1_000 + DEFAULT_MAX_AGE_MS + 1,
      });
      later.load();
      assert.equal(later.pendingRecoveries().length, 0);
      assert.equal(later.entries.size, 0, 'the stale entry is pruned from the file too');
    } finally {
      cleanup();
    }
  });

  it('ignores entries with nobody to notify', () => {
    const { filePath, ledger, cleanup } = tempLedger('boot-A');
    try {
      ledger.load();
      ledger.record('anon', { userOpenid: '' });
      const later = new TurnLedger({ filePath, bootId: 'boot-B', now: () => 2_000 });
      later.load();
      assert.equal(later.pendingRecoveries().length, 0);
    } finally {
      cleanup();
    }
  });

  it('reports newest first and forgets what was consumed', () => {
    const { filePath, ledger, cleanup } = tempLedger('boot-A', () => 1_000);
    try {
      ledger.load();
      ledger.record('older', { userOpenid: 'u1' });
      ledger.now = () => 3_000;
      ledger.record('newer', { userOpenid: 'u1' });

      const later = new TurnLedger({ filePath, bootId: 'boot-B', now: () => 5_000 });
      later.load();
      const pending = later.pendingRecoveries();
      assert.deepEqual(pending.map((p) => p.sessionId), ['newer', 'older']);

      later.consume('newer');
      assert.equal(later.entries.size, 1);
      const third = new TurnLedger({ filePath, bootId: 'boot-C', now: () => 6_000 });
      third.load();
      assert.deepEqual(third.pendingRecoveries().map((p) => p.sessionId), ['older']);
    } finally {
      cleanup();
    }
  });
});

describe('TurnLedger shutdown guard', () => {
  it('keeps the entry when the process is going away', () => {
    // A process exit ends the turn as `aborted (disposed)`. Clearing then would
    // delete exactly the record the next boot needs.
    const { ledger, cleanup } = tempLedger('boot-A');
    try {
      ledger.load();
      ledger.record('s1', { userOpenid: 'u1', tool: 'bash' });
      ledger.markShuttingDown();
      ledger.clear('s1');
      assert.equal(ledger.entries.size, 1, 'the entry survives a shutdown turn end');
    } finally {
      cleanup();
    }
  });

  it('still clears normally when not shutting down', () => {
    const { ledger, cleanup } = tempLedger();
    try {
      ledger.load();
      ledger.record('s1', { userOpenid: 'u1' });
      assert.equal(ledger.clear('s1'), true);
      assert.equal(ledger.entries.size, 0);
    } finally {
      cleanup();
    }
  });

  it('is idempotent', () => {
    const { ledger, cleanup } = tempLedger();
    try {
      ledger.load();
      ledger.markShuttingDown();
      ledger.markShuttingDown();
      assert.equal(ledger.shuttingDown, true);
    } finally {
      cleanup();
    }
  });
});

describe('currentBootId', () => {
  it('encodes the pid and a timestamp so two boots never collide', () => {
    const id = currentBootId();
    assert.match(id, new RegExp(`^${process.pid}-\\d+-[a-z0-9]+$`));
    assert.notEqual(currentBootId(), currentBootId());
  });
});

describe('formatRestartNotice', () => {
  it('says the process died, not that the turn failed', () => {
    const text = formatRestartNotice({
      sessionTitle: '插件更新与功能优化任务',
      entry: { tool: 'bash', updatedAt: Date.now() - 120_000 },
      now: Date.now(),
    });
    assert.match(text, /重启/);
    assert.match(text, /中断/);
    assert.match(text, /插件更新与功能优化任务/);
    assert.match(text, /bash/);
    assert.match(text, /2 分钟前/);
    assert.match(text, /接着往下做/);
  });

  it('works without a title or a tool', () => {
    const text = formatRestartNotice({ entry: {}, now: Date.now() });
    assert.match(text, /重启/);
    assert.doesNotMatch(text, /undefined/);
  });
});

describe('MessageBridge.checkRestartRecovery', () => {
  function bridgeWith({ config = {}, entries = [] } = {}) {
    const sent = [];
    let cfg = { userOpenid: 'u1', allowFrom: ['*'], ...config };
    const consumed = [];
    const ledger = {
      pendingRecoveries: () => entries,
      consume: (id) => consumed.push(id),
    };
    const bridge = new MessageBridge({
      ctx: { get: () => undefined, on: () => () => {} },
      apiClient: {
        sendC2CMessage: async (openid, msg) => {
          sent.push({ openid, ...msg });
          return { ok: true };
        },
      },
      gateway: { on: () => {}, send: async () => {} },
      sessionManager: {
        getActiveSessionId: async () => null,
        getSessionInfoById: async (id) => ({ sessionId: id, title: '会话', cwd: 'W:/p' }),
      },
      approvalHandler: { handleUserDecision: () => true },
      inventory: null,
      getConfig: () => cfg,
      updateConfig: (patch) => {
        cfg = { ...cfg, ...patch };
      },
    });
    bridge.turnLedger = ledger;
    return { bridge, sent, consumed };
  }

  it('stays silent by default', async () => {
    const { bridge, sent, consumed } = bridgeWith({
      entries: [{ sessionId: 's1', userOpenid: 'u1', tool: 'bash', updatedAt: Date.now() }],
    });
    assert.equal(await bridge.checkRestartRecovery(), 0);
    assert.equal(sent.length, 0, 'opt-in means no startup message');
    assert.equal(consumed.length, 0, 'and nothing is dropped either');
  });

  it('reports leftover turns once the switch is on', async () => {
    const { bridge, sent, consumed } = bridgeWith({
      config: { notifyRestartRecovery: true },
      entries: [
        { sessionId: 's1', userOpenid: 'u1', tool: 'bash', updatedAt: Date.now() - 60_000 },
        { sessionId: 's2', userOpenid: 'u1', tool: null, updatedAt: Date.now() - 120_000 },
      ],
    });
    assert.equal(await bridge.checkRestartRecovery(), 2);
    assert.equal(sent.length, 2);
    assert.match(sent[0].markdown, /重启/);
    assert.equal(sent[0].keyboard, undefined, 'an automatic notice carries no action board');
    assert.deepEqual(consumed, ['s1', 's2'], 'each entry is consumed exactly once');
  });

  it('consumes an entry even when its notice cannot be delivered', async () => {
    const { bridge, consumed } = bridgeWith({
      config: { notifyRestartRecovery: true },
      entries: [{ sessionId: 's1', userOpenid: 'u1', tool: 'bash', updatedAt: Date.now() }],
    });
    bridge.apiClient.sendC2CMessage = async () => {
      throw new Error('QQ down');
    };
    assert.equal(await bridge.checkRestartRecovery(), 0);
    assert.deepEqual(consumed, ['s1'], 'no retry storm on every later boot');
  });

  it('does nothing without a ledger', async () => {
    const { bridge } = bridgeWith({ config: { notifyRestartRecovery: true } });
    bridge.turnLedger = null;
    assert.equal(await bridge.checkRestartRecovery(), 0);
  });
});

describe('MessageBridge feeds the ledger', () => {
  function bridgeWithLedger() {
    const wrote = [];
    const cleared = [];
    const bridge = new MessageBridge({
      ctx: { get: () => undefined, on: () => () => {} },
      apiClient: { sendC2CMessage: async () => ({ ok: true }), sendTyping: async () => ({}) },
      gateway: { on: () => {}, send: async () => {} },
      sessionManager: {
        getActiveSessionId: async () => 's1',
        getSessionInfoById: async (id) => ({ sessionId: id, title: 't', cwd: 'W:/p' }),
      },
      approvalHandler: { handleUserDecision: () => true },
      inventory: null,
      getConfig: () => ({ userOpenid: 'u1', allowFrom: ['*'] }),
      updateConfig: () => {},
    });
    bridge.turnLedger = {
      record: (sessionId, info) => wrote.push({ sessionId, ...info }),
      clear: (id) => cleared.push(id),
    };
    return { bridge, wrote, cleared };
  }

  it('records the turn at start and clears it at end', async () => {
    const { bridge, wrote, cleared } = bridgeWithLedger();
    bridge.onDshTurnStart('s1', { data: { turn: 2 } });
    assert.equal(wrote.length, 1);
    assert.equal(wrote[0].sessionId, 's1');
    assert.equal(wrote[0].turn, 2);
    assert.equal(wrote[0].userOpenid, 'u1');

    await bridge.handleDshSessionEvent({ id: 's1' }, { type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } });
    assert.deepEqual(cleared, ['s1']);
  });

  it('records the tool so a restart can say where it stopped', async () => {
    const { bridge, wrote } = bridgeWithLedger();
    bridge.onDshTurnStart('s1', { data: { turn: 1 } });
    await bridge.onDshToolCall('u1', { data: { name: 'bash', turn: 1 } }, 's1');
    const last = wrote.at(-1);
    assert.equal(last.tool, 'bash');
  });
});
