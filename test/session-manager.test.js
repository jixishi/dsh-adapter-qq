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
              projections: {
                values: {
                  permissions: { preset: 'read-only', sandbox: 'read-only', approval: 'never' },
                },
              },
            },
          ],
        }),
      },
      sessions: {
        get: (id) => (id === 'sess-1' ? { id, header: { title: id } } : null),
      },
      permissionPresets: {
        current: () => 'workspace-write',
        derive: () => 'read-only',
      },
    };

    const manager = new SessionManager({ ctx: mockCtx });
    const list = await manager.listSessions();

    assert.equal(list.length, 2);
    // Should be sorted by updatedAt desc
    assert.equal(list[0].sessionId, 'sess-2');
    assert.equal(list[0].running, true);
    assert.equal(list[0].permission, 'read-only');
    assert.equal(list[1].sessionId, 'sess-1');
    assert.equal(list[1].permission, 'workspace-write');
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

  it('should switch permission mode with friendly aliases', async () => {
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

    const manager = new SessionManager({ ctx: mockCtx, getActiveSessionId: () => 's1' });

    assert.equal(await manager.switchPermission('只读'), 'read-only');
    assert.equal(currentSet, 'read-only');

    assert.equal(await manager.switchPermission('工作区写入'), 'workspace-write');
    assert.equal(currentSet, 'workspace-write');

    assert.equal(await manager.switchPermission('全系统'), 'danger-full-access');
    assert.equal(currentSet, 'danger-full-access');

    assert.equal(await manager.switchPermission('readonly'), 'read-only');
    assert.equal(currentSet, 'read-only');

    assert.equal(await manager.switchPermission('danger'), 'danger-full-access');
    assert.equal(currentSet, 'danger-full-access');
  });

  it('should reject switchPermission when there is no active session', async () => {
    const manager = new SessionManager({ ctx: { sessions: { get: () => null } } });
    await assert.rejects(() => manager.switchPermission('只读'), /No active session/);
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

  it('should map permissions from permissionPresets.catalog() options first', () => {
    const mockCtx = {
      permissionPresets: {
        catalog: () => ({
          options: [
            { value: 'read-only', name: '只读', description: '只读描述' },
            { value: 'workspace-write', name: '工作区写入' },
            { value: 'danger-full-access', name: '全系统', description: '全系统描述' },
          ],
          defaultOptions: ['workspace-write'],
          defaultPreset: 'workspace-write',
        }),
        // legacy source must be ignored once catalog() yields options
        names: ['read-only'],
      },
    };

    const manager = new SessionManager({ ctx: mockCtx });
    const permissions = manager.listPermissions();

    assert.equal(permissions.length, 3);
    assert.deepEqual(permissions[0], { id: 'read-only', name: '只读', description: '只读描述' });
    assert.equal(permissions[1].id, 'workspace-write');
    assert.equal(permissions[1].name, '工作区写入');
    assert.ok(permissions[1].description.length > 0, 'missing description should fall back to a built-in one');
    assert.equal(permissions[2].id, 'danger-full-access');
  });

  it('should fall back to names/resolve and then to built-in permissions', () => {
    const legacyCtx = {
      permissionPresets: {
        names: ['read-only', 'workspace-write'],
        resolve: (name) => ({ name: `${name}-name`, description: `${name}-desc` }),
      },
    };
    const legacy = new SessionManager({ ctx: legacyCtx }).listPermissions();
    assert.deepEqual(legacy.map((p) => p.id), ['read-only', 'workspace-write']);
    assert.equal(legacy[1].description, 'workspace-write-desc');

    const throwingCtx = {
      permissionPresets: {
        catalog: () => {
          throw new Error('catalog unavailable');
        },
        names: ['read-only'],
      },
    };
    assert.deepEqual(new SessionManager({ ctx: throwingCtx }).listPermissions().map((p) => p.id), ['read-only']);

    const empty = new SessionManager({ ctx: {} }).listPermissions();
    assert.deepEqual(empty.map((p) => p.id), ['read-only', 'workspace-write', 'danger-full-access']);
  });

  it('should prefer DSH sessionTitle/sessionQuery services for session titles', () => {
    const live = { id: 'sid-1' };
    const mockCtx = {
      get: (name) => {
        if (name === 'sessionTitle') {
          return { get: (session) => ({ title: session === live ? '标题服务' : '' }) };
        }
        if (name === 'sessionQuery') {
          return { readTitle: (sid) => ({ title: sid === 'sid-2' ? '查询服务标题' : '' }) };
        }
        return undefined;
      },
    };

    const manager = new SessionManager({ ctx: mockCtx });
    assert.equal(manager.resolveSessionTitle('sid-1', { title: 'item-title' }, live), '标题服务');
    assert.equal(manager.resolveSessionTitle('sid-2', { title: 'item-title' }, { id: 'other' }), '查询服务标题');
    assert.equal(manager.resolveSessionTitle('sid-3', { title: 'item-title' }, { id: 'other' }), 'item-title');

    const throwingCtx = {
      get: () => ({
        get: () => {
          throw new Error('boom');
        },
        readTitle: () => {
          throw new Error('boom');
        },
      }),
    };
    const throwing = new SessionManager({ ctx: throwingCtx });
    assert.equal(throwing.resolveSessionTitle('sid-4', { title: 'item-title' }, { id: 'sid-4' }), 'item-title');
  });

  describe('session paging', () => {
    function createPagedCtx() {
      const workspaces = [
        { id: 'ws1', title: 'ws-one', path: 'W:/proj/one', sessionIds: ['s1', 's2', 's3'] },
        { id: 'ws2', title: '远程:~', path: 'C:/Users/x/.dsh/remote-workspaces/r', sessionIds: ['s4', 's5'] },
      ];
      const items = [
        { sessionId: 's1', title: '会话一', cwd: 'W:/proj/one', agentPreset: 'standard', running: true, updatedAt: 1000 },
        { sessionId: 's2', title: '会话二', cwd: 'W:/proj/one', agentPreset: 'standard', running: false, updatedAt: 900 },
        { sessionId: 's3', title: '会话三', cwd: 'W:/proj/one', agentPreset: 'ptc', running: false, updatedAt: 800 },
        { sessionId: 's4', title: '会话四', cwd: 'C:/Users/x/.dsh/remote-workspaces/r', agentPreset: 'standard', running: false, updatedAt: 700 },
        { sessionId: 's5', title: '会话五', cwd: 'C:/Users/x/.dsh/remote-workspaces/r', agentPreset: 'standard', running: false, updatedAt: 600 },
        { sessionId: 's6', title: '松散会话', cwd: 'C:/tmp', agentPreset: 'minimal', running: false, updatedAt: 500 },
        { sessionId: 's7', title: '再一个', cwd: 'C:/tmp2', agentPreset: 'minimal', running: false, updatedAt: 400 },
      ];
      return {
        workspaceRegistry: { list: () => workspaces },
        sessionController: { list: async () => ({ items }) },
        sessions: { get: (id) => ({ id, header: { title: id } }) },
        permissionPresets: { current: () => 'workspace-write' },
      };
    }

    it('should flatten workspaces and page sessions with distinct emojis', async () => {
      const manager = new SessionManager({ ctx: createPagedCtx() });

      const page1 = await manager.getSessionPage(1, 6);
      assert.equal(page1.page, 1);
      assert.equal(page1.pageSize, 6);
      assert.equal(page1.total, 7);
      assert.equal(page1.totalPages, 2);
      assert.deepEqual(page1.items.map((s) => s.sessionId), ['s1', 's2', 's3', 's4', 's5', 's6']);
      assert.deepEqual(page1.items.map((s) => s.index), [1, 2, 3, 4, 5, 6]);

      // Emojis are unique inside one page
      const emojis = page1.items.map((s) => s.emoji);
      assert.equal(new Set(emojis).size, 6);
      assert.deepEqual(emojis, ['🍎', '🍊', '🍋', '🍇', '🍉', '🍓']);

      // Each item carries its workspace metadata
      assert.equal(page1.items[0].workspace.id, 'ws1');
      assert.equal(page1.items[3].workspace.isRemote, true);

      // groups contain only the current page, in display order
      assert.deepEqual(page1.groups.map((g) => g.workspace.id), ['ws1', 'ws2', 'ungrouped']);
      assert.deepEqual(page1.groups.map((g) => g.sessions.length), [3, 2, 1]);
      assert.equal(page1.groups.flatMap((g) => g.sessions).length, page1.items.length);

      const page2 = await manager.getSessionPage(2, 6);
      assert.equal(page2.page, 2);
      assert.equal(page2.items.length, 1);
      assert.equal(page2.items[0].sessionId, 's7');
      assert.equal(page2.items[0].emoji, '🍎');
      assert.deepEqual(page2.groups.map((g) => g.workspace.id), ['ungrouped']);
    });

    it('should clamp page numbers into the valid range', async () => {
      const manager = new SessionManager({ ctx: createPagedCtx() });

      assert.equal((await manager.getSessionPage(0, 6)).page, 1);
      assert.equal((await manager.getSessionPage(-5, 6)).page, 1);
      assert.equal((await manager.getSessionPage(99, 6)).page, 2);
      assert.equal((await manager.getSessionPage(2, 6)).page, 2);
    });

    it('should clamp an empty session list to page 1 with no items', async () => {
      const manager = new SessionManager({
        ctx: { workspaceRegistry: { list: () => [] }, sessionController: { list: async () => ({ items: [] }) } },
      });

      const page = await manager.getSessionPage(3, 6);
      assert.equal(page.total, 0);
      assert.equal(page.totalPages, 1);
      assert.equal(page.page, 1);
      assert.equal(page.pageSize, 6);
      assert.deepEqual(page.items, []);
      assert.deepEqual(page.groups, []);
    });

    it('should find a session by its 1-based sidebar index', async () => {
      const manager = new SessionManager({ ctx: createPagedCtx() });

      const found = await manager.findSessionByIndex(4);
      assert.equal(found.sessionId, 's4');
      assert.equal(found.index, 4);

      assert.equal(await manager.findSessionByIndex(99), null);
      assert.equal(await manager.findSessionByIndex('not-a-number'), null);
    });
  });
});
