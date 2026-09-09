import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdir, rm } from 'node:fs/promises';
import { SessionManager } from '../lib/sync/session-manager.js';

describe('SessionManager', () => {
  it('should list sessions from ctx.sessionController and live sessions', async () => {
    const mockCtx = {
      sessionController: {
        list: async () => ({
          items: [
            {
              sessionId: 'sess-1',
              title: 'Project A',
              cwd: '/path/a',
              agentPreset: 'standard',
              running: false,
              updatedAt: 1000,
            },
            {
              sessionId: 'sess-2',
              title: 'Project B',
              cwd: '/path/b',
              agentPreset: 'ptc',
              running: true,
              updatedAt: 2000,
            },
          ],
        }),
      },
      sessions: {
        get: (id) => ({ id, header: { title: id } }),
      },
      permissionPresets: {
        current: (session) => 'workspace-write',
      },
    };

    const manager = new SessionManager({ ctx: mockCtx });
    const list = await manager.listSessions();

    assert.equal(list.length, 2);
    // Should be sorted by updatedAt desc
    assert.equal(list[0].sessionId, 'sess-2');
    assert.equal(list[0].running, true);
    assert.equal(list[1].sessionId, 'sess-1');
  });

  it('should track and switch active session', async () => {
    let savedId = '';
    const mockCtx = {
      sessions: {
        get: (id) => (id === 's1' || id === 's2' ? { id } : null),
      },
    };

    const manager = new SessionManager({
      ctx: mockCtx,
      getActiveSessionId: () => savedId,
      setActiveSessionId: (sid) => {
        savedId = sid;
      },
    });

    await manager.setActiveSessionId('s1');
    assert.equal(await manager.getActiveSessionId(), 's1');
    assert.equal(savedId, 's1');

    await manager.setActiveSessionId('s2');
    assert.equal(await manager.getActiveSessionId(), 's2');
    assert.equal(savedId, 's2');

    await assert.rejects(async () => {
      await manager.setActiveSessionId('non-existent');
    }, /does not exist/);
  });

  it('should dynamically list agent presets from ctx.agentPresets', async () => {
    const mockCtx = {
      agentPresets: {
        list: async () => [
          { id: 'standard', trust: 'system', name: 'Standard', description: 'Builtin standard' },
          { id: 'my-custom-preset', trust: 'user', name: 'Custom', description: 'User preset' },
        ],
      },
    };

    const manager = new SessionManager({ ctx: mockCtx });
    const presets = await manager.listPresets();

    assert.equal(presets.length, 2);
    assert.equal(presets[0].id, 'standard');
    assert.equal(presets[0].trust, 'system');
    assert.equal(presets[1].id, 'my-custom-preset');
    assert.equal(presets[1].trust, 'user');
  });

  it('should switch permission mode with friendly aliases', () => {
    let currentSet = '';
    const mockSession = { id: 's1' };
    const mockCtx = {
      sessions: {
        get: () => mockSession,
      },
      permissionPresets: {
        set: (session, mode) => {
          currentSet = mode;
        },
      },
    };

    const manager = new SessionManager({ ctx: mockCtx });
    manager.cachedActiveSessionId = 's1';

    assert.equal(manager.switchPermission('只读'), 'read-only');
    assert.equal(currentSet, 'read-only');

    assert.equal(manager.switchPermission('工作区写入'), 'workspace-write');
    assert.equal(currentSet, 'workspace-write');

    assert.equal(manager.switchPermission('全系统'), 'danger-full-access');
    assert.equal(currentSet, 'danger-full-access');

    assert.equal(manager.switchPermission('readonly'), 'read-only');
    assert.equal(currentSet, 'read-only');

    assert.equal(manager.switchPermission('danger'), 'danger-full-access');
    assert.equal(currentSet, 'danger-full-access');
  });

  it('should group sessions by workspace hierarchically', async () => {
    const mockCtx = {
      workspaceRegistry: {
        list: () => [
          { id: 'ws1', title: 'qq-bot', path: 'F:/dsh-plugin/qq-bot', sessionIds: ['s1'] },
          { id: 'ws2', title: '免费:~', path: 'C:/Users/lydxh/.dsh/remote-workspaces/rem', sessionIds: ['s2'] },
        ],
      },
      sessionController: {
        list: async () => ({
          items: [
            { sessionId: 's1', title: '开发需求单', cwd: 'F:/dsh-plugin/qq-bot', agentPreset: 'standard', running: true, updatedAt: 2000 },
            { sessionId: 's2', title: '远程运维', cwd: 'C:/Users/lydxh/.dsh/remote-workspaces/rem', agentPreset: 'standard', running: false, updatedAt: 1000 },
            { sessionId: 's3', title: '未归档会话', cwd: 'C:/temp', agentPreset: 'minimal', running: false, updatedAt: 500 },
          ],
        }),
      },
      sessions: {
        get: (id) => ({ id, header: { title: id } }),
      },
    };

    const manager = new SessionManager({ ctx: mockCtx });
    const { groups, allSessions } = await manager.listSessionsGroupedByWorkspace();

    assert.equal(allSessions.length, 3);
    assert.equal(groups.length, 3); // ws1, ws2, and ungrouped

    assert.equal(groups[0].workspace.title, 'qq-bot');
    assert.equal(groups[0].sessions.length, 1);
    assert.equal(groups[0].sessions[0].title, '开发需求单');
    assert.equal(groups[0].sessions[0].index, 1);

    assert.equal(groups[1].workspace.title, '免费:~');
    assert.equal(groups[1].workspace.isRemote, true);
    assert.equal(groups[1].sessions[0].title, '远程运维');
    assert.equal(groups[1].sessions[0].index, 2);

    assert.equal(groups[2].workspace.id, 'ungrouped');
    assert.equal(groups[2].sessions[0].title, '未归档会话');
    assert.equal(groups[2].sessions[0].index, 3);
  });

  it('should browse directories and paginate subdirectories', async () => {
    const testDir = join(tmpdir(), `dsh_test_browse_${Date.now()}`);
    await mkdir(join(testDir, 'folder_a'), { recursive: true });
    await mkdir(join(testDir, 'folder_b'), { recursive: true });
    await mkdir(join(testDir, 'folder_c'), { recursive: true });

    const manager = new SessionManager({ ctx: {} });

    try {
      const page1 = await manager.browseDirectory(testDir, 1, 2);
      assert.equal(page1.allSubdirsCount, 3);
      assert.equal(page1.totalPages, 2);
      assert.equal(page1.subdirs.length, 2);
      assert.equal(page1.subdirs[0], 'folder_a');
      assert.equal(page1.subdirs[1], 'folder_b');

      const page2 = await manager.browseDirectory(testDir, 2, 2);
      assert.equal(page2.subdirs.length, 1);
      assert.equal(page2.subdirs[0], 'folder_c');

      // Test mkdir
      await manager.createDirectory(testDir, 'new_sub');
      const updated = await manager.browseDirectory(testDir, 1, 10);
      assert.ok(updated.subdirs.includes('new_sub'));
    } finally {
      await rm(testDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('should include forked/seeded sessions while filtering true subagents', async () => {
    const mockCtx = {
      sessionController: {
        list: async () => ({
          items: [
            { sessionId: 's_main', title: '主会话', cwd: '/repo', updatedAt: 3000 },
            { sessionId: 's_fork', title: '主会话 (1)', cwd: '/repo', isSeeded: true, parentSessionId: 's_main', updatedAt: 2000 },
            { sessionId: 's_subagent', title: '子任务', cwd: '/repo', origin: 'subagent', updatedAt: 1000 },
          ],
        }),
      },
      sessions: {
        get: (id) => ({ id, header: { title: id } }),
      },
    };

    const manager = new SessionManager({ ctx: mockCtx });
    const list = await manager.listSessions();

    const ids = list.map((s) => s.sessionId);
    assert.ok(ids.includes('s_main'), 'Should include main session');
    assert.ok(ids.includes('s_fork'), 'Should include forked session');
    assert.ok(!ids.includes('s_subagent'), 'Should exclude true subagent');
  });

  it('should get multi-provider model catalog and switch reasoning effort', async () => {
    let lastSelected = null;
    const mockCtx = {
      sessionController: {
        modelCatalog: async () => ({
          default: { provider: 'cpa', model: 'gemini-3.8-flash', reasoningEffort: 'high' },
          groups: [
            {
              id: 'cpa',
              name: 'CPA',
              models: [{ id: 'gemini-3.8-flash', name: 'Gemini Flash' }, { id: 'gpt-5.6-luna', name: 'GPT Luna' }],
            },
            {
              id: 'satrss',
              name: 'Starss Api',
              models: [{ id: 'gpt-5.6-luna', name: 'GPT Luna' }, { id: 'grok-4.6', name: 'Grok' }],
            },
          ],
        }),
        selectModel: async (req) => {
          lastSelected = req;
          return { selected: { provider: req.provider, model: req.model, reasoningEffort: req.reasoningEffort } };
        },
      },
    };

    const manager = new SessionManager({ ctx: mockCtx });
    manager.cachedActiveSessionId = 'active_test';

    const cat = await manager.getModelCatalog();
    assert.equal(cat.models.length, 4);
    assert.equal(cat.models[0].provider, 'cpa');
    assert.equal(cat.models[2].provider, 'satrss');

    // Test switchReasoningEffort
    const effRes = await manager.switchReasoningEffort('low');
    assert.equal(effRes.reasoningEffort, 'low');
    assert.equal(lastSelected.reasoningEffort, 'low');
    assert.equal(lastSelected.model, 'gemini-3.8-flash');
  });

  it('should create new session via sessionController.create', async () => {
    let createdRequest = null;
    const mockCtx = {
      sessionController: {
        create: async (req) => {
          createdRequest = req;
          return { sessionId: req.sessionId, agentPreset: req.agentPreset };
        },
      },
      sessions: {
        get: (id) => ({ id }),
      },
    };

    const manager = new SessionManager({ ctx: mockCtx });
    const res = await manager.createSession({
      cwd: 'F:/my-project',
      preset: 'ptc',
      sessionId: 'test-created-session',
    });

    assert.equal(res.sessionId, 'test-created-session');
    assert.equal(createdRequest.cwd, 'F:/my-project');
    assert.equal(createdRequest.agentPreset, 'ptc');
    assert.equal(await manager.getActiveSessionId(), 'test-created-session');
  });
});
