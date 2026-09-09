import { randomUUID } from 'node:crypto';
import { resolve, join, dirname } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { KeyboardBuilder } from '../ui/keyboard.js';

/**
 * Message Bridge between QQ Gateway and DSH Sessions
 * Manages bi-directional synchronization, hierarchical workspace sessions, interactive wizard, and real-time execution feedback.
 */
export class MessageBridge {
  /**
   * @param {Object} options
   * @param {import('@deepseek-ai/cordis').Context} options.ctx - Cordis context
   * @param {import('../qq/client.js').QQApiClient} options.apiClient - QQ API client
   * @param {import('../qq/gateway.js').QQGatewayClient} options.gateway - QQ Gateway
   * @param {import('./session-manager.js').SessionManager} options.sessionManager - Session manager
   * @param {import('./approval-handler.js').ApprovalHandler} options.approvalHandler - Approval handler
   * @param {Function} options.getConfig - Getter for dynamic config
   * @param {Function} options.updateConfig - Setter to persist config updates
   * @param {Object} [options.logger]
   */
  constructor({
    ctx,
    apiClient,
    gateway,
    sessionManager,
    approvalHandler,
    getConfig,
    updateConfig,
    logger = console,
  }) {
    this.ctx = ctx;
    this.apiClient = apiClient;
    this.gateway = gateway;
    this.sessionManager = sessionManager;
    this.approvalHandler = approvalHandler;
    this.getConfig = getConfig;
    this.updateConfig = updateConfig;
    this.logger = logger;

    this.lastMsgId = null;
    this.lastMsgTime = 0;
    this.recentRpcIds = new Set();

    // Streaming buffer and execution notification throttles
    this.assistantBuffers = new Map();
    this.streamTimers = new Map();
    this.lastToolNotifyTime = 0;

    // Interactive New Session State per user: userOpenid -> { currentPath, page, lastCardMsgId }
    this.userNewSessionState = new Map();
    // Model Selection Page State per user: userOpenid -> { page, lastCardMsgId }
    this.userModelPageState = new Map();

    this.eventDisposers = [];
  }

  /**
   * Start listening to QQ Gateway and DSH Session events
   */
  start() {
    this.stop();

    // 1. QQ C2C Inbound Messages
    const onC2CMessage = (data) => this.handleInboundC2C(data);
    this.gateway.on('c2c_message', onC2CMessage);
    this.eventDisposers.push(() => this.gateway.off('c2c_message', onC2CMessage));

    // 2. QQ Button Interactions
    const onInteraction = (data) => this.handleInteraction(data);
    this.gateway.on('interaction', onInteraction);
    this.eventDisposers.push(() => this.gateway.off('interaction', onInteraction));

    // 3. DSH Session Events (ctx.on('session/event', (session, event) => ...))
    const onSessionEvent = (session, event) => this.handleDshSessionEvent(session, event);
    const sessionEventDisposer = this.ctx.on('session/event', onSessionEvent);
    this.eventDisposers.push(sessionEventDisposer);

    this.logger.info?.('[MessageBridge] Message bridge started and synchronized with DSH events.');
  }

  /**
   * Handle inbound C2C message from QQ
   * @param {Object} data - C2C_MESSAGE_CREATE event payload
   */
  async handleInboundC2C(data) {
    const authorOpenid = data.author?.user_openid || data.author?.id;
    const content = (data.content || '').trim();
    const attachments = data.attachments || [];
    const msgId = data.id;

    if (!authorOpenid) return;

    this.lastMsgId = msgId;
    this.lastMsgTime = Date.now();

    const config = this.getConfig();

    // Auto-bind userOpenid on first contact if not yet configured
    if (!config.userOpenid) {
      this.logger.info?.(`[MessageBridge] Auto-binding userOpenid to: ${authorOpenid}`);
      this.updateConfig({ userOpenid: authorOpenid });
    } else if (config.userOpenid !== authorOpenid) {
      // Whitelist check for private tool
      const allowList = config.allowFrom || ['*'];
      if (!allowList.includes('*') && !allowList.includes(authorOpenid)) {
        this.logger.warn?.(`[MessageBridge] Blocked unauthorized message from: ${authorOpenid}`);
        await this.apiClient.sendC2CMessage(authorOpenid, {
          content: '⚠️ 访问受限：本机器人为私人专属工具，您的 OpenID 未在白名单中。',
          msg_id: msgId,
        });
        return;
      }
    }

    // Process slash command only if no attachments and content starts with '/'
    if (content.startsWith('/') && attachments.length === 0) {
      await this.handleCommand(authorOpenid, content, msgId);
    } else {
      await this.handleUserPrompt(authorOpenid, content, attachments, msgId);
    }
  }

  /**
   * Handle QQ button interaction callback (INTERACTION_CREATE)
   * Acknowledges interaction immediately so mobile QQ removes spinner and triggers command
   * Supports both type 11 (inline keyboard button) and type 12 (custom shortcut menu)
   * @param {Object} data - INTERACTION_CREATE payload
   */
  async handleInteraction(data) {
    const authorOpenid = data.user_openid || data.author?.user_openid || data.author?.id;
    const interactionId = data.id;

    // 1. Crucial for Mobile QQ: immediately send PUT /interactions/{id} {code: 0}
    if (interactionId && this.apiClient?.ackInteraction) {
      void this.apiClient.ackInteraction(interactionId, 0);
    }

    // 2. Comprehensive extraction of command from various QQ platform schemas (type 11 & type 12)
    const resolved = data.data?.resolved || data.resolved || {};
    let rawCmd =
      resolved.button_data ||
      resolved.button_id ||
      resolved.command ||
      resolved.send_message ||
      resolved.content ||
      resolved.data ||
      data.data?.button_data ||
      data.data?.button_id ||
      data.data?.command ||
      data.data?.send_message ||
      data.data?.data ||
      data.content ||
      '';

    // In case rawCmd is a JSON string (like {"command": "/sessions"})
    if (typeof rawCmd === 'string' && rawCmd.startsWith('{')) {
      try {
        const parsed = JSON.parse(rawCmd);
        rawCmd = parsed.command || parsed.data || parsed.button_data || rawCmd;
      } catch {
        // keep string
      }
    }

    rawCmd = String(rawCmd || '').trim();

    // Mapping friendly menu item names to slash commands
    const nameToCommand = {
      '会话列表': '/sessions',
      '当前会话': '/current',
      '新建会话': '/new',
      '切换预设': '/preset',
      '切换权限': '/permission',
      '取消当前任务': '/cancel',
      '帮助菜单': '/help',
      '统计信息': '/stats',
      '统计': '/stats',
      'stats': '/stats',
      '切换模型': '/model',
      '模型': '/model',
      'model': '/model',
      '思考等级': '/effort',
      '思考': '/effort',
      'effort': '/effort',
      'thinking': '/effort',
      'sessions': '/sessions',
      'current': '/current',
      'new': '/new',
      'preset': '/preset',
      'permission': '/permission',
      'cancel': '/cancel',
      'help': '/help',
    };

    let commandLine = nameToCommand[rawCmd] || rawCmd;
    if (!commandLine.startsWith('/') && nameToCommand['/' + rawCmd]) {
      commandLine = nameToCommand['/' + rawCmd];
    }

    this.logger.info?.(
      `[MessageBridge] Interaction from ${authorOpenid}: raw="${rawCmd}", resolvedCmd="${commandLine}" (type=${data.type || data.data?.type}, interactionId=${interactionId})`
    );

    // 3. Dispatch command (pass null as msg_id to use active message delivery)
    if (commandLine.startsWith('/')) {
      await this.handleCommand(authorOpenid, commandLine, null);
    } else if (commandLine) {
      await this.handleUserPrompt(authorOpenid, commandLine, null);
    }
  }

  /**
   * Route and execute slash commands
   * @param {string} userOpenid - User OpenID
   * @param {string} commandLine - e.g. "/sessions", "/switch 1"
   * @param {string} [msgId] - Incoming message ID
   */
  async handleCommand(userOpenid, commandLine, msgId) {
    const parts = commandLine.trim().split(/\s+/);
    const cmd = parts[0].toLowerCase();
    const args = parts.slice(1);

    try {
      switch (cmd) {
        case '/sessions':
        case '/会话列表':
        case '/list':
          await this.cmdListSessions(userOpenid, msgId);
          break;

        case '/new':
        case '/新建会话':
        case '/create':
          await this.cmdNewSession(userOpenid, args, msgId);
          break;

        case '/switch':
        case '/切换':
          await this.cmdSwitchSession(userOpenid, args[0], msgId);
          break;

        case '/current':
        case '/当前会话':
        case '/info':
          await this.cmdCurrentSession(userOpenid, msgId);
          break;

        case '/model':
        case '/模型':
        case '/切换模型':
          await this.cmdModel(userOpenid, args.join(' '), msgId);
          break;

        case '/effort':
        case '/thinking':
        case '/思考':
        case '/思考等级':
          await this.cmdEffort(userOpenid, args.join(' '), msgId);
          break;

        case '/stats':
        case '/统计':
        case '/统计信息':
          await this.cmdStats(userOpenid, msgId);
          break;

        case '/preset':
        case '/预设':
          await this.cmdPreset(userOpenid, args[0], msgId);
          break;

        case '/permission':
        case '/权限':
          await this.cmdPermission(userOpenid, args[0], msgId);
          break;

        case '/approve':
        case '/允许':
          await this.cmdApprove(userOpenid, args[0], msgId);
          break;

        case '/reject':
        case '/拒绝':
          await this.cmdReject(userOpenid, args[0], msgId);
          break;

        case '/answer':
        case '/回答':
          await this.cmdAnswer(userOpenid, args, msgId);
          break;

        case '/cancel':
        case '/stop':
        case '/停止':
          await this.cmdCancel(userOpenid, msgId);
          break;

        case '/menu':
        case '/菜单':
          await this.cmdSyncMenu(userOpenid, msgId);
          break;

        case '/help':
        case '/帮助':
        default:
          await this.cmdHelp(userOpenid, msgId);
          break;
      }
    } catch (err) {
      this.logger.error?.(`[MessageBridge] Error handling command "${commandLine}": ${err.message}`);
      await this.apiClient.sendC2CMessage(userOpenid, {
        content: `❌ 命令执行出错: ${err.message}`,
        msg_id: msgId,
      });
    }
  }

  /**
   * Command: /sessions - Grouped hierarchically by Workspace (matching DSH Web sidebar)
   */
  async cmdListSessions(userOpenid, msgId) {
    const { groups, allSessions } = await this.sessionManager.listSessionsGroupedByWorkspace();
    const activeId = await this.sessionManager.getActiveSessionId();

    if (allSessions.length === 0) {
      await this.apiClient.sendC2CMessage(userOpenid, {
        markdown: '📋 **【DSH 工作区与会话列表】**\n\n当前暂无任何会话。点击下方按钮新建会话：',
        keyboard: KeyboardBuilder.keyboard([[
          KeyboardBuilder.button({ id: 'btn_new', label: '➕ 新建会话', data: '/new', style: 1 }),
        ]]),
        msg_id: msgId,
      });
      return;
    }

    const lines = [
      '📋 **【DSH 工作区与会话列表】**',
      '',
    ];

    const buttonCandidates = [];

    for (const group of groups) {
      const ws = group.workspace;
      const isRemote = ws.isRemote ? ' *(远程工作区)*' : '';
      lines.push(`📁 **${ws.title}**${isRemote}`);
      if (ws.path) {
        lines.push(`  └ 路径: \`${ws.path}\``);
      }

      if (group.sessions.length === 0) {
        lines.push('  *(暂无会话)*');
      } else {
        for (const s of group.sessions) {
          const isActive = s.sessionId === activeId;
          const statusIcon = s.running ? '🔄' : '💤';
          const activePrefix = isActive ? '⭐ **[当前活跃]** ' : '';
          lines.push(`  ${s.index}. ${activePrefix}**${s.title}** ${statusIcon} [\`${s.agentPreset}\` | \`${s.permission}\`]`);

          buttonCandidates.push({
            sessionId: s.sessionId,
            title: s.title,
            index: s.index,
          });
        }
      }
      lines.push('');
    }

    lines.push('💡 点击下方操作板按钮或发送 `/switch <序号>` 切换活跃会话：');

    await this.apiClient.sendC2CMessage(userOpenid, {
      markdown: lines.join('\n'),
      keyboard: KeyboardBuilder.buildSessionsBoard(buttonCandidates, activeId),
      msg_id: msgId,
    });
  }

  /**
   * Recall previous interactive wizard card to keep chat history clean
   * @param {string} userOpenid
   */
  recallPreviousWizardCard(userOpenid) {
    const state = this.userNewSessionState.get(userOpenid);
    if (state?.lastCardMsgId) {
      if (typeof this.apiClient?.recallC2CMessage === 'function') {
        void this.apiClient.recallC2CMessage(userOpenid, state.lastCardMsgId);
      }
      state.lastCardMsgId = null;
    }
  }

  /**
   * Recall previous model selection card to keep chat history clean
   * @param {string} userOpenid
   */
  recallPreviousModelCard(userOpenid) {
    const state = this.userModelPageState.get(userOpenid);
    if (state?.lastCardMsgId) {
      if (typeof this.apiClient?.recallC2CMessage === 'function') {
        void this.apiClient.recallC2CMessage(userOpenid, state.lastCardMsgId);
      }
      state.lastCardMsgId = null;
    }
  }

  /**
   * Command: /new - Interactive Workspace Selection & Directory Browser Flow
   */
  async cmdNewSession(userOpenid, args, msgId) {
    const subAction = args[0]?.toLowerCase();

    // 1. Direct command creation: /new <path> [preset]
    if (args.length >= 1 && !['select-ws', 'browse', 'enter-dir', 'up-dir', 'page', 'prompt-mkdir', 'mkdir', 'confirm-dir'].includes(subAction)) {
      this.recallPreviousWizardCard(userOpenid);
      this.userNewSessionState.delete(userOpenid);

      let cwd = args[0];
      let preset = args[1] || 'standard';
      const created = await this.sessionManager.createSession({ cwd, preset });
      await this.apiClient.sendC2CMessage(userOpenid, {
        markdown: [
          '🎉 **【新建会话成功】**',
          `> **工作目录**: \`${created.cwd}\``,
          `> **会话 ID**: \`${created.sessionId}\``,
          `> **预设**: \`${created.agentPreset}\``,
          '',
          '⭐ 已设为当前活跃会话，提问将直接转发至此会话！',
        ].join('\n'),
        keyboard: KeyboardBuilder.buildCurrentSessionBoard(),
        msg_id: msgId,
      });
      return;
    }

    // 2. Action: select-ws <workspaceId> -> Choose existing workspace directly
    if (subAction === 'select-ws' && args[1]) {
      const wsId = args[1];
      const workspaces = await this.sessionManager.listWorkspaces();
      const ws = workspaces.find((w) => w.id === wsId);
      if (!ws) {
        await this.apiClient.sendC2CMessage(userOpenid, {
          content: '❌ 所选工作区未找到或已删除。',
          msg_id: msgId,
        });
        return;
      }

      this.recallPreviousWizardCard(userOpenid);

      const created = await this.sessionManager.createSession({
        cwd: ws.path,
        workspaceId: ws.id,
        preset: 'standard',
      });

      this.userNewSessionState.delete(userOpenid);

      await this.apiClient.sendC2CMessage(userOpenid, {
        markdown: [
          '🎉 **【会话创建成功】**',
          `> **所属工作区**: 📁 **${ws.title}**${ws.isRemote ? ' (远程)' : ''}`,
          `> **工作路径**: \`${ws.path}\``,
          `> **会话 ID**: \`${created.sessionId}\``,
          `> **预设**: \`${created.agentPreset}\``,
          '',
          '⭐ 已自动切换为当前活跃会话！直接发送文字即可开启对话。',
        ].join('\n'),
        keyboard: KeyboardBuilder.buildCurrentSessionBoard(),
        msg_id: msgId,
      });
      return;
    }

    // 3. Action: browse [dirPath] -> Open Directory Browser
    if (subAction === 'browse') {
      const info = await this.sessionManager.getActiveSessionInfo();
      const config = this.getConfig();
      let initPath = args[1] || info?.cwd || config.defaultCwd || process.cwd();

      try {
        const result = await this.sessionManager.browseDirectory(initPath, 1);
        const curState = this.userNewSessionState.get(userOpenid) || {};
        this.userNewSessionState.set(userOpenid, { ...curState, currentPath: result.currentPath, page: 1 });
        await this.renderDirectoryBrowser(userOpenid, result, msgId);
      } catch (err) {
        await this.apiClient.sendC2CMessage(userOpenid, {
          content: `❌ 无法打开目录: ${err.message}`,
          msg_id: msgId,
        });
      }
      return;
    }

    // 4. Action: enter-dir <encodedDirName> -> Enter subdirectory
    if (subAction === 'enter-dir' && args[1]) {
      const state = this.userNewSessionState.get(userOpenid) || { currentPath: process.cwd(), page: 1 };
      const subName = decodeURIComponent(args[1]);
      const nextPath = join(state.currentPath, subName);

      try {
        const result = await this.sessionManager.browseDirectory(nextPath, 1);
        state.currentPath = result.currentPath;
        state.page = 1;
        this.userNewSessionState.set(userOpenid, state);
        await this.renderDirectoryBrowser(userOpenid, result, msgId);
      } catch (err) {
        await this.apiClient.sendC2CMessage(userOpenid, {
          content: `❌ 无法进入目录: ${err.message}`,
          msg_id: msgId,
        });
      }
      return;
    }

    // 5. Action: up-dir -> Go to parent directory
    if (subAction === 'up-dir') {
      const state = this.userNewSessionState.get(userOpenid) || { currentPath: process.cwd(), page: 1 };
      const parentPath = dirname(state.currentPath);

      try {
        const result = await this.sessionManager.browseDirectory(parentPath, 1);
        state.currentPath = result.currentPath;
        state.page = 1;
        this.userNewSessionState.set(userOpenid, state);
        await this.renderDirectoryBrowser(userOpenid, result, msgId);
      } catch (err) {
        await this.apiClient.sendC2CMessage(userOpenid, {
          content: `❌ 返回上级目录失败: ${err.message}`,
          msg_id: msgId,
        });
      }
      return;
    }

    // 6. Action: page <pageNum> -> Pagination
    if (subAction === 'page' && args[1]) {
      const state = this.userNewSessionState.get(userOpenid) || { currentPath: process.cwd(), page: 1 };
      const targetPage = parseInt(args[1], 10) || 1;

      try {
        const result = await this.sessionManager.browseDirectory(state.currentPath, targetPage);
        state.page = result.page;
        this.userNewSessionState.set(userOpenid, state);
        await this.renderDirectoryBrowser(userOpenid, result, msgId);
      } catch (err) {
        await this.apiClient.sendC2CMessage(userOpenid, {
          content: `❌ 分页失败: ${err.message}`,
          msg_id: msgId,
        });
      }
      return;
    }

    // 7. Action: prompt-mkdir -> Prompt user how to make dir
    if (subAction === 'prompt-mkdir') {
      const state = this.userNewSessionState.get(userOpenid) || { currentPath: process.cwd(), page: 1 };
      await this.apiClient.sendC2CMessage(userOpenid, {
        markdown: [
          '📁 **【新建目录】**',
          `当前路径: \`${state.currentPath}\``,
          '',
          '💡 请直接在聊天框中回复指令：',
          `\`/new mkdir 你的文件夹名\``,
          '',
          '创建成功后将自动进入新文件夹。',
        ].join('\n'),
        msg_id: msgId,
      });
      return;
    }

    // 8. Action: mkdir <name> -> Create and enter dir
    if (subAction === 'mkdir' && args[1]) {
      const state = this.userNewSessionState.get(userOpenid) || { currentPath: process.cwd(), page: 1 };
      const newName = args[1];

      try {
        const createdPath = await this.sessionManager.createDirectory(state.currentPath, newName);
        const result = await this.sessionManager.browseDirectory(createdPath, 1);
        state.currentPath = result.currentPath;
        state.page = 1;
        this.userNewSessionState.set(userOpenid, state);
        await this.renderDirectoryBrowser(userOpenid, result, msgId, `✅ 成功创建并进入新目录: \`${newName}\``);
      } catch (err) {
        await this.apiClient.sendC2CMessage(userOpenid, {
          content: `❌ 新建目录失败: ${err.message}`,
          msg_id: msgId,
        });
      }
      return;
    }

    // 9. Action: confirm-dir -> Confirm directory and create session
    if (subAction === 'confirm-dir') {
      const state = this.userNewSessionState.get(userOpenid);
      if (!state || !state.currentPath) {
        await this.cmdNewSession(userOpenid, [], msgId);
        return;
      }

      this.recallPreviousWizardCard(userOpenid);

      const created = await this.sessionManager.createSession({
        cwd: state.currentPath,
        preset: 'standard',
      });

      this.userNewSessionState.delete(userOpenid);

      await this.apiClient.sendC2CMessage(userOpenid, {
        markdown: [
          '🎉 **【会话创建成功】**',
          `> **选定目录**: \`${state.currentPath}\``,
          `> **会话 ID**: \`${created.sessionId}\``,
          `> **预设**: \`${created.agentPreset}\``,
          '',
          '⭐ 已成功创建并切换为当前活跃会话！',
        ].join('\n'),
        keyboard: KeyboardBuilder.buildCurrentSessionBoard(),
        msg_id: msgId,
      });
      return;
    }

    // Default Step 1: Show existing local & remote workspaces
    this.recallPreviousWizardCard(userOpenid);

    const workspaces = await this.sessionManager.listWorkspaces();
    const lines = [
      '➕ **【新建会话 · 选择工作区】** (第 1/2 步)',
      '',
      '请点击下方操作板选择已有工作区（支持本地与远程工作区）：',
    ];

    workspaces.forEach((ws, idx) => {
      const tag = ws.isRemote ? ' *(远程工作区)*' : '';
      lines.push(`${idx + 1}. 📁 **${ws.title}**${tag}`);
      lines.push(`   └ 路径: \`${ws.path}\``);
    });

    lines.push('', '💡 或点击【🔍 浏览并选择目录】自定本地磁盘路径。');

    const res = await this.apiClient.sendC2CMessage(userOpenid, {
      markdown: lines.join('\n'),
      keyboard: KeyboardBuilder.buildNewSessionWorkspacesBoard(workspaces),
      msg_id: msgId,
    });

    this.userNewSessionState.set(userOpenid, {
      currentPath: process.cwd(),
      page: 1,
      lastCardMsgId: res?.id || null,
    });
  }

  /**
   * Helper: Render Directory Browser card
   */
  async renderDirectoryBrowser(userOpenid, result, msgId, notice) {
    this.recallPreviousWizardCard(userOpenid);

    const lines = [
      '📂 **【目录浏览与选择】** (第 2/2 步)',
      `当前位置: \`${result.currentPath}\``,
      `分页: 第 ${result.page}/${result.totalPages} 页 (共 ${result.allSubdirsCount} 个子文件夹)`,
      '',
    ];

    if (notice) {
      lines.push(`> ${notice}`, '');
    }

    if (result.subdirs.length === 0) {
      lines.push('*(当前目录下没有子文件夹，您可以新建目录或直接确认)*');
    } else {
      lines.push('**子文件夹列表:**');
      result.subdirs.forEach((d) => {
        lines.push(`- 📁 **${d}**`);
      });
    }

    lines.push('', '💡 点击子文件夹进入，或点击【✅ 选定当前目录创建】：');

    const res = await this.apiClient.sendC2CMessage(userOpenid, {
      markdown: lines.join('\n'),
      keyboard: KeyboardBuilder.buildDirectoryBrowserBoard(result),
      msg_id: msgId,
    });

    const state = this.userNewSessionState.get(userOpenid) || {};
    state.lastCardMsgId = res?.id || null;
    this.userNewSessionState.set(userOpenid, state);
  }

  /**
   * Command: /switch <sessionIdOrIndex>
   */
  async cmdSwitchSession(userOpenid, sessionIdOrIndex, msgId) {
    if (!sessionIdOrIndex) {
      await this.cmdListSessions(userOpenid, msgId);
      return;
    }

    const { allSessions } = await this.sessionManager.listSessionsGroupedByWorkspace();
    let targetId = sessionIdOrIndex;

    // Check if user passed 1-based index (e.g. /switch 2)
    const num = parseInt(sessionIdOrIndex, 10);
    if (!isNaN(num) && num >= 1 && num <= allSessions.length) {
      const matchByIndex = allSessions.find((s) => s.index === num) || allSessions[num - 1];
      targetId = matchByIndex.sessionId;
    } else {
      // Fuzzy match by ID or title
      const matched = allSessions.find(
        (s) => s.sessionId.includes(sessionIdOrIndex) || s.title.toLowerCase().includes(sessionIdOrIndex.toLowerCase())
      );
      if (matched) targetId = matched.sessionId;
    }

    await this.sessionManager.setActiveSessionId(targetId);
    const info = await this.sessionManager.getActiveSessionInfo();

    const lines = [
      '✅ **【已切换活跃会话】**',
      '',
      `> **标题**: ${info?.title || targetId}`,
      `> **会话 ID**: \`${targetId}\``,
      `> **预设**: \`${info?.agentPreset || 'standard'}\``,
      `> **权限**: \`${info?.permission || '默认'}\``,
      `> **状态**: ${info?.running ? '🔄 执行中' : '💤 空闲'}`,
      `> **工作区**: \`${info?.cwd || '未指定'}\``,
      '',
      '💬 现在您可以直接发送消息与 Agent 对话。',
    ];

    await this.apiClient.sendC2CMessage(userOpenid, {
      markdown: lines.join('\n'),
      keyboard: KeyboardBuilder.buildCurrentSessionBoard(),
      msg_id: msgId,
    });
  }

  /**
   * Command: /current
   */
  async cmdCurrentSession(userOpenid, msgId) {
    const info = await this.sessionManager.getActiveSessionInfo();
    if (!info) {
      await this.apiClient.sendC2CMessage(userOpenid, {
        markdown: '📌 **当前暂无活跃会话**\n\n请先新建会话或从会话列表中选择：',
        keyboard: KeyboardBuilder.keyboard([[
          KeyboardBuilder.button({ id: 'btn_new', label: '➕ 新建会话', data: '/new', style: 1 }),
          KeyboardBuilder.button({ id: 'btn_list', label: '📋 会话列表', data: '/sessions' }),
        ]]),
        msg_id: msgId,
      });
      return;
    }

    const modelCat = await this.sessionManager.getModelCatalog();
    const curModel = modelCat.current?.model || '默认';
    const curProvider = modelCat.current?.provider || 'default';
    const curEffort = modelCat.current?.reasoningEffort || '默认';

    const lines = [
      '📌 **【当前活跃会话详情】**',
      '',
      `> **标题**: ${info.title}`,
      `> **会话 ID**: \`${info.sessionId}\``,
      `> **AI 模型**: **${curModel}** (${curProvider})`,
      `> **思考等级**: **${curEffort}**`,
      `> **Agent 预设**: \`${info.agentPreset}\``,
      `> **权限模式**: \`${info.permission}\``,
      `> **运行状态**: ${info.running ? '🔄 执行中' : '💤 空闲'}`,
      `> **工作目录**: \`${info.cwd || '当前工作区'}\``,
    ];

    await this.apiClient.sendC2CMessage(userOpenid, {
      markdown: lines.join('\n'),
      keyboard: KeyboardBuilder.buildCurrentSessionBoard(),
      msg_id: msgId,
    });
  }

  /**
   * Command: /model [nameOrIndex] - View and switch LLM models
   */
  async cmdModel(userOpenid, modelNameOrIndex, msgId) {
    const { current, models } = await this.sessionManager.getModelCatalog();
    const parts = (modelNameOrIndex || '').trim().split(/\s+/);
    const subAction = parts[0]?.toLowerCase();

    // 1. Pagination: /model page <num>
    if (subAction === 'page') {
      const pageNum = parseInt(parts[1], 10) || 1;
      await this.renderModelsPage(userOpenid, models, current, pageNum, msgId);
      return;
    }

    // 2. Direct model switch: /model <nameOrIndex> [provider] [effort]
    if (subAction) {
      try {
        const selected = await this.sessionManager.switchModel(modelNameOrIndex);
        const effortText = selected.reasoningEffort ? ` [思考: \`${selected.reasoningEffort}\`]` : '';
        this.recallPreviousModelCard(userOpenid);
        await this.apiClient.sendC2CMessage(userOpenid, {
          markdown: `🤖 模型切换成功！当前使用: **\`${selected.model}\`** (\`${selected.provider}\`)${effortText}`,
          keyboard: KeyboardBuilder.buildCurrentSessionBoard(),
          msg_id: msgId,
        });
      } catch (err) {
        await this.apiClient.sendC2CMessage(userOpenid, {
          markdown: `⚠️ 模型切换失败: ${err.message}`,
          keyboard: KeyboardBuilder.buildModelsBoard(models, current?.model, current?.provider),
          msg_id: msgId,
        });
      }
      return;
    }

    // Default: render page 1
    await this.renderModelsPage(userOpenid, models, current, 1, msgId);
  }

  /**
   * Helper: Render paginated models list card
   */
  async renderModelsPage(userOpenid, models, current, page = 1, msgId) {
    this.recallPreviousModelCard(userOpenid);

    const pageSize = 6;
    const totalPages = Math.max(1, Math.ceil(models.length / pageSize));
    const safePage = Math.min(Math.max(1, page), totalPages);
    const currentModelId = current?.model || '未知';
    const currentProvider = current?.provider || '';
    const currentEffort = current?.reasoningEffort || '默认';

    const lines = [
      '🤖 **【DSH 模型管理与切换】**',
      '',
      `当前会话模型: **${currentModelId}** (${currentProvider})`,
      `当前思考等级: **${currentEffort}**`,
      `分页: 第 ${safePage}/${totalPages} 页 (共 ${models.length} 个可用模型)`,
      '',
      '**可用模型列表:**',
    ];

    const offset = (safePage - 1) * pageSize;
    const pageModels = models.slice(offset, offset + pageSize);
    pageModels.forEach((m, idx) => {
      const globalIdx = offset + idx + 1;
      const isCur = m.id === currentModelId && (!currentProvider || m.provider === currentProvider) ? '✅ ' : '';
      lines.push(`${globalIdx}. ${isCur}**${m.id}** [${m.providerName || m.provider}]`);
    });

    lines.push('', '💡 点击下方按钮切换模型，或回复 `/model <序号或名称>`：');

    const res = await this.apiClient.sendC2CMessage(userOpenid, {
      markdown: lines.join('\n'),
      keyboard: KeyboardBuilder.buildModelsBoard(models, currentModelId, currentProvider, safePage, pageSize),
      msg_id: msgId,
    });

    this.userModelPageState.set(userOpenid, {
      page: safePage,
      lastCardMsgId: res?.id || null,
    });
  }

  /**
   * Command: /effort [level] - View and switch reasoning effort
   */
  async cmdEffort(userOpenid, effortInput, msgId) {
    const { current } = await this.sessionManager.getModelCatalog();

    if (effortInput) {
      try {
        const selected = await this.sessionManager.switchReasoningEffort(effortInput);
        await this.apiClient.sendC2CMessage(userOpenid, {
          markdown: `🧠 思考等级已切换为: **\`${selected.reasoningEffort}\`** (模型: \`${selected.model}\`)`,
          keyboard: KeyboardBuilder.buildCurrentSessionBoard(),
          msg_id: msgId,
        });
      } catch (err) {
        await this.apiClient.sendC2CMessage(userOpenid, {
          markdown: `⚠️ 思考等级设置失败: ${err.message}`,
          keyboard: KeyboardBuilder.buildReasoningEffortBoard(current?.reasoningEffort),
          msg_id: msgId,
        });
      }
      return;
    }

    const currentModelId = current?.model || '未知';
    const currentEffort = current?.reasoningEffort || '默认';

    const lines = [
      '🧠 **【模型思考等级管理 (Reasoning Effort)】**',
      '',
      `当前模型: **${currentModelId}** (${current?.provider || 'default'})`,
      `当前思考等级: **${currentEffort}**`,
      '',
      '**支持的思考等级说明:**',
      '- **🔴 关闭 (`off`)**: 禁用深度思考，直接生成普通回复（响应最快）',
      '- **🟢 低 (`low`)**: 轻量思考，耗费少量思考 Token',
      '- **🟡 中 (`medium`)**: 标准思考，均衡思考质量与响应时间',
      '- **🔵 高 (`high`)**: 深度思考，适合复杂逻辑与代码编写',
      '- **🟣 超高 (`xhigh`)**: 极深思考，推理更充分',
      '- **⚡ 最大 (`max`)**: 极限思考预算，解决极高难度挑战',
      '',
      '💡 请点击下方操作板按钮选择，或回复 `/effort <等级>`：',
    ];

    await this.apiClient.sendC2CMessage(userOpenid, {
      markdown: lines.join('\n'),
      keyboard: KeyboardBuilder.buildReasoningEffortBoard(currentEffort),
      msg_id: msgId,
    });
  }

  /**
   * Command: /stats - Show session execution stats matching Web UI stats line
   */
  async cmdStats(userOpenid, msgId) {
    const data = await this.sessionManager.getSessionStats();
    if (!data) {
      await this.apiClient.sendC2CMessage(userOpenid, {
        content: '📌 当前没有活跃会话，无法查看统计。',
        msg_id: msgId,
      });
      return;
    }

    const { stats, tokenUsage, modelSelection } = data;
    const formatDuration = (ms) => {
      if (!ms || ms <= 0) return '0s';
      const sec = Math.floor(ms / 1000);
      const min = Math.floor(sec / 60);
      const hour = Math.floor(min / 60);
      if (hour > 0) return `${hour}h ${min % 60}m ${sec % 60}s`;
      if (min > 0) return `${min}m ${sec % 60}s`;
      return `${(ms / 1000).toFixed(1)}s`;
    };

    const formatTokens = (num) => {
      if (!num || num <= 0) return '0';
      if (num >= 1000000) return `${(num / 1000000).toFixed(1)}M`;
      if (num >= 1000) return `${(num / 1000).toFixed(1)}k`;
      return String(num);
    };

    const totalInput = (tokenUsage.totals?.uncachedInputTokens || 0) + (tokenUsage.totals?.cacheReadTokens || 0);
    const cacheRead = tokenUsage.totals?.cacheReadTokens || 0;
    const cacheHitRate = totalInput > 0 ? ((cacheRead / totalInput) * 100).toFixed(1) + '%' : '0.0%';

    const ttftAvg = stats.ttftSteps > 0 ? (stats.ttftMs / stats.ttftSteps / 1000).toFixed(2) + 's' : '0s';
    const decodeSpeed = stats.decodeMs > 0 ? ((stats.decodeTokens / (stats.decodeMs / 1000))).toFixed(1) + ' t/s' : '0 t/s';

    const sections = [];
    sections.push([
      '📊 **【DSH 会话统计信息】**',
      `> **会话**: **${data.title}**`,
      ...(modelSelection?.model ? [`> **模型**: \`${modelSelection.model}\` (${modelSelection.provider || 'default'})`] : []),
    ].join('\n'));

    sections.push([
      '🎯 **轮次与步数:**',
      `• 交互轮次: **${stats.turns}** 轮`,
      `• 执行步骤: **${stats.steps}** 步`,
    ].join('\n'));

    sections.push([
      '⏱️ **耗时与性能:**',
      `• LLM 耗时: **${formatDuration(stats.llmMs)}**`,
      `• 工具耗时: **${formatDuration(stats.toolMs)}**`,
      `• 首字延迟 (TTFT 均值): **${ttftAvg}**`,
      `• 生成速度: **${decodeSpeed}**`,
    ].join('\n'));

    sections.push([
      '🪙 **Token 用量与缓存 (对齐 WebUI):**',
      `• 缓存命中率: **${cacheHitRate}**`,
      `• 总输入 Tokens: **${formatTokens(totalInput)}** (缓存读取: ${formatTokens(cacheRead)})`,
      `• 总输出 Tokens: **${formatTokens(tokenUsage.totals?.outputTokens || stats.decodeTokens)}**`,
    ].join('\n'));

    await this.apiClient.sendC2CMessage(userOpenid, {
      markdown: sections.join('\n\n'),
      keyboard: KeyboardBuilder.buildStatsBoard(),
      msg_id: msgId,
    });
  }

  /**
   * Command: /preset [name]
   */
  async cmdPreset(userOpenid, presetName, msgId) {
    const presets = await this.sessionManager.listPresets();
    const info = await this.sessionManager.getActiveSessionInfo();

    if (presetName) {
      try {
        const switched = await this.sessionManager.switchPreset(presetName);
        await this.apiClient.sendC2CMessage(userOpenid, {
          markdown: `✅ 会话预设已成功切换为 **\`${switched}\`** 模式！`,
          keyboard: KeyboardBuilder.buildCurrentSessionBoard(),
          msg_id: msgId,
        });
      } catch (err) {
        await this.apiClient.sendC2CMessage(userOpenid, {
          markdown: `⚠️ 预设切换失败: ${err.message}\n\n*(注意: DSH 会话开始交互后预设将固定，新预设请新建会话使用)*`,
          keyboard: KeyboardBuilder.buildPresetsBoard(presets, info?.agentPreset),
          msg_id: msgId,
        });
      }
      return;
    }

    // List presets
    const lines = [
      '⚙️ **【Agent 预设选择】** (动态发现)',
      '',
      `当前会话预设: \`${info?.agentPreset || 'standard'}\``,
      '',
      '**可用预设列表:**',
    ];

    presets.forEach((p) => {
      const tag = p.trust === 'system' ? '内置' : '自定义';
      const isCur = p.id === info?.agentPreset ? '✅ ' : '';
      lines.push(`- ${isCur}**\`${p.id}\`** [${tag}]: ${p.description}`);
    });

    lines.push('', '💡 请点击下方按钮选择切换预设：');

    await this.apiClient.sendC2CMessage(userOpenid, {
      markdown: lines.join('\n'),
      keyboard: KeyboardBuilder.buildPresetsBoard(presets, info?.agentPreset),
      msg_id: msgId,
    });
  }

  /**
   * Command: /permission [mode]
   */
  async cmdPermission(userOpenid, modeName, msgId) {
    const permissions = this.sessionManager.listPermissions();
    const info = await this.sessionManager.getActiveSessionInfo();

    if (modeName) {
      try {
        const target = this.sessionManager.switchPermission(modeName);
        await this.apiClient.sendC2CMessage(userOpenid, {
          markdown: `🛡️ 权限已切换为: **\`${target}\`** 模式！`,
          keyboard: KeyboardBuilder.buildCurrentSessionBoard(),
          msg_id: msgId,
        });
      } catch (err) {
        await this.apiClient.sendC2CMessage(userOpenid, {
          markdown: `⚠️ 权限切换失败: ${err.message}`,
          keyboard: KeyboardBuilder.buildPermissionsBoard(permissions, info?.permission),
          msg_id: msgId,
        });
      }
      return;
    }

    const lines = [
      '🛡️ **【DSH 权限模式管理】**',
      '',
      `当前权限: \`${info?.permission || 'workspace-write'}\``,
      '',
      '**支持的权限模式:**',
      '- **只读模式 (`read-only`)**: 仅可检索、读取文件，无法修改文件或运行破坏性命令',
      '- **工作区写入 (`workspace-write`)**: 可读写工作区文件及安全命令，越权触发人工审批',
      '- **全系统模式 (`danger-full-access`)**: 完整系统权限，跳过所有交互式审批',
      '',
      '💡 请点击下方操作板切换权限：',
    ];

    await this.apiClient.sendC2CMessage(userOpenid, {
      markdown: lines.join('\n'),
      keyboard: KeyboardBuilder.buildPermissionsBoard(permissions, info?.permission),
      msg_id: msgId,
    });
  }

  /**
   * Command: /approve [id]
   */
  async cmdApprove(userOpenid, approvalId, msgId) {
    const ok = this.approvalHandler.handleUserDecision(approvalId, 'allowed-once');
    if (ok) {
      await this.apiClient.sendC2CMessage(userOpenid, {
        content: '✅ 审批已批准！已允许 Agent 继续执行本次操作。',
        msg_id: msgId,
      });
    } else {
      await this.apiClient.sendC2CMessage(userOpenid, {
        content: '⚠️ 未找到对应的待审批项（可能已被处理或已过期）。',
        msg_id: msgId,
      });
    }
  }

  /**
   * Command: /reject [id]
   */
  async cmdReject(userOpenid, approvalId, msgId) {
    const ok = this.approvalHandler.handleUserDecision(approvalId, 'rejected');
    if (ok) {
      await this.apiClient.sendC2CMessage(userOpenid, {
        content: '❌ 审批已拒绝！已阻断 Agent 执行该操作。',
        msg_id: msgId,
      });
    } else {
      await this.apiClient.sendC2CMessage(userOpenid, {
        content: '⚠️ 未找到对应的待审批项（可能已被处理或已过期）。',
        msg_id: msgId,
      });
    }
  }

  /**
   * Command: /answer <questionId> <encodedLabel>
   */
  async cmdAnswer(userOpenid, args, msgId) {
    const questionId = args[0];
    const rawLabel = args.slice(1).join(' ');
    let optionLabel = rawLabel;
    try {
      optionLabel = decodeURIComponent(rawLabel);
    } catch {
      // keep raw
    }

    const ok = this.approvalHandler.handleQuestionAnswer(questionId, optionLabel);
    if (ok) {
      await this.apiClient.sendC2CMessage(userOpenid, {
        content: `✅ 已选择: "${optionLabel}"，已提交给 Agent 继续执行！`,
        msg_id: msgId,
      });
    } else {
      await this.apiClient.sendC2CMessage(userOpenid, {
        content: '⚠️ 未找到对应的待回答问题（可能已被处理或已超时）。',
        msg_id: msgId,
      });
    }
  }

  /**
   * Command: /cancel
   */
  async cmdCancel(userOpenid, msgId) {
    const ok = await this.sessionManager.cancelActiveTurn();
    await this.apiClient.sendC2CMessage(userOpenid, {
      content: ok ? '🛑 已向 Agent 发送取消指令，正在停止当前轮次。' : 'ℹ️ 当前会话没有正在运行的轮次。',
      msg_id: msgId,
    });
  }

  /**
   * Command: /menu (Sync global menu to QQ Open Platform)
   */
  async cmdSyncMenu(userOpenid, msgId) {
    try {
      const res = await this.apiClient.registerDefaultGlobalMenu();
      await this.apiClient.sendC2CMessage(userOpenid, {
        content: `✅ QQ 机器人全局快捷菜单注册成功 (版本号: ${res?.version || 1})！在 QQ 单聊界面底部已生效。`,
        msg_id: msgId,
      });
    } catch (err) {
      await this.apiClient.sendC2CMessage(userOpenid, {
        content: `❌ 菜单注册失败: ${err.message}`,
        msg_id: msgId,
      });
    }
  }

  /**
   * Command: /help
   */
  async cmdHelp(userOpenid, msgId) {
    const lines = [
      '🤖 **【DeepSeek Harness QQ 机器人使用指南】**',
      '',
      '**常用快捷指令:**',
      '- `/sessions` 或 `/会话列表`: 按工作区层级查看所有会话',
      '- `/new`: 进入交互式新建会话向导（选择本地/远程工作区或浏览目录）',
      '- `/switch <序号或ID>`: 切换当前活跃会话',
      '- `/current` 或 `/当前会话`: 查看当前活跃会话详情',
      '- `/model [名称]`: 查看或切换 AI 模型（支持指定供应商或序号）',
      '- `/effort [等级]` 或 `/思考`: 查看或切换思考等级 (off, low, medium, high, xhigh, max)',
      '- `/stats` 或 `/统计`: 查看会话性能、耗时与 Token 统计（对齐 WebUI 底栏）',
      '- `/preset [名称]`: 查看或切换 Agent 预设',
      '- `/permission [只读|工作区|全系统]`: 切换权限模式',
      '- `/cancel` 或 `/stop`: 中止当前 Agent 执行',
      '- `/menu`: 重新注册底部快捷菜单',
      '',
      '💬 **直接输入文字即可与 DSH Agent 进行多轮对话**，所有对话及执行操作与 Web UI 实时双向同步！',
    ];

    await this.apiClient.sendC2CMessage(userOpenid, {
      markdown: lines.join('\n'),
      keyboard: KeyboardBuilder.buildHelpBoard(),
      msg_id: msgId,
    });
  }

  /**
   * Handle ordinary user prompt from QQ (forward to DSH session, including images & files)
   * @param {string} userOpenid - User OpenID
   * @param {string} content - Prompt text
   * @param {Array<Object>} [attachments=[]] - Uploaded attachments from QQ
   * @param {string} [msgId] - Incoming message ID
   */
  async handleUserPrompt(userOpenid, content, attachments = [], msgId) {
    let activeId = await this.sessionManager.getActiveSessionId();
    if (!activeId) {
      // Auto-create initial session if none exists
      const created = await this.sessionManager.createSession();
      activeId = created.sessionId;
    }

    // Send typing indicator
    if (msgId) {
      void this.apiClient.sendTyping(userOpenid, msgId);
    }

    const rpcId = randomUUID();
    this.recentRpcIds.add(rpcId);
    if (this.recentRpcIds.size > 200) {
      const oldest = this.recentRpcIds.values().next().value;
      this.recentRpcIds.delete(oldest);
    }

    const activeInfo = await this.sessionManager.getActiveSessionInfo();
    const sessionCwd = activeInfo?.cwd || process.cwd();

    const promptContent = [];
    const textAnnotations = [];

    if (content) {
      textAnnotations.push(content);
    }

    // Process attachments (images & files) sent from QQ
    if (Array.isArray(attachments) && attachments.length > 0) {
      const uploadDir = join(sessionCwd, 'uploads');
      let uploadDirReady = false;

      for (let i = 0; i < attachments.length; i++) {
        const att = attachments[i];
        let fileUrl = att.url || '';
        if (fileUrl.startsWith('//')) {
          fileUrl = 'https:' + fileUrl;
        }

        const contentType = att.content_type || '';
        const filename = att.filename || `file_${Date.now()}_${i}`;
        const isImage = contentType.startsWith('image/') || /\.(png|jpe?g|gif|webp|bmp)$/i.test(filename);

        let buffer = null;
        if (fileUrl) {
          try {
            const res = await fetch(fileUrl);
            if (res.ok) {
              const arrayBuf = await res.arrayBuffer();
              buffer = Buffer.from(arrayBuf);
            }
          } catch (err) {
            this.logger.warn?.(`[MessageBridge] Failed to fetch attachment from ${fileUrl}: ${err.message}`);
          }
        }

        // Save local copy to workspace uploads/
        let savedPath = '';
        if (buffer) {
          try {
            if (!uploadDirReady) {
              await mkdir(uploadDir, { recursive: true });
              uploadDirReady = true;
            }
            savedPath = join(uploadDir, filename);
            await writeFile(savedPath, buffer);
            this.logger.info?.(`[MessageBridge] Saved inbound QQ attachment to: ${savedPath}`);
          } catch (err) {
            this.logger.warn?.(`[MessageBridge] Failed to write attachment file ${savedPath}: ${err.message}`);
          }
        }

        if (isImage) {
          if (buffer) {
            promptContent.push({
              type: 'image',
              data: buffer.toString('base64'),
              mediaType: contentType || 'image/png',
              name: filename,
            });
            textAnnotations.push(`[用户从 QQ 发送了图片: ${filename} (已保存至 uploads/${filename})]`);
          } else if (fileUrl) {
            textAnnotations.push(`[用户从 QQ 发送了图片: ${filename}](${fileUrl})`);
          }
        } else {
          // Non-image file (code, text, pdf, zip, etc.)
          if (buffer) {
            const sizeKb = (buffer.length / 1024).toFixed(1);
            const isText = /\.(txt|md|json|js|ts|py|c|cpp|h|java|go|rs|html|css|yaml|yml|sh|ps1)$/i.test(filename) || contentType.startsWith('text/');
            if (isText && buffer.length < 48000) {
              const textContent = buffer.toString('utf8');
              textAnnotations.push(`[用户从 QQ 发送了文件: ${filename} (${sizeKb} KB, 已保存至 uploads/${filename})]\n\`\`\`\n${textContent}\n\`\`\``);
            } else {
              textAnnotations.push(`📎 [用户从 QQ 发送了文件: ${filename} (${sizeKb} KB, 已保存至工作区 \`uploads/${filename}\`)]`);
            }
          } else if (fileUrl) {
            textAnnotations.push(`📎 [用户从 QQ 发送了文件: ${filename}](${fileUrl})`);
          }
        }
      }
    }

    const fullText = textAnnotations.join('\n\n').trim();
    if (fullText) {
      promptContent.unshift({ type: 'text', text: fullText });
    }

    if (promptContent.length === 0) {
      promptContent.push({ type: 'text', text: content || '你好' });
    }

    const agents = this.ctx.get ? this.ctx.get('agents') : this.ctx.agents;
    const sessionController = this.ctx.get ? this.ctx.get('sessionController') : this.ctx.sessionController;
    const liveAgent = agents?.get(activeId);
    const mode = liveAgent?.status === 'running' ? 'steer' : 'followup';

    this.logger.info?.(`[MessageBridge] Admitting prompt with ${promptContent.length} parts to session "${activeId}" (mode: ${mode})`);

    try {
      if (sessionController?.prompt) {
        const controller = new AbortController();
        await sessionController.prompt({
          sessionId: activeId,
          content: promptContent,
          requestId: rpcId,
          mode,
        }, controller.signal);
      } else if (liveAgent?.followup) {
        liveAgent.followup({
          content: promptContent,
          source: { kind: 'plugin', plugin: 'dsh-adapter-qq', rpcId },
        });
      } else {
        throw new Error('DSH sessionController prompt API is not available.');
      }
    } catch (err) {
      this.logger.error?.(`[MessageBridge] Failed to deliver prompt to DSH: ${err.message}`);
      await this.apiClient.sendC2CMessage(userOpenid, {
        content: `⚠️ 发送至会话失败: ${err.message}`,
        msg_id: msgId,
      });
    }
  }

  /**
   * Handle DSH internal session events
   * @param {Object} session - DSH Session object
   * @param {Object} event - DSH SessionEvent
   */
  async handleDshSessionEvent(session, event) {
    const activeId = await this.sessionManager.getActiveSessionId();
    // Only synchronize events for the currently active session
    if (session.id !== activeId) {
      return;
    }

    const config = this.getConfig();
    const userOpenid = config.userOpenid;
    if (!userOpenid) return;

    switch (event.type) {
      case 'user/message':
        await this.onDshUserMessage(userOpenid, event);
        break;

      case 'assistant/chunk':
        this.onDshAssistantChunk(userOpenid, session.id, event);
        break;

      case 'assistant/message':
        await this.onDshAssistantMessage(userOpenid, session.id, event);
        break;

      case 'tool/call':
        await this.onDshToolCall(userOpenid, event);
        break;

      case 'turn/end':
        this.onDshTurnEnd(session.id);
        break;

      default:
        break;
    }
  }

  /**
   * Web UI -> QQ Sync: User sent a message from Web UI on the active session
   */
  async onDshUserMessage(userOpenid, event) {
    const config = this.getConfig();
    // Default disabled: only sync when explicitly enabled in settings to avoid spamming user on mobile
    if (!config.syncWebQuestions) {
      return;
    }

    const message = event.data?.message || event.data;
    const rpcId = message?.source?.rpcId;

    // If originated from QQ, do not echo back
    if (rpcId && this.recentRpcIds.has(rpcId)) {
      return;
    }

    // Only synchronize messages explicitly authored by human user
    const sourceKind = message?.source?.kind;
    if (sourceKind && sourceKind !== 'user') {
      return;
    }

    // Extract text
    const textParts = (message?.content || [])
      .filter((c) => c.type === 'text')
      .map((c) => c.text);
    const rawText = textParts.join('\n').trim();

    if (!rawText) return;

    // Clean out internal system injections, mnemon snapshots, runtime memory, prompt context, etc.
    const humanText = this.cleanUserPromptText(rawText);
    if (!humanText) {
      return;
    }

    this.logger.info?.(`[MessageBridge] Synchronizing Web UI question to QQ: "${humanText.slice(0, 30)}..."`);
    try {
      await this.apiClient.sendC2CMessage(userOpenid, {
        markdown: `💬 **[Web UI 提问同步]**\n> ${humanText.replace(/\n/g, '\n> ')}`,
      });
    } catch (err) {
      this.logger.warn?.(`[MessageBridge] Failed to sync Web UI message to QQ: ${err.message}`);
    }
  }

  /**
   * Helper to clean system memory/prompt injections and extract authentic human text
   */
  cleanUserPromptText(text) {
    if (!text || typeof text !== 'string') return '';
    let cleaned = text;

    // 1. Strip full MNEMON memory snapshot blocks
    cleaned = cleaned.replace(/MNEMON RUNTIME MEMORY SNAPSHOT[\s\S]*?MNEMON VIEW TOOLS[^\n]*\n*/gi, '');
    cleaned = cleaned.replace(/MNEMON RUNTIME MEMORY SNAPSHOT[\s\S]*?<\/runtime-memory-file>\s*/gi, '');

    // 2. Strip system reminder tags
    cleaned = cleaned.replace(/<system-reminder>[\s\S]*?<\/system-reminder>\s*/gi, '');

    // 3. Strip runtime context & approval notices
    cleaned = cleaned.replace(/Current runtime context[\s\S]*?Approval policy:[^\n]*\n*/gi, '');
    cleaned = cleaned.replace(/Current runtime context[\s\S]*?\n\n/gi, '');
    cleaned = cleaned.replace(/The approval policy changed from[^\n]*\n*/gi, '');
    cleaned = cleaned.replace(/\[sandbox:[^\]]*\]\s*/gi, '');
    cleaned = cleaned.replace(/A skill is a reusable set of task-specific instructions[\s\S]*?<\/available_skills>\s*/gi, '');

    return cleaned.trim();
  }

  /**
   * Assistant streaming chunk
   */
  onDshAssistantChunk(userOpenid, sessionId, event) {
    const chunkText = event.data?.text || event.data?.content || '';
    if (!chunkText) return;

    let buf = this.assistantBuffers.get(sessionId) || '';
    buf += chunkText;
    this.assistantBuffers.set(sessionId, buf);

    // Refresh typing indicator periodically during streaming
    const now = Date.now();
    if (now - this.lastMsgTime < 180000 && (!this.lastTypingTime || now - this.lastTypingTime > 30000)) {
      this.lastTypingTime = now;
      if (this.lastMsgId) {
        void this.apiClient.sendTyping(userOpenid, this.lastMsgId);
      }
    }
  }

  /**
   * Complete assistant message finished -> Push reply to QQ
   */
  async onDshAssistantMessage(userOpenid, sessionId, event) {
    if (this.streamTimers.has(sessionId)) {
      clearTimeout(this.streamTimers.get(sessionId));
      this.streamTimers.delete(sessionId);
    }
    this.assistantBuffers.delete(sessionId);

    // Cancel any pending tool aggregation timer and clear buffer since final answer arrived
    if (this.toolAggregateTimer) {
      clearTimeout(this.toolAggregateTimer);
      this.toolAggregateTimer = null;
    }
    if (this.toolBuffer) {
      this.toolBuffer.clear();
    }

    const message = event.data?.message || event.data;
    const textBlocks = (message?.content || [])
      .filter((c) => c.type === 'text')
      .map((c) => c.text);

    let fullText = textBlocks.join('\n').trim();
    if (!fullText) return;

    // Clean internal tags if any
    fullText = fullText
      .replace(/<think>[\s\S]*?<\/think>/g, '')
      .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
      .trim();

    if (!fullText) return;

    this.logger.info?.(`[MessageBridge] Pushing assistant response to QQ (${fullText.length} chars)`);

    // Chunk if text exceeds 3800 characters (QQ single message safety margin)
    const CHUNK_SIZE = 3800;
    for (let i = 0; i < fullText.length; i += CHUNK_SIZE) {
      const slice = fullText.slice(i, i + CHUNK_SIZE);
      const isPassive = this.lastMsgId && Date.now() - this.lastMsgTime < 240000;

      try {
        await this.apiClient.sendC2CMessage(userOpenid, {
          markdown: slice,
          ...(isPassive ? { msg_id: this.lastMsgId } : {}),
        });
      } catch (err) {
        this.logger.error?.(`[MessageBridge] Failed to send assistant message to QQ: ${err.message}`);
      }
    }
  }

  /**
   * Real-time Tool invocation notification -> Optional progress aggregation to QQ
   */
  async onDshToolCall(userOpenid, event) {
    const toolName = event.data?.name || event.data?.toolName || '工具';
    this.logger.debug?.(`[MessageBridge] Tool called: ${toolName}`);

    // Refresh typing indicator
    if (this.lastMsgId && Date.now() - this.lastMsgTime < 180000) {
      void this.apiClient.sendTyping(userOpenid, this.lastMsgId);
    }

    const config = this.getConfig();
    // Default disabled: only sync when explicitly enabled in settings
    if (!config.syncToolCalls) {
      return;
    }

    // Buffer tool calls for window aggregation (prevents message flooding)
    if (!this.toolBuffer) this.toolBuffer = new Map();
    const currentCount = (this.toolBuffer.get(toolName) || 0) + 1;
    this.toolBuffer.set(toolName, currentCount);

    if (!this.toolAggregateTimer) {
      const windowMs = config.toolCallAggregateWindowMs || 30000;
      this.toolAggregateTimer = setTimeout(async () => {
        this.toolAggregateTimer = null;
        await this.flushToolBuffer(userOpenid);
      }, windowMs);
    }
  }

  /**
   * Flush aggregated tool calls as a single concise progress message
   */
  async flushToolBuffer(userOpenid) {
    if (!this.toolBuffer || this.toolBuffer.size === 0) return;

    const parts = [];
    let total = 0;
    for (const [name, count] of this.toolBuffer.entries()) {
      total += count;
      parts.push(count > 1 ? `${name} (${count}次)` : name);
    }
    this.toolBuffer.clear();

    const summary = `⚙️ **[Agent 执行进展]** 最近完成了 ${total} 项操作: \`${parts.join(', ')}\`...`;
    try {
      await this.apiClient.sendC2CMessage(userOpenid, { markdown: summary });
    } catch {
      // ignore
    }
  }

  /**
   * Turn finished
   */
  onDshTurnEnd(sessionId) {
    this.assistantBuffers.delete(sessionId);
  }

  /**
   * Stop and cleanup all listeners
   */
  stop() {
    for (const dispose of this.eventDisposers) {
      try {
        dispose();
      } catch {
        // ignore
      }
    }
    this.eventDisposers = [];

    for (const timer of this.streamTimers.values()) {
      clearTimeout(timer);
    }
    this.streamTimers.clear();

    if (this.toolAggregateTimer) {
      clearTimeout(this.toolAggregateTimer);
      this.toolAggregateTimer = null;
    }
    if (this.toolBuffer) {
      this.toolBuffer.clear();
    }

    this.assistantBuffers.clear();
    this.recentRpcIds.clear();
    this.userNewSessionState.clear();
  }
}
