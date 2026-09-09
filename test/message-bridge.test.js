import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { MessageBridge } from '../lib/sync/message-bridge.js';

describe('MessageBridge', () => {
  function createTestHarness() {
    const mockCtx = new EventEmitter();
    mockCtx.sessionController = {
      prompt: async (req, signal) => {
        signal.throwIfAborted();
        mockCtx.emit('prompt_received', req);
        return { accepted: true };
      },
      list: async () => ({
        items: [
          { sessionId: 'sess-1', title: '开发需求单', cwd: 'F:/dsh-plugin/qq-bot', agentPreset: 'standard', running: false, updatedAt: 1000 },
        ],
      }),
      cancel: async () => true,
    };
    mockCtx.sessions = {
      get: (id) => ({ id, header: { title: id } }),
      list: () => [{ id: 'sess-1', header: { title: '开发需求单' } }],
    };

    const sentMessages = [];
    const ackedInteractions = [];
    const mockApiClient = {
      sendC2CMessage: async (openid, msg) => {
        sentMessages.push({ openid, msg });
        return { id: `msg_${sentMessages.length}` };
      },
      sendTyping: async () => true,
      registerDefaultGlobalMenu: async () => ({ version: 1 }),
      ackInteraction: async (id, code) => {
        ackedInteractions.push({ id, code });
        return true;
      },
    };

    const mockGateway = new EventEmitter();

    let activeSession = 'sess-1';
    const mockWorkspaces = [
      { id: 'ws-1', title: 'qq-bot', path: 'F:/dsh-plugin/qq-bot', isRemote: false, sessionIds: ['sess-1'] },
      { id: 'ws-remote', title: '免费:~', path: 'C:/Users/lydxh/.dsh/remote-workspaces/1', isRemote: true, sessionIds: [] },
    ];

    const mockSessionManager = {
      getActiveSessionId: async () => activeSession,
      setActiveSessionId: async (id) => {
        activeSession = id;
        return true;
      },
      listSessions: async () => [
        { sessionId: 'sess-1', title: '开发需求单', cwd: 'F:/dsh-plugin/qq-bot', agentPreset: 'standard', running: false, index: 1 },
      ],
      listWorkspaces: async () => mockWorkspaces,
      listSessionsGroupedByWorkspace: async () => ({
        groups: [
          {
            workspace: mockWorkspaces[0],
            sessions: [
              { sessionId: 'sess-1', title: '开发需求单', cwd: 'F:/dsh-plugin/qq-bot', agentPreset: 'standard', running: false, index: 1 },
            ],
          },
          {
            workspace: mockWorkspaces[1],
            sessions: [],
          },
        ],
        allSessions: [
          { sessionId: 'sess-1', title: '开发需求单', cwd: 'F:/dsh-plugin/qq-bot', agentPreset: 'standard', running: false, index: 1 },
        ],
      }),
      browseDirectory: async (dirPath, page = 1) => ({
        currentPath: dirPath || 'F:/dsh-plugin',
        subdirs: ['qq-bot', 'sub-folder'],
        allSubdirsCount: 2,
        page,
        totalPages: 1,
        canGoUp: true,
        parentPath: 'F:/',
      }),
      createDirectory: async (parent, name) => `${parent}/${name}`,
      getActiveSessionInfo: async () => ({
        sessionId: activeSession,
        title: '开发需求单',
        cwd: 'F:/dsh-plugin/qq-bot',
        agentPreset: 'standard',
        permission: 'workspace-write',
        running: false,
      }),
      getModelCatalog: async () => ({
        current: { provider: 'cpa', model: 'gemini-3.8-flash' },
        providers: [{ provider: 'cpa', displayName: 'CPA' }],
        models: [
          { id: 'gemini-3.8-flash', name: 'Gemini Flash', provider: 'cpa', providerName: 'CPA' },
          { id: 'gpt-5.6-luna', name: 'GPT Luna', provider: 'cpa', providerName: 'CPA' },
        ],
      }),
      switchModel: async (model) => ({ provider: 'cpa', model }),
      switchReasoningEffort: async (effort) => ({ provider: 'cpa', model: 'gemini-3.8-flash', reasoningEffort: effort }),
      getSessionStats: async () => ({
        sessionId: activeSession,
        title: '开发需求单',
        stats: {
          turns: 12,
          steps: 45,
          llmMs: 65000,
          toolMs: 12000,
          ttftMs: 25000,
          ttftSteps: 40,
          decodeMs: 40000,
          decodeTokens: 6000,
        },
        tokenUsage: {
          totals: {
            uncachedInputTokens: 50000,
            outputTokens: 6000,
            cacheReadTokens: 450000,
            cacheWriteTokens: 0,
          },
        },
        modelSelection: { provider: 'cpa', model: 'gemini-3.8-flash' },
      }),
      createSession: async ({ cwd, preset, workspaceId }) => {
        activeSession = 'sess-new';
        return { sessionId: 'sess-new', cwd, agentPreset: preset || 'standard', workspaceId };
      },
      listPresets: async () => [
        { id: 'standard', trust: 'system', name: 'Standard', description: 'Standard mode' },
        { id: 'ptc', trust: 'system', name: 'PTC', description: 'PTC mode' },
      ],
      switchPreset: async (name) => name,
      listPermissions: () => [
        { id: 'read-only', name: '只读' },
        { id: 'workspace-write', name: '工作区写入' },
      ],
      switchPermission: (mode) => (mode === '只读' ? 'read-only' : 'workspace-write'),
      cancelActiveTurn: async () => true,
    };

    const mockApprovalHandler = {
      handleUserDecision: (id, decision) => true,
    };

    let config = {
      userOpenid: 'user_target',
      allowFrom: ['*'],
      defaultCwd: '',
      defaultPreset: 'standard',
    };

    const bridge = new MessageBridge({
      ctx: mockCtx,
      apiClient: mockApiClient,
      gateway: mockGateway,
      sessionManager: mockSessionManager,
      approvalHandler: mockApprovalHandler,
      getConfig: () => config,
      updateConfig: (patch) => {
        config = { ...config, ...patch };
      },
    });

    bridge.start();

    return {
      ctx: mockCtx,
      apiClient: mockApiClient,
      gateway: mockGateway,
      bridge,
      sentMessages,
      ackedInteractions,
      getConfig: () => config,
    };
  }

  it('should auto-bind userOpenid on first message if unconfigured', async () => {
    const harness = createTestHarness();
    harness.getConfig().userOpenid = '';

    harness.gateway.emit('c2c_message', {
      id: 'msg_init',
      author: { user_openid: 'auto_bound_user' },
      content: '/help',
    });

    await new Promise((r) => setTimeout(r, 10));
    assert.equal(harness.getConfig().userOpenid, 'auto_bound_user');
    harness.bridge.stop();
  });

  it('should handle /sessions command with hierarchical workspace view', async () => {
    const harness = createTestHarness();

    harness.gateway.emit('c2c_message', {
      id: 'msg_1',
      author: { user_openid: 'user_target' },
      content: '/sessions',
    });

    await new Promise((r) => setTimeout(r, 10));

    assert.equal(harness.sentMessages.length, 1);
    const last = harness.sentMessages[0];
    assert.ok(last.msg.markdown.includes('工作区与会话列表'));
    assert.ok(last.msg.markdown.includes('📁 **qq-bot**'));
    assert.ok(last.msg.markdown.includes('开发需求单'));
    assert.ok(last.msg.markdown.includes('📁 **免费:~** *(远程工作区)*'));
    assert.ok(last.msg.keyboard);
    harness.bridge.stop();
  });

  it('should handle /new wizard: Step 1 shows workspace selection with remote support', async () => {
    const harness = createTestHarness();

    harness.gateway.emit('c2c_message', {
      id: 'msg_new',
      author: { user_openid: 'user_target' },
      content: '/new',
    });

    await new Promise((r) => setTimeout(r, 10));

    assert.equal(harness.sentMessages.length, 1);
    const last = harness.sentMessages[0];
    assert.ok(last.msg.markdown.includes('选择工作区'));
    assert.ok(last.msg.markdown.includes('qq-bot'));
    assert.ok(last.msg.markdown.includes('免费:~'));
    assert.ok(last.msg.keyboard);
    harness.bridge.stop();
  });

  it('should handle /new select-ws <workspaceId> to create session directly', async () => {
    const harness = createTestHarness();

    harness.gateway.emit('c2c_message', {
      id: 'msg_sel_ws',
      author: { user_openid: 'user_target' },
      content: '/new select-ws ws-1',
    });

    await new Promise((r) => setTimeout(r, 10));

    assert.equal(harness.sentMessages.length, 1);
    const last = harness.sentMessages[0];
    assert.ok(last.msg.markdown.includes('会话创建成功'));
    assert.ok(last.msg.markdown.includes('qq-bot'));
    harness.bridge.stop();
  });

  it('should handle /new browse to enter directory browser', async () => {
    const harness = createTestHarness();

    harness.gateway.emit('c2c_message', {
      id: 'msg_browse',
      author: { user_openid: 'user_target' },
      content: '/new browse',
    });

    await new Promise((r) => setTimeout(r, 10));

    assert.equal(harness.sentMessages.length, 1);
    const last = harness.sentMessages[0];
    assert.ok(last.msg.markdown.includes('目录浏览与选择'));
    assert.ok(last.msg.markdown.includes('qq-bot'));
    assert.ok(last.msg.keyboard);
    harness.bridge.stop();
  });

  it('should ack interaction event immediately when button is clicked (fixes mobile timeout)', async () => {
    const harness = createTestHarness();

    harness.gateway.emit('interaction', {
      id: 'interact_uuid_999',
      user_openid: 'user_target',
      data: {
        resolved: {
          button_data: '/sessions',
        },
      },
    });

    await new Promise((r) => setTimeout(r, 10));

    assert.equal(harness.ackedInteractions.length, 1);
    assert.equal(harness.ackedInteractions[0].id, 'interact_uuid_999');
    assert.equal(harness.ackedInteractions[0].code, 0);

    // And should have executed /sessions command
    assert.equal(harness.sentMessages.length, 1);
    assert.ok(harness.sentMessages[0].msg.markdown.includes('工作区与会话列表'));
    harness.bridge.stop();
  });

  it('should handle custom shortcut menu interaction (type 12) and ack immediately', async () => {
    const harness = createTestHarness();

    // Emulate type 12 callback from custom menu
    harness.gateway.emit('interaction', {
      id: 'interact_menu_12',
      type: 12,
      user_openid: 'user_target',
      data: {
        type: 12,
        resolved: {
          send_message: '/current',
        },
      },
    });

    await new Promise((r) => setTimeout(r, 10));

    assert.equal(harness.ackedInteractions.length, 1);
    assert.equal(harness.ackedInteractions[0].id, 'interact_menu_12');
    assert.equal(harness.ackedInteractions[0].code, 0);

    // And should have executed /current command
    assert.equal(harness.sentMessages.length, 1);
    assert.ok(harness.sentMessages[0].msg.markdown.includes('当前活跃会话详情'));
    harness.bridge.stop();
  });

  it('should handle /switch by index or session ID', async () => {
    const harness = createTestHarness();

    harness.gateway.emit('c2c_message', {
      id: 'msg_sw',
      author: { user_openid: 'user_target' },
      content: '/switch 1',
    });

    await new Promise((r) => setTimeout(r, 10));

    assert.equal(harness.sentMessages.length, 1);
    const last = harness.sentMessages[0];
    assert.ok(last.msg.markdown.includes('已切换活跃会话'));
    assert.ok(last.msg.markdown.includes('开发需求单'));
    harness.bridge.stop();
  });

  it('should NOT push tool execution progress by default (syncToolCalls: false)', async () => {
    const harness = createTestHarness();

    // Trigger tool call event in DSH
    harness.ctx.emit('session/event', { id: 'sess-1' }, {
      type: 'tool/call',
      data: {
        name: 'pwsh',
        arguments: JSON.stringify({ command: 'git status' }),
      },
    });

    await new Promise((r) => setTimeout(r, 10));

    // Default disabled, so no tool message sent
    assert.equal(harness.sentMessages.length, 0);
    harness.bridge.stop();
  });

  it('should aggregate tool execution progress when syncToolCalls is enabled', async () => {
    const harness = createTestHarness();
    harness.getConfig().syncToolCalls = true;
    harness.getConfig().toolCallAggregateWindowMs = 20;

    // Trigger multiple tool call events
    harness.ctx.emit('session/event', { id: 'sess-1' }, {
      type: 'tool/call',
      data: { name: 'pwsh' },
    });
    harness.ctx.emit('session/event', { id: 'sess-1' }, {
      type: 'tool/call',
      data: { name: 'pwsh' },
    });
    harness.ctx.emit('session/event', { id: 'sess-1' }, {
      type: 'tool/call',
      data: { name: 'read' },
    });

    // Wait for aggregation timer to flush
    await new Promise((r) => setTimeout(r, 35));

    assert.equal(harness.sentMessages.length, 1);
    const last = harness.sentMessages[0];
    assert.ok(last.msg.markdown.includes('Agent 执行进展'));
    assert.ok(last.msg.markdown.includes('pwsh (2次)'));
    assert.ok(last.msg.markdown.includes('read'));
    harness.bridge.stop();
  });

  it('should ignore non-human injections like MNEMON memory snapshot from Web UI sync', async () => {
    const harness = createTestHarness();

    // Emit session event from DSH with MNEMON memory injection
    harness.ctx.emit('session/event', { id: 'sess-1' }, {
      type: 'user/message',
      data: {
        message: {
          content: [{ type: 'text', text: 'MNEMON RUNTIME MEMORY SNAPSHOT\nRevision: 8bcae...\nContents of USER.md' }],
          source: { kind: 'plugin', plugin: 'mnemon' },
        },
      },
    });

    await new Promise((r) => setTimeout(r, 10));

    // Should be filtered out completely
    assert.equal(harness.sentMessages.length, 0);
    harness.bridge.stop();
  });

  it('should cleanly extract human text when MNEMON memory snapshot is prepended to prompt', async () => {
    const harness = createTestHarness();

    // User prompt from Web UI prepended with MNEMON snapshot
    const hybridContent = [
      'MNEMON RUNTIME MEMORY SNAPSHOT',
      'Revision: 8bcae181d21321b79e1cee4976a6c9759a0f03769dde64b6f821ab5d22a33921',
      'Contents of USER.md',
      '(empty)',
      '</runtime-memory-file>',
      'MNEMON VIEW TOOLS (available in this View): mnemon_document_search',
      '',
      '而且机器人显示离线状态',
    ].join('\n');

    harness.ctx.emit('session/event', { id: 'sess-1' }, {
      type: 'user/message',
      data: {
        message: {
          content: [{ type: 'text', text: hybridContent }],
          source: { kind: 'user', rpcId: 'web_user_msg_123' },
        },
      },
    });

    await new Promise((r) => setTimeout(r, 10));

    assert.equal(harness.sentMessages.length, 1);
    const last = harness.sentMessages[0];
    assert.ok(last.msg.markdown.includes('Web UI 提问同步'));
    assert.ok(last.msg.markdown.includes('而且机器人显示离线状态'));
    assert.ok(!last.msg.markdown.includes('MNEMON RUNTIME MEMORY SNAPSHOT'));
    harness.bridge.stop();
  });

  it('should handle /stats command and show execution, tokens and cache metrics', async () => {
    const harness = createTestHarness();

    harness.gateway.emit('c2c_message', {
      id: 'msg_stats',
      author: { user_openid: 'user_target' },
      content: '/stats',
    });

    await new Promise((r) => setTimeout(r, 10));

    assert.equal(harness.sentMessages.length, 1);
    const last = harness.sentMessages[0];
    assert.ok(last.msg.markdown.includes('DSH 会话统计信息'));
    assert.ok(last.msg.markdown.includes('12')); // turns
    assert.ok(last.msg.markdown.includes('45')); // steps
    assert.ok(last.msg.markdown.includes('缓存命中率'));
    assert.ok(last.msg.keyboard);
    harness.bridge.stop();
  });

  it('should handle /model command to view and switch models', async () => {
    const harness = createTestHarness();

    // 1. View models
    harness.gateway.emit('c2c_message', {
      id: 'msg_mod_view',
      author: { user_openid: 'user_target' },
      content: '/model',
    });

    await new Promise((r) => setTimeout(r, 10));

    assert.equal(harness.sentMessages.length, 1);
    assert.ok(harness.sentMessages[0].msg.markdown.includes('DSH 模型管理与切换'));
    assert.ok(harness.sentMessages[0].msg.keyboard);

    // 2. Switch model
    harness.gateway.emit('c2c_message', {
      id: 'msg_mod_sw',
      author: { user_openid: 'user_target' },
      content: '/model gpt-5.6-luna',
    });

    await new Promise((r) => setTimeout(r, 10));

    assert.equal(harness.sentMessages.length, 2);
    assert.ok(harness.sentMessages[1].msg.markdown.includes('模型切换成功'));
    assert.ok(harness.sentMessages[1].msg.markdown.includes('gpt-5.6-luna'));
    harness.bridge.stop();
  });

  it('should handle /effort command to view and switch reasoning effort', async () => {
    const harness = createTestHarness();

    // 1. View effort
    harness.gateway.emit('c2c_message', {
      id: 'msg_eff_view',
      author: { user_openid: 'user_target' },
      content: '/effort',
    });

    await new Promise((r) => setTimeout(r, 10));

    assert.equal(harness.sentMessages.length, 1);
    assert.ok(harness.sentMessages[0].msg.markdown.includes('模型思考等级管理'));
    assert.ok(harness.sentMessages[0].msg.keyboard);

    // 2. Switch effort
    harness.gateway.emit('c2c_message', {
      id: 'msg_eff_sw',
      author: { user_openid: 'user_target' },
      content: '/effort high',
    });

    await new Promise((r) => setTimeout(r, 10));

    assert.equal(harness.sentMessages.length, 2);
    assert.ok(harness.sentMessages[1].msg.markdown.includes('思考等级已切换为'));
    assert.ok(harness.sentMessages[1].msg.markdown.includes('high'));
    harness.bridge.stop();
  });

  it('should process image and file attachments from QQ and pass to DSH prompt', async () => {
    const harness = createTestHarness();

    let admittedContent = null;
    harness.ctx.sessionController.prompt = async (req) => {
      admittedContent = req.content;
      return { accepted: true };
    };

    // Mock global fetch for downloading image/file from QQ CDN
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      if (url.includes('example.com/test.png')) {
        return {
          ok: true,
          arrayBuffer: async () => Buffer.from('FAKE_PNG_BYTES'),
        };
      }
      if (url.includes('example.com/readme.txt')) {
        return {
          ok: true,
          arrayBuffer: async () => Buffer.from('Hello from QQ text file!'),
        };
      }
      return originalFetch(url);
    };

    try {
      harness.gateway.emit('c2c_message', {
        id: 'msg_media',
        author: { user_openid: 'user_target' },
        content: '请分析这张图和文件',
        attachments: [
          {
            content_type: 'image/png',
            filename: 'test.png',
            url: 'https://example.com/test.png',
          },
          {
            content_type: 'text/plain',
            filename: 'readme.txt',
            url: 'https://example.com/readme.txt',
          },
        ],
      });

      await new Promise((r) => setTimeout(r, 60));

      assert.ok(admittedContent);
      // First part is text annotation with file previews
      const textPart = admittedContent.find((p) => p.type === 'text');
      assert.ok(textPart);
      assert.ok(textPart.text.includes('请分析这张图和文件'));
      assert.ok(textPart.text.includes('test.png'));
      assert.ok(textPart.text.includes('Hello from QQ text file!'));

      // Second part is the image part
      const imgPart = admittedContent.find((p) => p.type === 'image');
      assert.ok(imgPart);
      assert.equal(imgPart.mediaType, 'image/png');
      assert.equal(imgPart.data, Buffer.from('FAKE_PNG_BYTES').toString('base64'));
    } finally {
      globalThis.fetch = originalFetch;
      harness.bridge.stop();
    }
  });

  it('should push assistant response from active session to QQ', async () => {
    const harness = createTestHarness();

    harness.ctx.emit('session/event', { id: 'sess-1' }, {
      type: 'assistant/message',
      data: {
        message: {
          content: [{ type: 'text', text: '这是 Agent 生成的代码回复\n```js\nconsole.log(1);\n```' }],
        },
      },
    });

    await new Promise((r) => setTimeout(r, 10));

    assert.equal(harness.sentMessages.length, 1);
    const last = harness.sentMessages[0];
    assert.ok(last.msg.markdown.includes('Agent 生成的代码回复'));
    harness.bridge.stop();
  });
});
