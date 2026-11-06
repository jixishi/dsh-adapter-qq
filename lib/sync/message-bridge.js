import { randomUUID } from 'node:crypto';
import { resolve, join, dirname, basename } from 'node:path';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { KeyboardBuilder } from '../ui/keyboard.js';
import { emojiSlotOf, SESSION_EMOJIS } from '../ui/emoji.js';
import { IMAGE_MEDIA_TYPES, formatBytes, inferAttachmentMediaType, sanitizeFilename } from '../qq/media.js';
import { renderTextImage } from '../render/index.js';
import {
  buildAgentStatusMarkdown,
  buildJobsMarkdown,
  buildScheduleMarkdown,
  collectAgentOverview,
  collectScheduleTasks,
  hasTerminalPlugin,
  hasTerminalTool,
} from './task-overview.js';
import { buildScheduleTypst } from './task-card.js';
import { describeTurnEnd, formatTurnEndNotice, formatRestartNotice } from './turn-notice.js';
import { buildAgentStatusTypst, buildJobsTypst } from './agent-card.js';
import {
  buildUsageMarkdown,
  buildUsageTypst,
  fetchRelayDirectory,
  fetchUsagePricing,
  fetchUsageStats,
  hasUsageBillingPlugin,
  parseUsageRange,
  USAGE_RANGE_LABELS,
} from './usage.js';
import {
  detectUsageSource,
  fetchTokenMetricsSummary,
  fetchTokenMetricsVersion,
  hasTokenMetricsPlugin,
  normalizeTokenMetrics,
} from './token-metrics.js';
import { buildStatsMarkdown, buildStatsTypst } from './stats-card.js';
import {
  QQ_MESSAGE_SOFT_LIMIT,
  SUBSCRIPTION_INTERVALS,
  intervalLabel,
  shouldSendDigestAsImage,
} from './subscriptions.js';

/**
 * Extract a positive 1-based page number from command arguments.
 * Accepts "2", "page 2", ["page","2"] and ["2"].
 * @param {string|string[]|undefined} input
 * @returns {number|null}
 */
function parsePageToken(input) {
  const tokens = Array.isArray(input) ? input : [input];
  for (const token of tokens) {
    if (token === undefined || token === null) continue;
    const text = String(token).trim();
    if (!text || /^page$/i.test(text)) continue;
    const num = Number.parseInt(text, 10);
    if (Number.isFinite(num) && num > 0) return num;
  }
  return null;
}

import { resolvePermissionLabel, resolvePresetLabel } from '../labels.js';

export { resolvePermissionLabel, resolvePresetLabel };

/**
 * Format a workspace path for the session list.
 * `tail` keeps only the final folder; `full` keeps the entire path.
 * @param {string} fullPath
 * @param {'tail'|'full'} [mode='tail']
 * @returns {string}
 */
export function displayWorkspacePath(fullPath, mode = 'tail') {
  const raw = String(fullPath ?? '').trim();
  if (!raw) return '未指定';
  if (mode === 'full') return raw;
  const withoutTrailing = raw.replace(/[\\/]+$/, '');
  const parts = withoutTrailing.split(/[\\/]/).filter(Boolean);
  if (parts.length === 0) return withoutTrailing || raw;
  return parts[parts.length - 1];
}


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
   * @param {Object} [options.inventory] - Skills / MCP admin inventory (AdminInventory)
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
    inventory = null,
    logger = console,
  }) {
    this.ctx = ctx;
    this.apiClient = apiClient;
    this.gateway = gateway;
    this.sessionManager = sessionManager;
    this.approvalHandler = approvalHandler;
    this.getConfig = getConfig;
    this.updateConfig = updateConfig;
    this.inventory = inventory;
    this.logger = logger;

    this.lastMsgId = null;
    this.lastMsgTime = 0;
    this.recentRpcIds = new Set();

    // Streaming buffer and execution notification throttles
    this.assistantBuffers = new Map();
    this.streamTimers = new Map();
    // Per-session incremental delivery state for the optional streamReply mode
    this.streamState = new Map();
    this.lastToolNotifyTime = 0;

    // Interactive New Session State per user: userOpenid -> { currentPath, page, lastCardMsgId }
    this.userNewSessionState = new Map();
    // Model Selection Page State per user: userOpenid -> { page, lastCardMsgId }
    this.userModelPageState = new Map();
    // Session list page state per user: userOpenid -> { page, lastCardMsgId }
    this.userSessionPageState = new Map();
    // Skills / MCP list page state per user
    this.userSkillsPageState = new Map();
    this.userMcpPageState = new Map();
    // Last assistant text per session, used by /render
    this.lastAssistantText = new Map();

    // Per-session turn bookkeeping for abnormal turn-end notices:
    // { turn, lastTool, lastToolAt, startedAt, sawOutput }.
    this.turnState = new Map();
    // Sessions the user cancelled FROM QQ. Their `aborted` turn-end is the
    // expected consequence of /cancel, which already replied — no second notice.
    this.qqCancelledSessions = new Set();

    // Session subscriptions (background notifications for non-active sessions).
    // Injected by index.js so the bridge stays free of storage concerns.
    this.subscriptionStore = null;
    this.subscriptionScheduler = null;
    // Quick-reply target per user: userOpenid -> { sessionId, title, expiresAt }
    this.userReplyTarget = new Map();
    // Last notification message id per session, so a reply to that QQ message can
    // be matched back to the session without an explicit /reply command.
    this.subscriptionNoticeByMsgId = new Map();

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
      // QQ's own "reply to this message" gesture, and passive replies, both
      // carry a reference to the quoted message. When that message is one of our
      // subscription notices we route the text straight to that session.
      const replyToMsgId =
        data.message_reference?.message_id ||
        data.message_reference?.id ||
        data.msg_id ||
        data.referenced_message?.id ||
        '';
      await this.handleUserPrompt(authorOpenid, content, attachments, msgId, replyToMsgId);
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
      '代理状态': '/status',
      '状态': '/status',
      'status': '/status',
      '任务': '/tasks',
      '任务管理': '/tasks',
      'tasks': '/tasks',
      '后台任务': '/jobs',
      'jobs': '/jobs',
      '用量': '/usage',
      '费用': '/usage',
      '账单': '/usage',
      'usage': '/usage',
      '订阅': '/subscribe',
      'subscribe': '/subscribe',
      '管理': '/help',
      '订阅列表': '/subscriptions',
      'subscriptions': '/subscriptions',
      '取消订阅': '/unsubscribe',
      'unsubscribe': '/unsubscribe',
      '会话订阅': '/subscriptions',
      '用量计费': '/usage',
      // The menu item sends the text `/delivery`, but a type-11/12 callback may
      // deliver the item's name instead, so both names route to the same card.
      '插话方式': '/delivery',
      '投递方式': '/delivery',
      '快速回复': '/reply',
      '回复': '/reply',
      'reply': '/reply',
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
      '技能': '/skills',
      '技能管理': '/skills',
      'skills': '/skills',
      'skill': '/skills',
      'MCP': '/mcp',
      'MCP管理': '/mcp',
      'MCP 服务': '/mcp',
      'MCP 管理': '/mcp',
      'mcp': '/mcp',
      '渲染': '/render',
      '渲染为图片': '/render',
      'render': '/render',
      '发送文件': '/send',
      'send-file': '/send',
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
          await this.cmdListSessions(userOpenid, msgId, args);
          break;

        case '/skills':
        case '/skill-list':
        case '/技能':
        case '/技能列表':
          await this.cmdSkills(userOpenid, msgId, args);
          break;

        case '/skill':
        case '/技能详情':
          await this.cmdSkill(userOpenid, args, msgId);
          break;

        case '/mcp':
        case '/mcp-list':
        case '/服务':
          await this.cmdMcp(userOpenid, args, msgId);
          break;

        case '/render':
        case '/渲染':
        case '/t2i':
          await this.cmdRender(userOpenid, args, msgId);
          break;

        case '/send':
        case '/发送文件':
          await this.cmdSendFile(userOpenid, args, msgId);
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

        case '/status':
        case '/状态':
        case '/agents':
        case '/代理状态':
          await this.cmdStatus(userOpenid, msgId);
          break;

        case '/tasks':
        case '/任务':
        case '/任务管理':
        case '/schedule':
        case '/定时任务':
          await this.cmdTasks(userOpenid, msgId);
          break;

        case '/jobs':
        case '/后台任务':
          await this.cmdJobs(userOpenid, msgId);
          break;

        case '/usage':
        case '/用量':
        case '/费用':
        case '/账单':
          await this.cmdUsage(userOpenid, msgId, args[0]);
          break;

        case '/subscribe':
        case '/订阅':
          await this.cmdSubscribe(userOpenid, args, msgId);
          break;

        case '/unsubscribe':
        case '/取消订阅':
          await this.cmdUnsubscribe(userOpenid, args, msgId);
          break;

        case '/subscriptions':
        case '/订阅列表':
          await this.cmdSubscriptions(userOpenid, msgId);
          break;

        case '/reply':
        case '/回复':
          await this.cmdReply(userOpenid, args, msgId);
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

        case '/steer':
        case '/插话':
          await this.cmdSteer(userOpenid, args, msgId);
          break;

        case '/queue':
        case '/排队':
          await this.cmdQueue(userOpenid, args, msgId);
          break;

        case '/qsteer':
          await this.cmdQueueSteer(userOpenid, args, msgId);
          break;

        case '/qdrop':
          await this.cmdQueueDrop(userOpenid, args, msgId);
          break;

        case '/delivery':
        case '/投递':
          await this.cmdDelivery(userOpenid, args, msgId);
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
   * Command: /sessions [page] - Flattened, paginated session list with per-page emoji markers
   */
  async cmdListSessions(userOpenid, msgId, pageArg) {
    const pageSize = Math.max(1, Number(this.getConfig().sessionPageSize) || 6);
    const requestedPage = parsePageToken(pageArg);
    const state = this.userSessionPageState.get(userOpenid) || {};
    const page = requestedPage || state.page || 1;

    this.recallPreviousSessionCard(userOpenid);

    const result = await this.sessionManager.getSessionPage(page, pageSize);
    const activeId = await this.sessionManager.getActiveSessionId();
    const pathMode = this.getConfig().sessionPathDisplay === 'full' ? 'full' : 'tail';

    let presets = [];
    try {
      presets = await this.sessionManager.listPresets();
    } catch {
      presets = [];
    }
    let permissions = [];
    try {
      permissions = (await this.sessionManager.listPermissions()) || [];
    } catch {
      permissions = [];
    }

    if (!result || result.total === 0) {
      const res = await this.apiClient.sendC2CMessage(userOpenid, {
        markdown: '📋 **【DSH 工作区与会话列表】**\n\n当前暂无任何会话。点击下方按钮新建会话：',
        keyboard: KeyboardBuilder.keyboard([[
          KeyboardBuilder.button({ id: 'btn_new', label: '➕ 新建会话', data: '/new', style: 1 }),
        ]]),
        msg_id: msgId,
      });
      this.userSessionPageState.set(userOpenid, { page: 1, lastCardMsgId: res?.id || null });
      return;
    }

    const lines = [
      '📋 **【DSH 工作区与会话列表】**',
      '',
      `分页: 第 ${result.page}/${result.totalPages} 页 (共 ${result.total} 个会话，每页 ${pageSize} 个)`,
      '',
    ];

    for (const group of result.groups) {
      const ws = group.workspace;
      const isRemote = ws.isRemote ? ' *(远程工作区)*' : '';
      const sessions = Array.isArray(group.sessions) ? group.sessions : [];
      lines.push(`📁 **${ws.title}**${isRemote}`);
      if (ws.path) {
        lines.push(`  └ 路径: \`${displayWorkspacePath(ws.path, pathMode)}\``);
      }

      // All sessions of one workspace form a single `>` quote block, so they
      // read as children of that workspace instead of a flat list. A blank
      // line is required before the block for QQ's Markdown parser.
      if (sessions.length > 0) lines.push('');
      for (const s of sessions) {
        const isActive = s.sessionId === activeId;
        const statusIcon = s.running ? '🔄' : '💤';
        const activePrefix = isActive ? '⭐ **[当前活跃]** ' : '';
        const presetLabel = resolvePresetLabel(s.agentPreset, presets);
        const permissionLabel = resolvePermissionLabel(s.permission, permissions);
        lines.push(
          `> ${s.index}. ${activePrefix}**${s.title}** ${s.emoji} ${statusIcon} [\`${presetLabel}\` | \`${permissionLabel}\`]`
        );
      }
      lines.push('');
    }

    lines.push(`🎯 **本页按键标识**: ${result.items.map((s) => `${s.emoji}${s.index}`).join('  ')}`);
    lines.push('');
    lines.push('💡 点击按键切换会话，或发送 `/switch <序号>`、`/switch <emoji>`、`/switch <标题关键字>`。');
    lines.push('📄 发送 `/sessions <页码>` 或点击操作板翻页。');

    const res = await this.apiClient.sendC2CMessage(userOpenid, {
      markdown: lines.join('\n'),
      keyboard: KeyboardBuilder.buildSessionsBoard({
        sessions: result.items,
        activeSessionId: activeId,
        page: result.page,
        totalPages: result.totalPages,
      }),
      msg_id: msgId,
    });

    this.userSessionPageState.set(userOpenid, { page: result.page, lastCardMsgId: res?.id || null });
  }

  /**
   * Write a downloaded upload without overwriting an existing file.
   * @returns {Promise<string>} absolute path actually written
   */
  async writeUniqueFile(dir, filename, buffer) {
    const dot = filename.lastIndexOf('.');
    const stem = dot > 0 ? filename.slice(0, dot) : filename;
    const ext = dot > 0 ? filename.slice(dot) : '';
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const candidate = attempt === 0 ? filename : `${stem}-${attempt}${ext}`;
      try {
        await writeFile(join(dir, candidate), buffer, { flag: 'wx' });
        return join(dir, candidate);
      } catch (err) {
        if (err.code !== 'EEXIST') throw err;
      }
    }
    throw new Error(`Unable to allocate a unique upload name for "${filename}"`);
  }

  /**
   * Recall previous sessions list card to keep chat history clean
   * @param {string} userOpenid
   */
  recallPreviousSessionCard(userOpenid) {
    const state = this.userSessionPageState.get(userOpenid);
    if (state?.lastCardMsgId) {
      if (typeof this.apiClient?.recallC2CMessage === 'function') {
        void this.apiClient.recallC2CMessage(userOpenid, state.lastCardMsgId);
      }
      state.lastCardMsgId = null;
    }
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
   * Command: /switch <sessionIdOrIndexOrEmojiOrTitle>
   */
  async cmdSwitchSession(userOpenid, sessionIdOrIndex, msgId) {
    if (!sessionIdOrIndex) {
      await this.cmdListSessions(userOpenid, msgId, null);
      return;
    }

    const pageSize = Math.max(1, Number(this.getConfig().sessionPageSize) || 6);
    const state = this.userSessionPageState.get(userOpenid) || {};
    const token = String(sessionIdOrIndex).trim();
    let target = null;
    let currentPage = state.page || 1;

    // 1. Emoji marker of the page the user is currently looking at
    const slot = emojiSlotOf(token);
    if (slot >= 0) {
      const pageData = await this.sessionManager.getSessionPage(currentPage, pageSize);
      currentPage = pageData.page;
      target = pageData.items.find((s) => s.emoji === SESSION_EMOJIS[slot]) || pageData.items[slot] || null;
    }

    // 2. Global 1-based index
    if (!target) {
      const num = Number.parseInt(token, 10);
      if (Number.isFinite(num) && num >= 1) {
        target = await this.sessionManager.findSessionByIndex(num);
      }
    }

    // 3. Session ID prefix or title substring
    const { allSessions } = await this.sessionManager.listSessionsGroupedByWorkspace();
    if (!target) {
      const lower = token.toLowerCase();
      target =
        allSessions.find((s) => s.sessionId.includes(token)) ||
        allSessions.find((s) => String(s.title || '').toLowerCase().includes(lower)) ||
        null;
    }

    if (!target) {
      await this.apiClient.sendC2CMessage(userOpenid, {
        markdown: [
          `⚠️ 未找到会话: \`${token}\``,
          '',
          '💡 可发送 `/sessions` 查看列表后，点击按键或用 `/switch <序号>`、`/switch <emoji>` 切换。',
        ].join('\n'),
        msg_id: msgId,
      });
      return;
    }

    await this.sessionManager.setActiveSessionId(target.sessionId);
    const info = await this.sessionManager.getActiveSessionInfo();

    const targetPage = Math.max(1, Math.ceil((Number(target.index) || 1) / pageSize));
    this.userSessionPageState.set(userOpenid, { ...state, page: targetPage });

    // Optional call: this line is a nicety, so a session manager without the
    // projection-backed helper still renders the card.
    const lastMessage = this.sessionManager.resolveLastUserMessage?.(targetId) ?? null;

    const lines = [
      '✅ **【已切换活跃会话】**',
      '',
      `> **标题**: ${target.emoji ? target.emoji + ' ' : ''}${info?.title || target.title || target.sessionId}`,
      `> **会话 ID**: \`${target.sessionId}\``,
      `> **预设**: \`${info?.agentPreset || 'standard'}\``,
      `> **权限**: \`${info?.permission || '默认'}\``,
      ...this.describeLastMessage(lastMessage),
      `> **状态**: ${info?.running ? '🔄 执行中' : '💤 空闲'}`,
      `> **工作区**: \`${info?.cwd || '未指定'}\``,
      '',
      `💬 现在您可以直接发送消息与 Agent 对话。(该会话位于第 ${targetPage} 页)`,
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

    // Optional call: this line is a nicety, so a session manager without the
    // projection-backed helper still renders the card.
    const lastMessage = this.sessionManager.resolveLastUserMessage?.(info.sessionId) ?? null;
    const lines = [
      '📌 **【当前活跃会话详情】**',
      '',
      `> **标题**: ${info.title}`,
      `> **会话 ID**: \`${info.sessionId}\``,
      `> **AI 模型**: **${curModel}** (${curProvider})`,
      `> **思考等级**: **${curEffort}**`,
      `> **Agent 预设**: \`${resolvePresetLabel(info.agentPreset)}\``,
      `> **权限模式**: \`${resolvePermissionLabel(info.permission)}\``,
      ...this.describeLastMessage(lastMessage),
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
   * Command: /stats - Show session execution stats as a Typst metric card.
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

    const markdown = buildStatsMarkdown(data);
    const typstBody = buildStatsTypst(data, { theme: this.getConfig().renderTheme || 'light' });
    await this.sendOverviewImage(userOpenid, {
      markdown,
      typstBody,
      expectTypstBody: true,
      title: 'DSH 会话统计',
      caption: `> 会话：**${data.title}**${data.modelSelection?.model ? ` · 模型：\`${data.modelSelection.model}\`` : ''}`,
      msgId,
      keyboard: KeyboardBuilder.buildStatsBoard(),
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
        const target = await this.sessionManager.switchPermission(modeName);
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
   * Command: /answer <questionId> <encodedLabel|A,B|__submit__>
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

    const result = await this.approvalHandler.handleQuestionAnswer(questionId, optionLabel);

    if (result?.ok) {
      // Toggling a multi-select option re-renders the card in place; no extra text.
      if (result.kind === 'toggled' || result.kind === 'pending') {
        return;
      }
      await this.apiClient.sendC2CMessage(userOpenid, {
        content: result.message || '✅ 已提交回答，Agent 将继续执行。',
        msg_id: msgId,
      });
    } else {
      await this.apiClient.sendC2CMessage(userOpenid, {
        content: `⚠️ ${result?.error || '未找到对应的待回答问题（可能已被处理或已超时）。'}`,
        msg_id: msgId,
      });
    }
  }

  /**
   * Command: /cancel
   */
  async cmdCancel(userOpenid, msgId) {
    const ok = await this.sessionManager.cancelActiveTurn();
    if (ok) {
      // The turn will now end as `aborted`. That is our own doing and the
      // receipt below already says so, so the abnormal-turn notice must skip it.
      try {
        const activeId = await this.sessionManager.getActiveSessionId();
        if (activeId) this.qqCancelledSessions.add(activeId);
      } catch {
        // Bookkeeping must never block the cancel itself.
      }
    }
    await this.apiClient.sendC2CMessage(userOpenid, {
      content: ok ? '🛑 已向 Agent 发送取消指令，正在停止当前轮次。' : 'ℹ️ 当前会话没有正在运行的轮次。',
      msg_id: msgId,
    });
  }

  /**
  /**
   * Command: /steer <text> — force an immediate interjection into the running
   * turn (single-message override of the configured delivery).
   */
  async cmdSteer(userOpenid, args, msgId) {
    const text = args.join(' ').trim();
    if (!text) {
      await this.apiClient.sendC2CMessage(userOpenid, {
        content: '💡 用法：`/steer 要立刻告诉 Agent 的话`（运行中才会注入当前轮，空闲时按普通消息发送）',
        msg_id: msgId,
      });
      return;
    }
    await this.handleUserPrompt(userOpenid, text, [], msgId, '', 'steer');
  }

  /**
   * Command: /queue [text] — with text, deliver it after the current turn;
   * with no text, list what is already queued.
   */
  async cmdQueue(userOpenid, args, msgId) {
    const text = args.join(' ').trim();
    if (!text) {
      await this.cmdQueueList(userOpenid, msgId);
      return;
    }
    await this.handleUserPrompt(userOpenid, text, [], msgId, '', 'queue');
  }

  /**
   * Command: /queue (no argument) — list the messages waiting for a later turn,
   * with a steer/remove board, mirroring the Web UI queue rows.
   */
  async cmdQueueList(userOpenid, msgId) {
    const sessionId = await this.sessionManager.getActiveSessionId();
    if (!sessionId) {
      await this.apiClient.sendC2CMessage(userOpenid, { content: 'ℹ️ 当前没有活跃会话。', msg_id: msgId });
      return;
    }

    const { nextTurn, nextStep } = this.sessionManager.getInbox(sessionId);
    if (nextTurn.length === 0 && nextStep.length === 0) {
      await this.apiClient.sendC2CMessage(userOpenid, { content: '📭 当前没有排队中的消息。', msg_id: msgId });
      return;
    }

    const header = nextTurn.length > 0 ? `📥 **排队中（本轮结束后按序发送）：${nextTurn.length} 条**` : '📥 **排队中**';
    const listing = [header, ''];
    nextTurn.forEach((message, index) => {
      listing.push(`**${index + 1}.** ${this.describeQueuedMessage(message)}`);
    });
    if (nextStep.length > 0) {
      listing.push('', `⚡ 已插话（下一步骤注入）：${nextStep.length} 条`);
      nextStep.forEach((message) => listing.push(`· ${this.describeQueuedMessage(message)}`));
    }
    if (nextTurn.length > 5) {
      listing.push('', '💡 操作板只列出前 5 条，其余可用 `/qsteer <ID>` / `/qdrop <ID>` 处理。');
    }

    await this.apiClient.sendC2CMessage(userOpenid, {
      markdown: listing.join('\n'),
      // Only queued turns are actionable; with nothing but steered messages
      // there is no row to build, and an empty keyboard must not be sent.
      ...(nextTurn.length > 0
        ? { keyboard: KeyboardBuilder.buildQueueListBoard(nextTurn.map((message) => ({ itemId: message.id }))) }
        : {}),
      msg_id: msgId,
    });
  }

  /**
   * One queued message as a single listing line: its text, or its source kind
   * when it carries no text (an attachment-only message, for instance).
   * @param {Object} message - Inbox message
   * @returns {string} Single-line description
   */
  describeQueuedMessage(message) {
    const text = (message?.content ?? [])
      .filter((part) => part?.type === 'text')
      .map((part) => part.text)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
    const shown = text.length > 60 ? `${text.slice(0, 59)}…` : text;
    return shown || `（${message?.source?.kind ?? '未知'} 消息，无文本）`;
  }

  /**
   * Command: /qsteer <itemId> — promote one queued message to a steer.
   */
  async cmdQueueSteer(userOpenid, args, msgId) {
    const itemId = String(args[0] ?? '').trim();
    if (!itemId) {
      await this.apiClient.sendC2CMessage(userOpenid, { content: '💡 用法：`/qsteer <排队消息 ID>`', msg_id: msgId });
      return;
    }
    try {
      await this.sessionManager.steerQueueItem(itemId);
      await this.apiClient.sendC2CMessage(userOpenid, { content: '⚡ 已改为插话：下一个步骤注入。', msg_id: msgId });
    } catch (err) {
      await this.apiClient.sendC2CMessage(userOpenid, {
        content: `⚠️ ${this.describeQueueError(err)}`,
        msg_id: msgId,
      });
    }
  }

  /**
   * Command: /qdrop <itemId> — remove one queued message before it is sent.
   */
  async cmdQueueDrop(userOpenid, args, msgId) {
    const itemId = String(args[0] ?? '').trim();
    if (!itemId) {
      await this.apiClient.sendC2CMessage(userOpenid, { content: '💡 用法：`/qdrop <排队消息 ID>`', msg_id: msgId });
      return;
    }
    try {
      await this.sessionManager.removeQueueItem(itemId);
      await this.apiClient.sendC2CMessage(userOpenid, { content: '🗑 已移除该条排队消息。', msg_id: msgId });
    } catch (err) {
      await this.apiClient.sendC2CMessage(userOpenid, {
        content: `⚠️ ${this.describeQueueError(err)}`,
        msg_id: msgId,
      });
    }
  }

  /**
   * Turn one queue-mutation failure into a sentence that says what happens next.
   * @param {Error & { code?: string }} err - Failure from the Session Controller
   * @returns {string} QQ-facing explanation
   */
  describeQueueError(err) {
    const code = err?.code ?? '';
    if (code === 'session/steer-unavailable') return '本轮已结束或不再接受插话，这条会在下一轮正常发送。';
    if (code === 'session/queue-item-not-found') return '该条已开始执行或已被处理，无法再操作。';
    return `操作失败: ${err?.message ?? err}`;
  }

  /**
   * Command: /delivery [steer|queue] — show or set how plain text is delivered
   * while the Agent is running.
   */
  async cmdDelivery(userOpenid, args, msgId) {
    const aliases = { steer: 'steer', 插话: 'steer', queue: 'queue', 排队: 'queue' };
    const requested = aliases[String(args[0] ?? '').toLowerCase()];

    if (!requested) {
      const current = this.getConfig().busyDelivery ?? 'steer';
      await this.apiClient.sendC2CMessage(userOpenid, {
        markdown: [
          '⚡ **【插话方式】**',
          '',
          '> Agent 运行中时，QQ 里直接发送的普通文本如何投递：',
          `> ${current === 'steer' ? '⚡ 立即插话' : '📥 排队'} ← 当前`,
          '',
          '> ⚡ **立即插话**：直接注入正在运行的轮次',
          '> 📥 **排队**：等本轮结束后作为下一轮的输入发送',
          '',
          '单次覆盖：`/steer <文本>` / `/queue <文本>`。空闲时两种都会作为普通消息开新一轮。',
        ].join('\n'),
        keyboard: KeyboardBuilder.buildDeliveryBoard(current),
        msg_id: msgId,
      });
      return;
    }

    this.updateConfig({ busyDelivery: requested });
    await this.apiClient.sendC2CMessage(userOpenid, {
      content: `✅ 已设为 ${requested === 'steer' ? '⚡ 立即插话' : '📥 排队'}。`,
      msg_id: msgId,
    });
  }

  /**
   * Command: /menu (Sync global menu to QQ Open Platform)
   */
  async cmdSyncMenu(userOpenid, msgId) {
    try {
      const caps = await this.serviceCapabilities();
      try {
        const catalog = await this.sessionManager.getModelCatalog();
        const currentModel = (catalog.models || []).find(
          (model) =>
            model.id === catalog.current?.model &&
            (!catalog.current?.provider || model.provider === catalog.current.provider)
        );
        caps.efforts = (currentModel?.reasoning?.efforts || []).map((effort) => ({
          id: effort.id,
          name: effort.name || effort.id,
        }));
        caps.permissions = (this.sessionManager.listPermissions() || []).map((permission) => ({
          id: permission.id,
          name: permission.name || permission.id,
        }));
      } catch {
        // presets are optional
      }
      const res = await this.apiClient.registerDefaultGlobalMenu(caps);
      await this.apiClient.sendC2CMessage(userOpenid, {
        content: `✅ QQ 机器人全局快捷菜单注册成功 (版本号: ${res?.version || 1})！思考等级与权限已按当前模型动态生成。`,
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
   * Command: /skills [page] - Skills management menu
   */
  async cmdSkills(userOpenid, msgId, pageArg) {
    // Skill buttons use `/skills <name>` (name is not a page token): open its detail.
    if (Array.isArray(pageArg) && pageArg.length > 0 && !parsePageToken(pageArg)) {
      await this.cmdSkill(userOpenid, pageArg, msgId);
      return;
    }

    const state = this.userSkillsPageState.get(userOpenid) || {};
    const requested = parsePageToken(pageArg);
    const page = requested || state.page || 1;

    if (!this.inventory) {
      await this.apiClient.sendC2CMessage(userOpenid, {
        content: '⚠️ 当前运行环境未提供技能服务，无法列出技能。',
        msg_id: msgId,
      });
      return;
    }

    const info = await this.sessionManager.getActiveSessionInfo();
    const data = await this.inventory.listSkills({ cwd: info?.cwd });

    if (!data.available) {
      await this.apiClient.sendC2CMessage(userOpenid, {
        content: `⚠️ 技能服务不可用: ${data.note || '未知原因'}`,
        msg_id: msgId,
      });
      return;
    }

    const pageSize = 6;
    const totalPages = Math.max(1, Math.ceil(data.skills.length / pageSize));
    const safePage = Math.min(Math.max(1, page), totalPages);
    const offset = (safePage - 1) * pageSize;
    const pageSkills = data.skills.slice(offset, offset + pageSize);

    this.recallPreviousSkillsCard(userOpenid);

    const lines = [
      '🧠 **【技能管理 (Skills)】**',
      '',
      `数据源: ${data.source === 'mcp-manager' ? 'MCP 管理器（支持启停）' : 'DSH 核心（只读）'}`,
      `分页: 第 ${safePage}/${totalPages} 页 (共 ${data.skills.length} 个技能，可停用: ${data.source === 'mcp-manager' ? '是' : '否'})`,
      '',
    ];

    if (data.skills.length === 0) {
      lines.push('*(当前没有任何可用技能)*');
    } else {
      pageSkills.forEach((s) => {
        const flag = s.disabled ? '⛔' : '✅';
        const src = s.source ? ` [${s.source}]` : '';
        lines.push(`- ${flag} **${s.name}**${src}`);
        if (s.description) lines.push(`  ${s.description.slice(0, 120)}`);
      });
    }

    lines.push('');
    lines.push('💡 点击技能按钮查看详情与启停，或发送 `/skill <名称>`、`/skill on|off <名称>`。');

    const res = await this.apiClient.sendC2CMessage(userOpenid, {
      markdown: lines.join('\n'),
      keyboard: KeyboardBuilder.buildSkillsBoard({ skills: pageSkills, page: safePage, totalPages }),
      msg_id: msgId,
    });

    this.userSkillsPageState.set(userOpenid, { page: safePage, lastCardMsgId: res?.id || null });
  }

  /**
   * Command: /skill <name> | /skill on|off <name>
   */
  async cmdSkill(userOpenid, args, msgId) {
    const first = (args[0] || '').toLowerCase();
    const toggleWords = ['on', 'off', 'enable', 'disable', '启用', '停用'];
    if (toggleWords.includes(first) && args[1]) {
      const enabled = first === 'on' || first === 'enable' || first === '启用';
      const name = args[1];
      const result = await this.inventory?.toggleSkill(name, enabled);
      if (!result || !result.ok) {
        await this.apiClient.sendC2CMessage(userOpenid, {
          markdown: `⚠️ 技能 ${enabled ? '启用' : '停用'}失败: ${result?.error || '技能管理不可用'}`,
          msg_id: msgId,
        });
        return;
      }
      await this.apiClient.sendC2CMessage(userOpenid, {
        markdown: `✅ 技能 **${name}** 已${enabled ? '启用' : '停用'}${result.warning ? `\n\n> ⚠️ ${result.warning}` : ''}`,
        keyboard: KeyboardBuilder.buildSkillDetailBoard({ name, enabled }),
        msg_id: msgId,
      });
      return;
    }

    if (!args[0]) {
      await this.cmdSkills(userOpenid, msgId, null);
      return;
    }

    const info = await this.sessionManager.getActiveSessionInfo();
    const data = await this.inventory?.listSkills({ cwd: info?.cwd });
    const skill = data?.skills?.find((s) => s.name === args[0]);

    if (!skill) {
      await this.apiClient.sendC2CMessage(userOpenid, {
        markdown: `⚠️ 未找到技能: \`${args[0]}\`\n\n发送 \`/skills\` 查看可用技能列表。`,
        msg_id: msgId,
      });
      return;
    }

    const lines = [
      '🧠 **【技能详情】**',
      '',
      `> **名称**: ${skill.disabled ? '⛔' : '✅'} \`${skill.name}\``,
      `> **来源**: ${skill.source || 'unknown'}${skill.provider ? ` (${skill.provider})` : ''}`,
      `> **模型可调用**: ${skill.invocation?.modelInvocable ? '是' : '否'}`,
      `> **用户可调用**: ${skill.invocation?.userInvocable ? '是' : '否'}`,
    ];
    if (skill.path) lines.push(`> **路径**: \`${skill.path}\``);
    if (skill.description) lines.push('', skill.description);
    if (skill.whenToUse) lines.push('', `**适用场景**: ${skill.whenToUse}`);

    await this.apiClient.sendC2CMessage(userOpenid, {
      markdown: lines.join('\n'),
      keyboard: KeyboardBuilder.buildSkillDetailBoard({ name: skill.name, enabled: !skill.disabled }),
      msg_id: msgId,
    });
  }

  /**
   * Command: /mcp [page] | /mcp <id> | /mcp on|off|restart <id>
   */
  async cmdMcp(userOpenid, args, msgId) {
    const first = (args[0] || '').toLowerCase();
    const toggleWords = ['on', 'off', 'enable', 'disable', '启用', '停用', 'restart', '重启'];

    if (toggleWords.includes(first) && args[1]) {
      const id = args[1];
      let result;
      let actionText;
      if (first === 'restart' || first === '重启') {
        actionText = '重启';
        result = await this.inventory?.restartMcp(id);
      } else {
        const enabled = first === 'on' || first === 'enable' || first === '启用';
        actionText = enabled ? '启用' : '停用';
        result = await this.inventory?.setMcpEnabled(id, enabled);
      }
      if (!result || !result.ok) {
        await this.apiClient.sendC2CMessage(userOpenid, {
          markdown: `⚠️ MCP ${actionText}失败: ${result?.error || 'MCP 管理不可用'}`,
          msg_id: msgId,
        });
        return;
      }
      await this.apiClient.sendC2CMessage(userOpenid, {
        markdown: `✅ MCP 服务 \`${id}\` ${actionText}请求已提交${result.warning ? `\n\n> ⚠️ ${result.warning}` : ''}`,
        keyboard: KeyboardBuilder.buildCurrentSessionBoard(),
        msg_id: msgId,
      });
      return;
    }

    if (!this.inventory) {
      await this.apiClient.sendC2CMessage(userOpenid, { content: '⚠️ 当前运行环境未提供 MCP 服务。', msg_id: msgId });
      return;
    }

    const data = await this.inventory.listMcpServers();

    if (!data.available) {
      await this.apiClient.sendC2CMessage(userOpenid, {
        content: `⚠️ MCP 服务信息不可用: ${data.note || '未知原因'}`,
        msg_id: msgId,
      });
      return;
    }

    // Detail view: /mcp <id or serverName>
    const firstArg = String(args[0] ?? '').trim();
    const isPageTokenOnly = /^page$/i.test(firstArg) || /^\d+$/.test(firstArg);
    if (firstArg && !isPageTokenOnly) {
      const server = data.servers.find((s) => s.id === args[0] || s.serverName === args[0]);
      if (!server) {
        await this.apiClient.sendC2CMessage(userOpenid, {
          markdown: `⚠️ 未找到 MCP 服务: \`${args[0]}\`\n\n发送 \`/mcp\` 查看服务列表。`,
          msg_id: msgId,
        });
        return;
      }
      const tools = await this.inventory.mcpTools(server.serverName);
      const lines = [
        '🔌 **【MCP 服务详情】**',
        '',
        `> **名称**: ${server.serverName}${server.enabled ? ' ✅' : ' ⛔'}`,
        `> **ID**: \`${server.id}\``,
        `> **传输**: \`${server.transport || 'unknown'}\``,
        `> **层级**: \`${server.level || 'profile'}\`${server.readOnly ? ' *(只读)*' : ''}`,
        `> **工具数**: ${server.toolCount || tools.length}`,
      ];
      if (server.phase) lines.push(`> **加载器状态**: \`${server.phase}\``);
      if (tools.length > 0) {
        lines.push('', '**工具列表:**');
        tools.slice(0, 12).forEach((t) => lines.push(`- \`${t.name}\`${t.description ? `: ${t.description.slice(0, 80)}` : ''}`));
        if (tools.length > 12) lines.push(`- …还有 ${tools.length - 12} 个`);
      }
      await this.apiClient.sendC2CMessage(userOpenid, {
        markdown: lines.join('\n'),
        keyboard: KeyboardBuilder.buildMcpDetailBoard({
          id: server.id,
          enabled: server.enabled,
          canManage: data.source === 'mcp-manager' && !server.readOnly,
        }),
        msg_id: msgId,
      });
      return;
    }

    const pageSize = 6;
    const totalPages = Math.max(1, Math.ceil(data.servers.length / pageSize));
    const requested = parsePageToken(args);
    const page = requested || this.userMcpPageState.get(userOpenid)?.page || 1;
    const safePage = Math.min(Math.max(1, page), totalPages);
    const offset = (safePage - 1) * pageSize;
    const pageServers = data.servers.slice(offset, offset + pageSize);

    this.recallPreviousMcpCard(userOpenid);

    const lines = [
      '🔌 **【MCP 服务管理】**',
      '',
      `数据源: ${data.source === 'mcp-manager' ? 'MCP 管理器（支持启停/重启）' : '工具注册表推断（只读）'}`,
      `分页: 第 ${safePage}/${totalPages} 页 (共 ${data.servers.length} 个服务)`,
      '',
    ];

    if (data.servers.length === 0) {
      lines.push('*(当前没有配置 MCP 服务)*');
    } else {
      pageServers.forEach((s) => {
        const flag = s.enabled ? '✅' : '⛔';
        lines.push(`- ${flag} **${s.serverName}** \`${s.id}\` [${s.transport || 'unknown'}] 工具 ${s.toolCount || 0} 个${s.readOnly ? ' *(只读)*' : ''}`);
      });
    }

    lines.push('');
    lines.push('💡 点击服务查看详情与启停，或发送 `/mcp on|off|restart <ID>`。');

    const res = await this.apiClient.sendC2CMessage(userOpenid, {
      markdown: lines.join('\n'),
      keyboard: KeyboardBuilder.buildMcpBoard({ servers: pageServers, page: safePage, totalPages }),
      msg_id: msgId,
    });

    this.userMcpPageState.set(userOpenid, { page: safePage, lastCardMsgId: res?.id || null });
  }

  /**
   * Command: /render [text] - Render text/markdown into an image and send it to QQ
   */
  async cmdRender(userOpenid, args, msgId) {
    const activeId = await this.sessionManager.getActiveSessionId();
    const provided = args.join(' ').trim();
    const text = provided || this.lastAssistantText.get(activeId) || '';

    if (!text) {
      await this.apiClient.sendC2CMessage(userOpenid, {
        markdown: [
          '🖼️ **【文本渲染为图片】**',
          '',
          '用法: `/render <文本或 Markdown>` 直接渲染指定内容；',
          '或先让 Agent 回复一段内容，再发送 `/render` 渲染最近一条回复。',
          '',
          'Agent 也可直接调用工具 `qq_render_text_image` 完成渲染并发送。',
        ].join('\n'),
        msg_id: msgId,
      });
      return;
    }

    try {
      void this.apiClient.sendTyping?.(userOpenid, msgId);
    } catch {
      // typing is best-effort
    }

    const cfg = this.getConfig();
    const rendered = await renderTextImage({
      text,
      title: provided ? 'DSH 文本卡片' : 'DSH Agent 回复',
      theme: cfg.renderTheme || 'light',
      width: Number(cfg.renderWidth) || 900,
      logger: this.logger,
    });

    const filename = rendered.mediaType === 'image/png' ? `render-${Date.now()}.png` : `render-${Date.now()}.svg`;
    const data = await readFile(rendered.path);
    const sendResult = await this.sendLocalMedia(userOpenid, {
      data,
      filename,
      mediaType: rendered.mediaType,
      msgId,
    });

    await this.apiClient.sendC2CMessage(userOpenid, {
      markdown: [
        '🖼️ **【渲染完成】**',
        `> 引擎: \`${rendered.engine}\``,
        `> 尺寸: ${rendered.width}x${rendered.height}`,
        `> 文件: \`${rendered.path}\``,
        `> 已发送到 QQ: ${sendResult.ok ? '是' : `否 (${sendResult.error})`}`,
      ].join('\n'),
      msg_id: msgId,
    });
  }

  /** Optional official services: team roster, persistent terminal jobs, schedule tasks. */
  async serviceCapabilities() {
    const hostGet = (name) => (typeof this.ctx?.get === 'function' ? this.ctx.get(name) : undefined);
    let agent;
    let agentCtx;
    try {
      const activeId = await this.sessionManager.getActiveSessionId();
      agent = hostGet('agents')?.get?.(activeId);
      agentCtx = agent?.ctx;
    } catch {
      agentCtx = undefined;
    }
    const get = (name) => {
      const scoped = agentCtx && typeof agentCtx.get === 'function' ? agentCtx.get(name) : undefined;
      return scoped ?? hostGet(name);
    };
    return {
      team: Boolean(get('agentTeams')?.listMembers),
      terminal:
        Boolean(get('terminals')) ||
        hasTerminalTool(agentCtx, agent, this.ctx) ||
        (await hasTerminalPlugin(this.ctx)),
      schedule: Boolean(get('schedule')?.catalog),
      usage: (await hasTokenMetricsPlugin(this.ctx)) || (await hasUsageBillingPlugin(this.ctx)),
    };
  }

  /**
   * Render Markdown (or a dedicated Typst body) into a PNG/SVG and send it,
   * falling back to plain text.
   * @param {string} userOpenid
   * @param {{markdown:string,typstBody?:string,title:string,caption?:string,msgId?:string}} options
   */
  async sendOverviewImage(userOpenid, { markdown, typstBody = '', title, caption = '', msgId, expectTypstBody = false }) {
    const cfg = this.getConfig();
    // A card-oriented command (/usage, /stats, /status ...) is supposed to hand
    // over a purpose-built Typst body. When that body is missing the generic
    // markdown renderer silently produces a plain-text-looking picture instead of
    // the card layout, which looks like "the template disappeared". Say so.
    if (expectTypstBody && !typstBody) {
      this.logger.warn?.(
        `[MessageBridge] "${title}" 未提供 Typst 卡片模板（typstBody 为空），将退化为通用 Markdown 排版`
      );
    }
    try {
      const rendered = await renderTextImage({
        text: markdown,
        typstBody,
        title,
        theme: cfg.renderTheme || 'light',
        width: Number(cfg.renderWidth) || 900,
        logger: this.logger,
      });
      const ext = rendered.mediaType === 'image/png' ? 'png' : 'svg';
      const data = await readFile(rendered.path);
      const sendResult = await this.sendLocalMedia(userOpenid, {
        data,
        filename: `overview-${Date.now()}.${ext}`,
        mediaType: rendered.mediaType,
        msgId,
      });
      const layout = typstBody ? '卡片模板' : '通用排版';
      const lines = [
        `📊 **${title}**`,
        caption,
        sendResult.ok
          ? `> 图片已发送（${rendered.engine} · ${layout} · ${rendered.width}×${rendered.height}）`
          : `> ⚠️ 图片发送失败：${sendResult.error}（以下为文本版）`,
      ].filter(Boolean);
      if (!sendResult.ok) {
        await this.apiClient.sendC2CMessage(userOpenid, { markdown: lines.join('\n'), msg_id: msgId });
        await this.apiClient.sendC2CMessage(userOpenid, { markdown: markdown.slice(0, 4000), msg_id: msgId });
      } else if (cfg.sendOverviewCaption === true) {
        await this.apiClient.sendC2CMessage(userOpenid, { markdown: lines.join('\n'), msg_id: msgId });
      }
    } catch (error) {
      this.logger.warn?.(`[MessageBridge] overview image failed: ${error.message}`);
      await this.apiClient.sendC2CMessage(userOpenid, {
        markdown: `⚠️ 图片渲染失败：${error.message}\n\n${markdown.slice(0, 3500)}`,
        msg_id: msgId,
      });
    }
  }

  /**
   * Command: /status - image of the main agent, team members/subagents and running jobs.
   */
  async cmdStatus(userOpenid, msgId) {
    const overview = await collectAgentOverview({ ctx: this.ctx, sessionManager: this.sessionManager });
    if (!overview.main) {
      await this.apiClient.sendC2CMessage(userOpenid, {
        markdown: '📊 **【代理状态】**\n\n当前没有活跃会话，无法读取主代理状态。',
        keyboard: KeyboardBuilder.keyboard([[
          KeyboardBuilder.button({ id: 'btn_new', label: '➕ 新建会话', data: '/new', style: 1 }),
          KeyboardBuilder.button({ id: 'btn_list', label: '📋 会话列表', data: '/sessions' }),
        ]]),
        msg_id: msgId,
      });
      return;
    }
    const markdown = buildAgentStatusMarkdown(overview);
    const typstBody = buildAgentStatusTypst(overview, { theme: this.getConfig().renderTheme || 'light' });
    const members = overview.teamEnabled ? '团队成员' : '子代理';
    const jobs = overview.terminalEnabled ? overview.jobs.length : '未启用持久终端';
    await this.sendOverviewImage(userOpenid, {
      markdown,
      typstBody,
      title: 'DSH 代理与后台任务',
      expectTypstBody: true,
      caption: `> 主代理：**${overview.main.title}** · ${members} ${overview.children.length} · 后台任务 ${jobs}`,
      msgId,
    });
  }

  /**
   * Command: /tasks - image of scheduled/automation tasks (DSH "任务" page).
   */
  async cmdTasks(userOpenid, msgId) {
    const tasks = await collectScheduleTasks(this.ctx);
    if (tasks === null) {
      await this.apiClient.sendC2CMessage(userOpenid, {
        markdown: '🗓️ **【任务管理】**\n\n当前 DSH 组合未加载官方任务服务（`@deepseek-ai/dsh-schedule`），无法读取定时/自动化任务。',
        msg_id: msgId,
      });
      return;
    }
    const markdown = buildScheduleMarkdown(tasks);
    // Render the same card language as /usage and /stats. This command was the
    // only card command still handing raw Markdown to the generic renderer, which
    // is why its picture looked nothing like the others.
    const typstBody = buildScheduleTypst(tasks, { theme: this.getConfig().renderTheme || 'light' });
    const active = tasks.filter((task) => task.status !== 'inactive').length;
    await this.sendOverviewImage(userOpenid, {
      markdown,
      typstBody,
      expectTypstBody: true,
      title: '任务管理 · 定时/自动化任务',
      caption: `> 共 ${tasks.length} 个任务（启用 ${active}，已结束 ${tasks.length - active}）`,
      msgId,
    });
  }

  /**
   * Command: /jobs - image of running background jobs (requires the official
   * persistent terminal service `ctx.terminals`).
   */
  async cmdJobs(userOpenid, msgId) {
    if (!(await this.serviceCapabilities()).terminal) {
      await this.apiClient.sendC2CMessage(userOpenid, {
        markdown:
          '🖥️ **【后台任务】**\n\n当前 DSH 组合未启用官方持久终端（`@deepseek-ai/dsh-terminal`），因此没有后台任务可查看。\n\n在组合中加载 `@deepseek-ai/dsh-terminal` + `@deepseek-ai/dsh-terminal-bash` 后，`/jobs` 会自动生效。',
        msg_id: msgId,
      });
      return;
    }
    const overview = await collectAgentOverview({ ctx: this.ctx, sessionManager: this.sessionManager });
    const markdown = buildJobsMarkdown(overview.jobs);
    const typstBody = buildJobsTypst(overview.jobs, { theme: this.getConfig().renderTheme || 'light' });
    await this.sendOverviewImage(userOpenid, {
      markdown,
      typstBody,
      title: 'DSH 后台任务',
      expectTypstBody: true,
      caption: `> 运行中的后台任务：${overview.jobs.length} 个`,
      msgId,
    });
  }

  /**
   * Command: /usage - usage & cost summary.
   *
   * Two possible data sources, chosen automatically:
   *   - `dsh-token-metrics` (preferred: cost, TTFT/TPS, budget, provider quotas)
   *   - `@kenz1117/dsh-ui-usage-billing` (fallback: per-site cost breakdown)
   * When neither is installed the command explains how to install one.
   */
  async cmdUsage(userOpenid, msgId, rangeArg = '') {
    const source = await detectUsageSource(this.ctx, {
      hasBilling: () => hasUsageBillingPlugin(this.ctx),
    });
    if (!source) {
      await this.apiClient.sendC2CMessage(userOpenid, {
        markdown:
          '💰 **【用量查询】**\n\n未检测到用量统计插件。以下任一插件可用后，`/usage` 会自动注册：\n\n' +
          '- `dsh-token-metrics`（推荐：含费用、首字延迟、输出速度、预算与供应商余额）\n' +
          '  `plugin_manager install_bundle dsh-token-metrics`\n' +
          '- `@kenz1117/dsh-ui-usage-billing`（按站点费用拆分）\n' +
          '  `dsh plugin add @kenz1117/dsh-ui-usage-billing`\n\n安装后重启一次 DSH。',
        msg_id: msgId,
      });
      return;
    }
    const rawRange = String(rangeArg || '').trim().toLowerCase();
    const knownRanges = [
      '',
      'day', 'today', '日', '今日', '今天',
      'month', '月', '本月', '这月',
      'year', '年', '本年', '今年',
      'all', '累计', '全部', '总',
    ];
    if (!knownRanges.includes(rawRange)) {
      await this.apiClient.sendC2CMessage(userOpenid, {
        markdown:
          '💰 **【用量查询】**\n\n用法：`/usage [日|月|年|累计]`\n\n- `/usage 日`：今日\n- `/usage 月`：本月（默认）\n- `/usage 年`：本年\n- `/usage 累计`：全部',
        msg_id: msgId,
      });
      return;
    }
    const range = parseUsageRange(rawRange);
    try {
      const stats =
        source === 'token-metrics'
          ? normalizeTokenMetrics(await fetchTokenMetricsSummary({ ctx: this.ctx }), {
              version: await fetchTokenMetricsVersion({ ctx: this.ctx }),
            })
          : await fetchUsageStats({ ctx: this.ctx });

      let modelNames;
      let siteNames;
      if (source === 'usage-billing') {
        try {
          modelNames = await fetchUsagePricing({ ctx: this.ctx });
        } catch {
          modelNames = undefined;
        }
        try {
          siteNames = await fetchRelayDirectory({ ctx: this.ctx });
        } catch {
          siteNames = undefined;
        }
      }
      const markdown = buildUsageMarkdown(stats, { modelNames, siteNames, range });
      const typstBody = buildUsageTypst(stats, {
        theme: this.getConfig().renderTheme || 'light',
        modelNames,
        siteNames,
        range,
      });
      const version = stats?.pluginVersion ? ` v${stats.pluginVersion}` : '';
      const sourceLabel =
        source === 'token-metrics' ? `dsh-token-metrics${version}` : `@kenz1117/dsh-ui-usage-billing${version}`;
      const label = USAGE_RANGE_LABELS[range] || USAGE_RANGE_LABELS.month;
      await this.sendOverviewImage(userOpenid, {
        markdown,
        typstBody,
        expectTypstBody: true,
        title: 'DSH 用量与费用',
        caption: `> 统计范围：**${label}** · 数据来源：\`${sourceLabel}\``,
        msgId,
      });
    } catch (error) {
      const hint =
        source === 'token-metrics'
          ? '`dsh-token-metrics` 已启用且其 HTTP 接口可访问（`/api/dsh-token-metrics/summary`）'
          : '`@kenz1117/dsh-ui-usage-billing` 已启用且宿主 Web 服务可访问';
      await this.apiClient.sendC2CMessage(userOpenid, {
        markdown: `⚠️ **用量查询失败**\n\n${error.message}\n\n请确认 ${hint}。`,
        msg_id: msgId,
      });
    }
  }

  /**
   * Command: /subscribe [<序号|emoji|ID|标题>] [间隔分钟]
   * Subscribes a NON-active session so its background output is pushed as a
   * coalesced digest. Without an argument it subscribes the active session.
   */
  async cmdSubscribe(userOpenid, args, msgId) {
    const store = this.subscriptionStore;
    if (!store) {
      await this.apiClient.sendC2CMessage(userOpenid, {
        markdown: '⚠️ 订阅服务未初始化，请重启 DSH 后再试。',
        msg_id: msgId,
      });
      return;
    }

    const list = Array.isArray(args) ? args.filter(Boolean) : [];
    // A trailing supported number is the interval; the rest identifies the session.
    let intervalMinutes;
    const tokens = [...list];
    if (tokens.length > 0) {
      const candidate = Number(tokens[tokens.length - 1]);
      if (Number.isFinite(candidate) && candidate > 0 && SUBSCRIPTION_INTERVALS.includes(candidate)) {
        intervalMinutes = candidate;
        tokens.pop();
      }
    }

    let target = null;
    const token = tokens.join(' ').trim();
    if (!token) {
      const activeId = await this.sessionManager.getActiveSessionId();
      if (activeId) target = await this.sessionManager.getSessionInfoById(activeId);
    } else {
      target = await this.findSessionForSubscription(token);
    }

    if (!target) {
      await this.apiClient.sendC2CMessage(userOpenid, {
        markdown: [
          `⚠️ 未找到会话: \`${token || '(空)'}\``,
          '',
          '💡 发送 `/sessions` 查看列表，或用 `/subscribe <序号> [间隔分钟]`。',
        ].join('\n'),
        msg_id: msgId,
      });
      return;
    }

    const effectiveInterval = intervalMinutes ?? store.get(target.sessionId)?.intervalMinutes;
    const subscription = await store.subscribe({
      sessionId: target.sessionId,
      title: target.title || '',
      intervalMinutes: effectiveInterval,
    });
    this.subscriptionScheduler?.arm();

    const activeId = await this.sessionManager.getActiveSessionId();
    const isActive = target.sessionId === activeId;
    const lines = [
      '🔔 **【已开启会话订阅】**',
      '',
      `> **会话**: ${subscription.title || target.title || subscription.sessionId}`,
      `> **会话 ID**: \`${subscription.sessionId}\``,
      `> **汇聚间隔**: ${intervalLabel(subscription.intervalMinutes)}`,
      `> **当前状态**: ${isActive ? '活跃会话（已实时同步，订阅仅作备份）' : '后台会话，将按间隔汇聚推送'}`,
      '',
      isActive
        ? 'ℹ️ 这是当前活跃会话，消息本来就会实时同步；换成后台会话才有汇聚推送的意义。'
        : '📨 该会话在后台产生新消息时，会按上面的间隔合并成一条摘要推送过来。',
      '',
      '💡 调整间隔：`/subscribe <会话> <分钟>`（支持 1 / 5 / 15 / 30 / 60）',
    ];
    await this.apiClient.sendC2CMessage(userOpenid, {
      markdown: lines.join('\n'),
      keyboard: KeyboardBuilder.keyboard([
        [
          KeyboardBuilder.button({
            id: 'sub_list_btn',
            label: '📋 订阅列表',
            data: '/subscriptions',
            style: 1,
          }),
          KeyboardBuilder.button({
            id: 'sub_off_btn',
            label: '🛑 取消订阅',
            data: `/unsubscribe ${subscription.sessionId}`,
            style: 1,
          }),
        ],
      ]),
      msg_id: msgId,
    });
  }

  /**
   * Command: /unsubscribe [<会话>]
   * Without an argument it removes the subscription of the active session; when
   * exactly one subscription exists that one is removed instead of guessing.
   */
  async cmdUnsubscribe(userOpenid, args, msgId) {
    const store = this.subscriptionStore;
    if (!store) {
      await this.apiClient.sendC2CMessage(userOpenid, {
        markdown: '⚠️ 订阅服务未初始化，请重启 DSH 后再试。',
        msg_id: msgId,
      });
      return;
    }

    const token = (Array.isArray(args) ? args.join(' ') : '').trim();
    let sessionId = '';
    if (token) {
      const target = await this.findSessionForSubscription(token);
      sessionId = target?.sessionId || token;
    } else {
      const activeId = await this.sessionManager.getActiveSessionId();
      if (activeId && store.has(activeId)) {
        sessionId = activeId;
      } else if (store.list().length === 1) {
        sessionId = store.list()[0].sessionId;
      }
    }

    if (!sessionId) {
      await this.apiClient.sendC2CMessage(userOpenid, {
        markdown: '🛑 **【取消订阅】**\n\n请指定要取消的会话：`/unsubscribe <序号|emoji|ID|标题>`',
        msg_id: msgId,
      });
      return;
    }

    const existing = store.get(sessionId);
    if (!existing) {
      await this.apiClient.sendC2CMessage(userOpenid, {
        markdown: `ℹ️ 会话 \`${sessionId}\` 当前没有订阅。发送 \`/subscriptions\` 查看已订阅列表。`,
        msg_id: msgId,
      });
      return;
    }

    await store.unsubscribe(sessionId);
    this.subscriptionScheduler?.arm();
    await this.apiClient.sendC2CMessage(userOpenid, {
      markdown: [
        '🛑 **【已取消订阅】**',
        '',
        `> **会话**: ${existing.title || sessionId}`,
        `> **会话 ID**: \`${sessionId}\``,
        '',
        '该会话之后的新消息不再推送通知。',
      ].join('\n'),
      msg_id: msgId,
    });
  }

  /**
   * Command: /subscriptions - list every subscribed session with its interval
   * and how many messages are waiting for the next flush.
   */
  async cmdSubscriptions(userOpenid, msgId) {
    const store = this.subscriptionStore;
    if (!store) {
      await this.apiClient.sendC2CMessage(userOpenid, {
        markdown: '⚠️ 订阅服务未初始化，请重启 DSH 后再试。',
        msg_id: msgId,
      });
      return;
    }

    const snapshot = store.snapshot();
    const activeId = await this.sessionManager.getActiveSessionId();

    if (snapshot.subscriptions.length === 0) {
      await this.apiClient.sendC2CMessage(userOpenid, {
        markdown: [
          '📋 **【订阅列表】**',
          '',
          '当前没有订阅任何会话。',
          '',
          '💡 用 `/subscribe <序号|emoji|ID|标题> [间隔分钟]` 添加；',
          `   间隔可选：${snapshot.intervals.join(' / ')} 分钟（默认 ${snapshot.defaultInterval} 分钟）。`,
        ].join('\n'),
        msg_id: msgId,
      });
      return;
    }

    const rows = snapshot.subscriptions.map((item, index) => {
      const marks = [];
      if (item.sessionId === activeId) marks.push('活跃');
      if (item.pendingCount > 0) marks.push(`待推 ${item.pendingCount}`);
      const suffix = marks.length > 0 ? ` · ${marks.join(' · ')}` : '';
      return `> **${index + 1}.** ${item.title || item.sessionId} · ${item.intervalLabel}${suffix}`;
    });

    const lines = [
      `📋 **【订阅列表】** 共 ${snapshot.subscriptions.length} 个会话`,
      '',
      ...rows,
      '',
      '**操作**：',
      '- `/subscribe <会话> <分钟>` 修改汇聚间隔',
      '- `/unsubscribe <会话>` 取消订阅',
      '- `/reply <会话> <内容>` 直接定向回复，无需切换会话',
      '',
      `⏱ 间隔档位：${snapshot.intervals.join(' / ')} 分钟`,
    ];

    const keyboardRows = [];
    for (let i = 0; i < Math.min(snapshot.subscriptions.length, 3); i += 1) {
      const item = snapshot.subscriptions[i];
      keyboardRows.push([
        KeyboardBuilder.button({
          id: `sub_off_${i}`,
          label: `🛑 取消 ${i + 1}`,
          data: `/unsubscribe ${item.sessionId}`,
          style: 1,
        }),
        KeyboardBuilder.button({
          id: `sub_open_${i}`,
          label: `📖 打开 ${i + 1}`,
          data: `/switch ${item.sessionId}`,
          style: 1,
        }),
      ]);
    }

    await this.apiClient.sendC2CMessage(userOpenid, {
      markdown: lines.join('\n'),
      ...(keyboardRows.length > 0 ? { keyboard: KeyboardBuilder.keyboard(keyboardRows) } : {}),
      msg_id: msgId,
    });
  }

  /**
   * Command: /reply <会话> [内容]
   *
   * Two forms:
   *   - `/reply <会话>`       : arm a one-shot target; the next message goes there
   *   - `/reply <会话> <内容>` : deliver immediately, without switching sessions
   */
  async cmdReply(userOpenid, args, msgId) {
    const list = Array.isArray(args) ? args.filter(Boolean) : [];
    if (list.length === 0) {
      await this.apiClient.sendC2CMessage(userOpenid, {
        markdown: [
          '💬 **【定向快速回复】**',
          '',
          '用法：',
          '- `/reply <序号|emoji|ID|标题>`：进入定向回复态，下一条消息直接发到该会话',
          '- `/reply <会话> <内容>`：立即发送，不切换当前会话',
          '',
          '也可以直接**引用（回复）订阅通知消息**发送内容，效果相同。',
        ].join('\n'),
        msg_id: msgId,
      });
      return;
    }

    if (list[0].toLowerCase() === 'off' || list[0] === '取消') {
      this.setReplyTarget(userOpenid, '', '');
      await this.apiClient.sendC2CMessage(userOpenid, {
        markdown: '✅ 已退出定向回复，后续消息回到当前活跃会话。',
        msg_id: msgId,
      });
      return;
    }

    const target = await this.findSessionForSubscription(list[0]);
    if (!target) {
      await this.apiClient.sendC2CMessage(userOpenid, {
        markdown: `⚠️ 未找到会话: \`${list[0]}\`\n\n发送 \`/sessions\` 查看列表，或 \`/subscriptions\` 查看订阅。`,
        msg_id: msgId,
      });
      return;
    }

    const body = list.slice(1).join(' ').trim();
    if (!body) {
      this.setReplyTarget(userOpenid, target.sessionId, target.title);
      await this.apiClient.sendC2CMessage(userOpenid, {
        markdown: [
          '💬 **【已进入定向回复】**',
          '',
          `> **目标会话**: ${target.title || target.sessionId}`,
          `> **会话 ID**: \`${target.sessionId}\``,
          '',
          '接下来发送的消息会直接发到该会话，**不会切换**你当前的活跃会话。',
          '只对下一条消息生效；发送 `/reply off` 可取消。',
          '如果你原本只想查看该会话，用 `/switch` 切换过去即可。',
        ].join('\n'),
        msg_id: msgId,
      });
      return;
    }

    // Immediate delivery: reuse the normal prompt path with an explicit target.
    this.setReplyTarget(userOpenid, target.sessionId, target.title);
    await this.handleUserPrompt(userOpenid, body, [], msgId);
    await this.apiClient.sendC2CMessage(userOpenid, {
      markdown: `✅ 已定向发送到 **${target.title || target.sessionId}**（当前活跃会话未改变）。`,
      msg_id: msgId,
    });
  }

  /**
   * Describe one session, tolerating a SessionManager without getSessionInfoById
   * (older builds, test doubles). The fallback uses the already-resolved list
   * entry, so the subscription path never depends on a single method.
   *
   * @param {string} sessionId
   * @param {Object} [hint] entry already found in a listing
   * @returns {Promise<{sessionId:string,title:string,cwd?:string}|null>}
   */
  async describeSession(sessionId, hint) {
    const id = String(sessionId || '').trim();
    if (!id) return null;
    const manager = this.sessionManager;
    if (typeof manager?.getSessionInfoById === 'function') {
      try {
        const info = await manager.getSessionInfoById(id);
        if (info) return info;
      } catch {
        // fall through to the hint
      }
    }
    if (hint && hint.sessionId) return hint;
    try {
      const all = await manager.listSessions();
      const found = (all || []).find((item) => item.sessionId === id);
      if (found) return found;
    } catch {
      // ignore: callers treat null as "not found"
    }
    return { sessionId: id, title: '' };
  }

  /**
   * Resolve a user-typed session token to a session, accepting the same forms as
   * /switch (1-based index, page emoji, id prefix, title substring).
   * @param {string} token
   * @returns {Promise<{sessionId:string,title:string}|null>}
   */
  async findSessionForSubscription(token) {
    const raw = String(token || '').trim();
    if (!raw) return null;
    const lower = raw.toLowerCase();

    const slot = emojiSlotOf(raw);
    if (slot >= 0) {
      const pageData = await this.sessionManager.getSessionPage(
        1,
        Math.max(1, Number(this.getConfig().sessionPageSize) || 6)
      );
      const byEmoji = (pageData.items || []).find((item) => item.emoji === SESSION_EMOJIS[slot]);
      if (byEmoji) return this.describeSession(byEmoji.sessionId, byEmoji);
    }

    const index = Number.parseInt(raw, 10);
    if (Number.isFinite(index) && index >= 1) {
      const byIndex = await this.sessionManager.findSessionByIndex(index);
      if (byIndex) return this.describeSession(byIndex.sessionId, byIndex);
    }

    const { allSessions } = await this.sessionManager.listSessionsGroupedByWorkspace();
    const match =
      allSessions.find((item) => item.sessionId === raw) ||
      allSessions.find((item) => item.sessionId.startsWith(raw)) ||
      allSessions.find((item) => String(item.title || '').toLowerCase().includes(lower));
    if (match) return this.describeSession(match.sessionId, match);

    // Fall back to an existing subscription whose title matches.
    const subscribed = this.subscriptionStore
      ?.list()
      .find(
        (item) =>
          item.sessionId === raw ||
          item.sessionId.startsWith(raw) ||
          String(item.title || '').toLowerCase().includes(lower)
      );
    if (subscribed) return { sessionId: subscribed.sessionId, title: subscribed.title };
    return null;
  }

  async cmdSendFile(userOpenid, args, msgId) {
    const rawPath = args.join(' ').trim().replace(/^["']|["']$/g, '');
    if (!rawPath) {
      await this.apiClient.sendC2CMessage(userOpenid, {
        markdown: '📎 **【发送文件】**\n\n用法: `/send <本地文件路径>`（相对路径按当前会话工作目录解析）',
        msg_id: msgId,
      });
      return;
    }

    const info = await this.sessionManager.getActiveSessionInfo();
    const targetPath = resolve(info?.cwd || process.cwd(), rawPath);

    try {
      const data = await readFile(targetPath);
      const filename = sanitizeFilename(targetPath.split(/[\\/]/).pop());
      const result = await this.sendLocalMedia(userOpenid, { data, filename, msgId });
      if (!result.ok) {
        await this.apiClient.sendC2CMessage(userOpenid, {
          markdown: `⚠️ 发送文件失败: ${result.error}`,
          msg_id: msgId,
        });
        return;
      }
      await this.apiClient.sendC2CMessage(userOpenid, {
        markdown: `📎 已发送文件 **${filename}** (${formatBytes(data.length)}) 到 QQ。`,
        msg_id: msgId,
      });
    } catch (err) {
      await this.apiClient.sendC2CMessage(userOpenid, {
        markdown: `⚠️ 读取文件失败: ${err.message}`,
        msg_id: msgId,
      });
    }
  }

  /**
   * Helper: send local bytes to QQ, choosing image vs file by real bytes
   * @returns {Promise<{ok:boolean, error?:string, kind?:'image'|'file', messageId?:string}>}
   */
  async sendLocalMedia(userOpenid, { data, filename, mediaType, msgId }) {
    const inferred = inferAttachmentMediaType({ contentType: mediaType || '', filename, bytes: data });
    try {
      if (inferred.isImage && typeof this.apiClient.sendImage === 'function') {
        const res = await this.apiClient.sendImage(userOpenid, { data, filename, msgId });
        return { ok: true, kind: 'image', messageId: res?.messageId };
      }
      if (typeof this.apiClient.sendFile !== 'function') {
        return { ok: false, error: '当前 QQ 客户端版本不支持文件发送' };
      }
      const res = await this.apiClient.sendFile(userOpenid, { data, filename, msgId });
      return { ok: true, kind: 'file', messageId: res?.messageId };
    } catch (err) {
      this.logger.warn?.(`[MessageBridge] Failed to send local media "${filename}": ${err.message}`);
      return { ok: false, error: err.message };
    }
  }

  /**
   * Recall previous skills list card
   */
  recallPreviousSkillsCard(userOpenid) {
    const state = this.userSkillsPageState.get(userOpenid);
    if (state?.lastCardMsgId) {
      if (typeof this.apiClient?.recallC2CMessage === 'function') {
        void this.apiClient.recallC2CMessage(userOpenid, state.lastCardMsgId);
      }
      state.lastCardMsgId = null;
    }
  }

  /**
   * Recall previous MCP list card
   */
  recallPreviousMcpCard(userOpenid) {
    const state = this.userMcpPageState.get(userOpenid);
    if (state?.lastCardMsgId) {
      if (typeof this.apiClient?.recallC2CMessage === 'function') {
        void this.apiClient.recallC2CMessage(userOpenid, state.lastCardMsgId);
      }
      state.lastCardMsgId = null;
    }
  }

  /**
   * Command: /help
   */
  async cmdHelp(userOpenid, msgId) {
    const caps = await this.serviceCapabilities();
    const lines = [
      '🤖 **【DeepSeek Harness QQ 机器人使用指南】**',
      '',
      '**常用快捷指令:**',
      '- `/sessions [页码]` 或 `/会话列表`: 分页查看所有会话（每页按键带专属 emoji 标识）',
      '- `/new`: 进入交互式新建会话向导（选择本地/远程工作区或浏览目录）',
      '- `/switch <序号|emoji|ID>`: 切换当前活跃会话',
      '- `/current` 或 `/当前会话`: 查看当前活跃会话详情',
      '- `/model [名称]`: 查看或切换 AI 模型（支持指定供应商或序号）',
      '- `/effort [等级]` 或 `/思考`: 查看或切换思考等级 (off, low, medium, high, xhigh, max)',
      '- `/stats` 或 `/统计`: 查看会话性能、耗时与 Token 统计（对齐 WebUI 底栏）',
      '- `/status` 或 `/状态`: 图片查看主代理、团队成员/子代理状态与正在进行的后台任务',
      '- `/tasks` 或 `/任务管理`: 图片查看定时/自动化任务列表',
      ...(caps.terminal ? ['- `/jobs` 或 `/后台任务`: 图片查看正在进行的后台任务（持久终端）'] : []),
      ...(caps.usage
        ? ['- `/usage [日|月|年|累计]` 或 `/用量`: 查看指定范围的用量、费用、缓存/Token 指标与 30 天热力图（需已安装 dsh-token-metrics 或用量计费插件）']
        : []),
      '- `/preset [名称]`: 查看或切换 Agent 预设',
      '- `/permission [只读|工作区|全系统]`: 切换权限模式',
      '- `/skills` 或 `/技能`: 技能管理（列表、详情、启停）',
      '- `/mcp` 或 `/服务`: MCP 服务管理（列表、详情、启停/重启）',
      '- `/render [文本]` 或 `/渲染`: 把文本/Markdown 渲染成图片并发回 QQ',
      '- `/send <路径>` 或 `/发送文件`: 把本地文件发送到 QQ',
      '- `/answer <ID> <选项>`: 回答 Agent 提问（多选可回复 `A,B`，或直接点操作板）',
      '- `/cancel` 或 `/stop`: 中止当前 Agent 执行',
      '- `/subscribe [会话] [分钟]` 或 `/订阅`: 订阅**非活跃**会话，后台新消息按间隔汇聚推送（1/5/15/30/60 分钟）',
      '- `/subscriptions` 或 `/订阅列表`: 查看已订阅会话、汇聚间隔与待推送条数',
      '- `/unsubscribe [会话]` 或 `/取消订阅`: 取消订阅',
      '- `/reply <会话> [内容]` 或 `/回复`: 定向快速回复（无需切换当前会话；也可直接引用订阅通知消息回复）',
      '- `/menu`: 重新注册底部快捷菜单',
      '',
      '💬 **直接输入文字即可与 DSH Agent 进行多轮对话**，也可直接发送图片/文件给 Agent（自动保存到 `uploads/` 并以真实格式识别）。所有对话及执行操作与 Web UI 实时双向同步！',
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
async handleUserPrompt(userOpenid, content, attachments = [], msgId, replyToMsgId = '', delivery = null) {
    // A pending quick-reply target (from a subscription notice) redirects this
    // message to that session without switching the user's active session.
    const target = await this.resolvePromptTarget(userOpenid, replyToMsgId);
    let activeId = target.sessionId;
    if (!activeId) {
      // Auto-create initial session if none exists
      const created = await this.sessionManager.createSession();
      activeId = created.sessionId;
    }
    // One-shot: a directed reply consumes the target so the next message goes
    // back to the normal active-session behaviour.
    if (target.mode !== 'active') this.userReplyTarget.delete(userOpenid);

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

    let sessionCwd = process.cwd();
    try {
      const info = await this.sessionManager.getSessionInfoById(activeId);
      sessionCwd = info?.cwd || process.cwd();
    } catch {
      sessionCwd = process.cwd();
    }

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
        const filename = sanitizeFilename(att.filename || `file_${Date.now()}_${i}`);

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

        // Detect the REAL media type from the downloaded bytes. QQ frequently
        // declares image/png for JPEG bytes, which DSH rejects with
        // "Declared image type does not match its bytes."
        const inferred = inferAttachmentMediaType({ contentType, filename, bytes: buffer || Buffer.alloc(0) });
        const supportedImage = Boolean(buffer) && IMAGE_MEDIA_TYPES.includes(inferred.mediaType);

        // Save local copy to workspace uploads/
        let savedPath = '';
        let savedRel = '';
        if (buffer) {
          try {
            if (!uploadDirReady) {
              await mkdir(uploadDir, { recursive: true });
              uploadDirReady = true;
            }
            savedPath = await this.writeUniqueFile(uploadDir, filename, buffer);
            savedRel = `uploads/${basename(savedPath)}`;
            this.logger.info?.(`[MessageBridge] Saved inbound QQ attachment to: ${savedPath}`);
          } catch (err) {
            this.logger.warn?.(`[MessageBridge] Failed to write attachment file ${savedPath}: ${err.message}`);
          }
        }

        if (inferred.isImage) {
          if (supportedImage) {
            promptContent.push({
              type: 'image',
              data: buffer.toString('base64'),
              mediaType: inferred.mediaType,
              name: basename(savedPath) || filename,
            });
            textAnnotations.push(
              `[用户从 QQ 发送了图片: ${filename} (真实格式 ${inferred.mediaType}${savedRel ? `，已保存至 ${savedRel}` : ''})]`
            );
          } else if (buffer) {
            // BMP/AVIF/TIFF etc. are not accepted by DSH image admission.
            textAnnotations.push(
              `📎 [用户从 QQ 发送了图片 ${filename}（格式 ${inferred.mediaType || contentType || '未知'} 不在 DSH 支持的 png/jpeg/webp/gif 列表内，未作为图片附加${savedRel ? `，已保存至工作区 \`${savedRel}\`` : ''}）]`
            );
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
              textAnnotations.push(
                `[用户从 QQ 发送了文件: ${filename} (${sizeKb} KB${savedRel ? `, 已保存至 ${savedRel}` : ''})]\n\`\`\`\n${textContent}\n\`\`\``
              );
            } else {
              textAnnotations.push(
                `📎 [用户从 QQ 发送了文件: ${filename} (${sizeKb} KB${savedRel ? `, 已保存至工作区 \`${savedRel}\`` : ''})]`
              );
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
    // DSH 0.2.1-rc.3 SessionPromptRequest.mode is 'queue' | 'steer' ('followup' was removed)
const running = liveAgent?.status === 'running';
    // Mirrors the harness's own composer rule: steering only exists inside a
    // running turn, so an idle session always takes the documented `queue` path
    // (which simply starts the next turn). While running, an explicit choice
    // wins; otherwise the configured default.
    const mode = running ? (delivery ?? this.getConfig().busyDelivery ?? 'steer') : 'queue';

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

    await this.sendDeliveryReceipt(userOpenid, activeId, rpcId, { mode, running, requested: delivery, msgId });
  }

  /**
   * Report turns that were still running when a previous host process died
   * (Issue #8, second layer).
   *
   * Opt-in (`notifyRestartRecovery`, default off): the ledger is always written,
   * so switching it on later can still surface a turn that is in flight right now,
   * but nobody gets a startup message until they ask for one.
   *
   * Called once the gateway is READY — a notice sent before the bot can actually
   * deliver would simply be lost.
   * @returns {Promise<number>} How many sessions were announced
   */
  async checkRestartRecovery() {
    const ledger = this.turnLedger;
    if (!ledger) return 0;
    if (this.getConfig().notifyRestartRecovery !== true) {
      this.logger.debug?.('[MessageBridge] restart recovery is disabled by config');
      return 0;
    }

    const pending = ledger.pendingRecoveries();
    if (pending.length === 0) return 0;

    let sent = 0;
    for (const entry of pending) {
      // Always consume: a notice that cannot be delivered must not be retried on
      // every later boot until it ages out.
      ledger.consume(entry.sessionId);
      if (!entry.userOpenid) continue;

      let sessionTitle = '';
      try {
        const info = await this.describeSession(entry.sessionId);
        sessionTitle = info?.title || '';
      } catch {
        // A missing title must never suppress the notice.
      }

      try {
        await this.apiClient.sendC2CMessage(entry.userOpenid, {
          markdown: formatRestartNotice({ sessionTitle, entry, now: Date.now() }),
          keyboard: KeyboardBuilder.buildTurnEndBoard(),
        });
        sent += 1;
      } catch (err) {
        this.logger.warn?.(`[MessageBridge] Failed to send restart notice: ${err.message}`);
      }
    }

    this.logger.info?.(`[MessageBridge] Restart recovery: announced ${sent}/${pending.length} interrupted turn(s)`);
    return sent;
  }

  /**
   * Tell the QQ user how their message was actually delivered — but only when the
   * delivery is worth a message.
   *
   * The Web UI renders delivery as a queue row, which QQ has no surface for, so a
   * queued message (and the steer/remove board that goes with it), a steer the
   * harness quietly downgraded, and an explicit steer with no running turn are all
   * reported. A plain message steered as configured, or one sent while idle, is
   * not: the user asked for exactly that, and a receipt would only add chatter.
   * @param {string} userOpenid - Target QQ user
   * @param {string} sessionId - Session the prompt went to
   * @param {string} requestId - requestId the prompt was admitted with
   * @param {{ mode: string, running: boolean, requested: string|null, msgId?: string }} delivery
   * @returns {Promise<void>}
   */
  async sendDeliveryReceipt(userOpenid, sessionId, requestId, { mode, running, requested, msgId }) {
    try {
      const { nextTurn, nextStep } = this.sessionManager.getInbox(sessionId);
      const queuedIndex = nextTurn.findIndex((message) => message?.source?.rpcId === requestId);
      const steered = nextStep.some((message) => message?.source?.rpcId === requestId);

      let text;
      if (!running) {
        if (requested !== 'steer') return;
        text = 'ℹ️ 当前没有运行中的轮次，已作为普通消息发送。';
      } else if (mode === 'queue') {
        text = `📥 已排队${queuedIndex >= 0 ? `（第 ${queuedIndex + 1} 条）` : ''}：本轮结束后发送。`;
      } else if (!steered) {
        text = 'ℹ️ 本轮刚好结束，已转为排队（下一轮开始时发送）。';
      } else {
        return;
      }

      await this.apiClient.sendC2CMessage(userOpenid, {
        markdown: text,
        ...(queuedIndex >= 0 && nextTurn.length > 0
          ? { keyboard: KeyboardBuilder.buildQueueListBoard(nextTurn.map((m) => ({ itemId: m.id }))) }
          : {}),
        msg_id: msgId,
      });
    } catch (err) {
      // A receipt must never break the prompt that already went through.
      this.logger.debug?.(`[MessageBridge] delivery receipt skipped: ${err?.message ?? err}`);
    }
  }

  /**
   * One card line for a session's last known message.
   *
   * The label follows the source, because they are not the same thing: the live
   * stream yields the true last message (a mid-turn steer included), while the
   * `turnOutline` fallback only carries each turn's opening prompt.
   * @param {{ text: string, exact: boolean }|null} lastMessage - Resolved message
   * @returns {string[]} Zero or one card lines
   */
  describeLastMessage(lastMessage) {
    if (!lastMessage?.text) return [];
    const label = lastMessage.exact ? '最后一条用户消息' : '最近一轮提问';
    return [`> **${label}**: ${lastMessage.text}`];
  }

  /**
   * Handle DSH internal session events
   * @param {Object} session - DSH Session object
   * @param {Object} event - DSH SessionEvent
   */
  async handleDshSessionEvent(session, event) {
    // Remember every user message BEFORE the active-session filter below: a
    // mid-turn steer is a user message too, and it is what the session cards
    // should show as the last thing the user said.
    if (event?.type === 'user/message' && event.data?.source?.kind === 'user') {
      this.sessionManager.rememberUserMessage?.(session.id, event.data.content);
    }

    const activeId = await this.sessionManager.getActiveSessionId();

    // Background subscription capture runs BEFORE the active-session filter:
    // a subscribed session is by definition not the active one, so filtering
    // first would make it unreachable.
    if (session.id !== activeId) {
      this.captureSubscribedEvent(session, event);
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
        await this.onDshToolCall(userOpenid, event, session.id);
        break;

      case 'turn/start':
        this.onDshTurnStart(session.id, event);
        break;

      case 'turn/end':
        await this.onDshTurnEnd(userOpenid, session.id, event);
        break;

      default:
        break;
    }
  }

  /**
   * Buffer one event from a *subscribed but non-active* session.
   *
   * Only assistant output and blocking questions are worth a push: tool calls
   * and turn boundaries fire constantly, and forwarding them would defeat the
   * whole point of coalescing. Questions are captured immediately because the
   * turn is blocked waiting for an answer.
   *
   * @param {Object} session
   * @param {Object} event
   */
  captureSubscribedEvent(session, event) {
    const store = this.subscriptionStore;
    if (!store || !store.has(session.id)) return;

    const now = Date.now();
    let entry = null;

    if (event.type === 'assistant/message') {
      const message = event.data?.message || event.data;
      const text = (message?.content || [])
        .filter((part) => part.type === 'text')
        .map((part) => part.text)
        .join('\n')
        .replace(/<think>[\s\S]*?<\/think>/g, '')
        .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
        .trim();
      if (text) entry = { text, at: now, kind: 'assistant' };
    } else if (event.type === 'user/question' || event.type === 'approval/asked') {
      const text = String(event.data?.question || event.data?.prompt || '').trim();
      if (text) entry = { text, at: now, kind: 'question' };
    }

    if (!entry) return;

    const state = store.enqueue(session.id, entry);
    if (!state.queued) return;
    this.subscriptionScheduler?.arm();
    this.logger.info?.(
      `[MessageBridge] 订阅会话 ${session.id.slice(0, 8)} 新增 ${state.count} 条待汇聚（${Math.round(
        state.intervalMs / 60000
      )} 分钟窗口）`
    );
  }

  /**
   * Deliver one coalesced digest to QQ, with quick-reply buttons.
   * @param {string} sessionId
   * @param {Object} digest
   */
  /**
   * @returns {Promise<boolean>} true when the digest actually reached QQ. A false
   *   result leaves the buffer intact so the message is not lost.
   */
  async flushSubscriptionDigest(sessionId, digest) {
    const config = this.getConfig();
    const userOpenid = config.userOpenid;
    if (!userOpenid) {
      // No bound user: report failure instead of silently swallowing the digest,
      // otherwise the caller commits (drops) messages that were never sent.
      this.logger.warn?.('[MessageBridge] 订阅通知未发送：尚未绑定 userOpenid');
      return false;
    }
    // Only refuse when the client explicitly reports "not configured". The
    // gateway flag is not reliable here (absent on transport doubles, and it can
    // lag behind a working connection); a send that throws is handled by the
    // caller, which keeps the buffer and applies backoff.
    if (typeof this.apiClient?.isConfigured === 'function' && this.apiClient.isConfigured() === false) {
      this.logger.warn?.('[MessageBridge] 订阅通知未发送：QQ 客户端未配置');
      return false;
    }

    const label = digest.subscription?.title || `会话 ${sessionId.slice(0, 8)}`;
    const keyboard = KeyboardBuilder.keyboard([
      [
        KeyboardBuilder.button({ id: 'sub_view', label: '查看', data: `/switch ${sessionId}`, style: 1 }),
        KeyboardBuilder.button({ id: 'sub_reply', label: '快速回复', data: `/reply ${sessionId}`, style: 1 }),
      ],
      [
        KeyboardBuilder.button({ id: 'sub_off', label: '取消订阅', data: `/unsubscribe ${sessionId}`, style: 1 }),
        KeyboardBuilder.button({ id: 'sub_list', label: '订阅列表', data: '/subscriptions', style: 1 }),
      ],
    ]);

    // Delivery form. QQ truncates a markdown message beyond ~4000 chars, so an
    // over-long digest is rendered to a picture instead of being cut off.
    //   text  (default) plain markdown, switching to an image only when too long
    //   auto            image only when too long
    //   image           always an image
    const { useImage, reason } = shouldSendDigestAsImage({
      mode: config.subscriptionSendMode,
      length: digest.markdown.length,
    });

    if (useImage) {
      // The compact text digest folds to ~5 previews, so rendering THAT as an
      // image would waste the extra room. Rebuild the digest in full mode: the
      // image has no character budget, so it can carry every buffered message and
      // their whole text.
      const fullDigest = digest.subscription && Array.isArray(digest.messages)
        ? buildSubscriptionDigest({
            title: digest.subscription.title,
            sessionId: digest.subscription.sessionId,
            messages: digest.messages,
            intervalMinutes: digest.subscription.intervalMinutes,
            now: Date.now(),
            full: true,
          })
        : digest;
      const delivered = await this.sendSubscriptionDigestAsImage(userOpenid, {
        sessionId,
        digest: { ...digest, ...fullDigest },
        label,
        keyboard,
        reason,
      });
      if (delivered) return true;
      // Rendering can fail (no Typst/browser/assets); fall back to text rather
      // than dropping the notification, trimming only as a last resort.
      this.logger.warn?.('[MessageBridge] 订阅通知图片渲染失败，回退为文字发送');
    }

    const result = await this.apiClient.sendC2CMessage(userOpenid, {
      markdown:
        digest.markdown.length > QQ_MESSAGE_SOFT_LIMIT
          ? `${digest.markdown.slice(0, QQ_MESSAGE_SOFT_LIMIT)}\n\n> ⚠️ 内容过长，后 ${digest.count} 条中的部分已截断；可在 Web UI 查看完整内容。`
          : digest.markdown,
      keyboard,
    });

    // Remember which QQ message belongs to which session, so replying to it
    // (QQ's own "reply" gesture) can target that session directly.
    const messageId = result?.data?.id || result?.id || '';
    if (messageId) {
      this.subscriptionNoticeByMsgId.set(messageId, {
        sessionId,
        title: label,
        at: Date.now(),
      });
      // Bound the map: only the most recent 200 notices are worth matching.
      if (this.subscriptionNoticeByMsgId.size > 200) {
        const oldest = [...this.subscriptionNoticeByMsgId.entries()]
          .sort((a, b) => a[1].at - b[1].at)
          .slice(0, this.subscriptionNoticeByMsgId.size - 200);
        for (const [key] of oldest) this.subscriptionNoticeByMsgId.delete(key);
      }
    }
    this.logger.info?.(`[MessageBridge] 订阅汇聚通知已推送：${label}（${digest.count} 条）`);
    return true;
  }

  /**
   * Trim a digest body so the rendered image stays within a sane height.
   *
   * The renderer emits a PNG whose height is unbounded (`#set page(height: auto)`);
   * a large batch produced 1800x12685, which QQ scales down into unreadable
   * text. The budget below keeps the long side under ~9000 raster px at the
   * default 2x export, i.e. ~4500 CSS px.
   *
   * @param {string} markdown
   * @param {{count:number, width:number, maxHeight?:number}} options
   * @returns {{text:string, notice:string}}
   */
  fitDigestForImage(markdown, { count, width, maxHeight = 4400 } = {}) {
    const source = String(markdown ?? '');
    if (!source) return { text: '', notice: '' };
    // Cheap estimate: ~24px per line at the default font, ~2.1 chars per 24px of
    // width for mixed CJK/latin. Deliberately conservative (over-estimates height).
    const charsPerLine = Math.max(20, Math.round(Number(width) * 0.052));
    const lines = source.split('\n').reduce((sum, line) => {
      const len = Math.max(1, line.length);
      return sum + Math.max(1, Math.ceil(len / charsPerLine));
    }, 0);
    const estimatedHeight = lines * 24 + 180;
    if (estimatedHeight <= maxHeight) return { text: source, notice: '' };

    const keepRatio = Math.max(0.2, (maxHeight - 180) / (estimatedHeight - 180));
    const keepChars = Math.max(400, Math.floor(source.length * keepRatio));
    // Cut on a line boundary so the last visible entry is not a half sentence.
    let cut = source.lastIndexOf('\n', keepChars);
    if (cut < keepChars * 0.6) cut = keepChars;
    return {
      text: source.slice(0, cut).trimEnd(),
      notice: `（图片高度受限，已截断；完整 ${count} 条请在 Web UI 查看）`,
    };
  }

  /**
   * Render a subscription digest to an image and send it.
   *
   * Used when the digest exceeds the single-message budget (or when the user
   * configured `image` mode). Returns false when rendering or sending failed, so
   * the caller can fall back to text instead of losing the notification.
   *
   * @param {string} userOpenid
   * @param {Object} options
   * @param {string} options.sessionId
   * @param {Object} options.digest
   * @param {string} options.label
   * @param {Object} [options.keyboard]
   * @param {'always'|'too-long'} [options.reason]
   * @returns {Promise<boolean>}
   */
  async sendSubscriptionDigestAsImage(userOpenid, { sessionId, digest, label, keyboard, reason = 'too-long' }) {
    const cfg = this.getConfig();
    try {
      // A 30-message digest renders to ~12700px tall, which QQ (and image viewers)
      // handle poorly. Measure first, then trim the body with an explicit note so
      // the reader knows content was shortened and where to see the rest.
      const renderWidth = Number(cfg.renderWidth) || 900;
      const { text: fittedText, notice } = this.fitDigestForImage(digest.markdown, {
        count: digest.count,
        width: renderWidth,
      });
      const rendered = await renderTextImage({
        text: fittedText,
        title: `🔔 ${label}`,
        subtitle:
          reason === 'too-long'
            ? `内容较长，已渲染为图片（${digest.count} 条 · 原文约 ${digest.markdown.length} 字）${notice}`
            : `${digest.count} 条新消息${notice}`,
        theme: cfg.renderTheme || 'light',
        width: renderWidth,
        logger: this.logger,
      });
      const ext = rendered.mediaType === 'image/png' ? 'png' : 'svg';
      const data = await readFile(rendered.path);
      const sendResult = await this.sendLocalMedia(userOpenid, {
        data,
        filename: `subscription-${Date.now()}.${ext}`,
        mediaType: rendered.mediaType,
      });
      if (!sendResult.ok) {
        this.logger.warn?.(`[MessageBridge] 订阅通知图片发送失败：${sendResult.error}`);
        return false;
      }

      // The image is the notification; the action keyboard still has to be
      // delivered as a separate (short) message because QQ keyboards attach to
      // text messages, not to media.
      if (keyboard) {
        try {
          await this.apiClient.sendC2CMessage(userOpenid, {
            markdown: `🔔 **${label}** · ${digest.count} 条新消息（已发送图片）`,
            keyboard,
          });
        } catch (error) {
          this.logger.warn?.(`[MessageBridge] 订阅通知按钮发送失败：${error.message}`);
        }
      }

      const messageId = sendResult.messageId || '';
      if (messageId) {
        this.subscriptionNoticeByMsgId.set(messageId, { sessionId, title: label, at: Date.now() });
        if (this.subscriptionNoticeByMsgId.size > 200) {
          const oldest = [...this.subscriptionNoticeByMsgId.entries()]
            .sort((a, b) => a[1].at - b[1].at)
            .slice(0, this.subscriptionNoticeByMsgId.size - 200);
          for (const [key] of oldest) this.subscriptionNoticeByMsgId.delete(key);
        }
      }
      this.logger.info?.(
        `[MessageBridge] 订阅汇聚通知已推送（图片，${reason}）：${label}（${digest.count} 条，${rendered.engine}，${rendered.width}×${rendered.height}）`
      );
      return true;
    } catch (error) {
      this.logger.warn?.(`[MessageBridge] 订阅通知图片渲染异常：${error.message}`);
      return false;
    }
  }

  /**
   * Resolve which session a follow-up message should go to.
   *
   * Priority: explicit /reply target (still valid) > the message the user
   * replied to on QQ > the active session.
   *
   * @param {string} userOpenid
   * @param {string} [replyToMsgId] QQ message id the user replied to, if any
   * @returns {{sessionId:string, title:string, mode:'target'|'reply'|'active'}}
   */
  async resolvePromptTarget(userOpenid, replyToMsgId = '') {
    const target = this.userReplyTarget.get(userOpenid);
    if (target && target.expiresAt > Date.now()) {
      return { sessionId: target.sessionId, title: target.title, mode: 'target' };
    }
    if (target) this.userReplyTarget.delete(userOpenid);

    const notice = replyToMsgId ? this.subscriptionNoticeByMsgId.get(replyToMsgId) : null;
    if (notice) {
      return { sessionId: notice.sessionId, title: notice.title, mode: 'reply' };
    }

    const activeId = await this.sessionManager.getActiveSessionId();
    return { sessionId: activeId, title: '', mode: 'active' };
  }

  /** Arm (or clear) the one-shot quick-reply target for a user. */
  setReplyTarget(userOpenid, sessionId, title, ttlMs = 30 * 60 * 1000) {
    if (!sessionId) {
      this.userReplyTarget.delete(userOpenid);
      return;
    }
    this.userReplyTarget.set(userOpenid, {
      sessionId,
      title: String(title || ''),
      expiresAt: Date.now() + ttlMs,
    });
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

    // Optional incremental delivery: push only the new text since the last
    // flush, throttled so QQ never receives a flood of tiny messages.
    const cfg = this.getConfig();
    if (cfg.streamReply !== true) return;

    const interval = Math.max(500, Number(cfg.streamIntervalMs) || 1500);
    const state = this.streamState.get(sessionId) || { sent: 0, timer: null, sending: false };
    this.streamState.set(sessionId, state);
    if (state.timer || state.sending) return;

    state.timer = setTimeout(() => {
      state.timer = null;
      void this.flushStreamChunk(userOpenid, sessionId);
    }, interval);
    if (typeof state.timer.unref === 'function') state.timer.unref();
  }

  /**
   * Push the unsent tail of the current streaming buffer to QQ.
   * @param {string} userOpenid
   * @param {string} sessionId
   */
  async flushStreamChunk(userOpenid, sessionId) {
    const state = this.streamState.get(sessionId);
    if (!state || state.sending) return;
    const buf = this.assistantBuffers.get(sessionId) || '';
    const pending = buf.slice(state.sent);
    const text = this.stripStreamNoise(pending).trim();
    if (!text) return;

    state.sending = true;
    try {
      const isPassive = this.lastMsgId && Date.now() - this.lastMsgTime < 240000;
      await this.apiClient.sendC2CMessage(userOpenid, {
        markdown: text.length > 3800 ? `${text.slice(0, 3800)}…` : text,
        ...(isPassive ? { msg_id: this.lastMsgId } : {}),
      });
      state.sent = buf.length;
    } catch (err) {
      this.logger.warn?.(`[MessageBridge] Stream flush failed: ${err.message}`);
    } finally {
      state.sending = false;
    }
  }

  /**
   * Remove internal tags / runtime context from a streamed fragment.
   * @param {string} text
   * @returns {string}
   */
  stripStreamNoise(text) {
    return String(text ?? '')
      .replace(/[\s\S]*?<\/think>/g, '')
      .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
      .replace(/Current runtime context[\s\S]*?\n\n/g, '')
      .trim();
  }

  /**
   * Complete assistant message finished -> Push reply to QQ
   */
  async onDshAssistantMessage(userOpenid, sessionId, event) {
    if (this.streamTimers.has(sessionId)) {
      clearTimeout(this.streamTimers.get(sessionId));
      this.streamTimers.delete(sessionId);
    }
    // Cancel a pending incremental flush and remember how much was already sent.
    const streamState = this.streamState.get(sessionId);
    if (streamState?.timer) {
      clearTimeout(streamState.timer);
      streamState.timer = null;
    }
    const streamedChars = streamState?.sent || 0;
    this.streamState.delete(sessionId);
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
    const mediaBlocks = (message?.content || []).filter((c) => c.type === 'image' || c.type === 'file');

    // Clean internal tags if any
    fullText = fullText
      .replace(/<think>[\s\S]*?<\/think>/g, '')
      .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
      .trim();

    if (fullText) {
      this.lastAssistantText.set(sessionId, fullText);
    }

    if (fullText || mediaBlocks.length > 0) {
      const turn = this.turnState.get(sessionId);
      if (turn) turn.sawOutput = true;
    }

    if (!fullText && mediaBlocks.length === 0) return;

    if (fullText) {
      // In streamReply mode the visible prefix was already delivered, so only
      // the remainder is sent (never duplicate what the user just read).
      const remainder =
        streamedChars > 0
          ? fullText.slice(Math.min(streamedChars, fullText.length)).replace(/^\s+/, '')
          : fullText;

      if (!remainder && mediaBlocks.length === 0) {
        this.logger.info?.('[MessageBridge] Assistant text fully delivered by streaming; nothing left to send.');
        return;
      }

      if (remainder) {
        this.logger.info?.(
          `[MessageBridge] Pushing assistant response to QQ (${remainder.length} chars${
            streamedChars > 0 ? `, ${streamedChars} already streamed` : ''
          })`
        );

        // Chunk if text exceeds 3800 characters (QQ single message safety margin)
        const CHUNK_SIZE = 3800;
        for (let i = 0; i < remainder.length; i += CHUNK_SIZE) {
          const slice = remainder.slice(i, i + CHUNK_SIZE);
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
    }

    // Forward assistant-produced images / files to QQ (rich media, msg_type=7)
    if (mediaBlocks.length > 0 && this.getConfig().autoSendAttachments !== false) {
      await this.forwardMessageAttachments(userOpenid, mediaBlocks);
    }
  }

  /**
   * Forward durable image / file blocks from an assistant message to QQ.
   * @param {string} userOpenid
   * @param {Array<Object>} mediaBlocks - content blocks with `attachment` refs
   */
  async forwardMessageAttachments(userOpenid, mediaBlocks) {
    const attachments = this.ctx.get ? this.ctx.get('attachments') : this.ctx.attachments;
    if (!attachments) return;

    for (const block of mediaBlocks) {
      const ref = block.attachment;
      if (!ref) continue;
      try {
        if (block.type === 'image' && typeof attachments.readImage === 'function') {
          const stored = await attachments.readImage(ref);
          const ext = (stored.ref?.mediaType || 'image/png').split('/')[1] || 'png';
          const filename = sanitizeFilename(stored.ref?.name || `assistant-image.${ext}`, `assistant-image.${ext}`);
          await this.apiClient.sendImage?.(userOpenid, {
            data: Buffer.from(stored.data),
            filename,
          });
        } else if (block.type === 'file' && typeof this.apiClient.sendFile === 'function') {
          const hostPath = typeof attachments.fileHostPath === 'function' ? attachments.fileHostPath(ref) : undefined;
          let data = null;
          if (hostPath) {
            data = await readFile(hostPath);
          } else if (typeof attachments.readFileStream === 'function') {
            const chunks = [];
            let total = 0;
            for await (const chunk of attachments.readFileStream(ref)) {
              const buf = Buffer.from(chunk);
              total += buf.length;
              if (total > 100 * 1024 * 1024) throw new Error('file exceeds 100MB forwarding limit');
              chunks.push(buf);
            }
            data = Buffer.concat(chunks);
          }
          if (data) {
            await this.apiClient.sendFile(userOpenid, {
              data,
              filename: sanitizeFilename(ref.name || 'assistant-file.bin', 'assistant-file.bin'),
            });
          }
        }
      } catch (err) {
        this.logger.warn?.(`[MessageBridge] Failed to forward ${block.type} attachment to QQ: ${err.message}`);
      }
    }
  }

  /**
   * Real-time Tool invocation notification -> Optional progress aggregation to QQ
   */
  async onDshToolCall(userOpenid, event, sessionId = '') {
    const toolName = event.data?.name || event.data?.toolName || '工具';
    this.logger.debug?.(`[MessageBridge] Tool called: ${toolName}`);

    // Remember the last tool BEFORE the syncToolCalls gate below: when a turn
    // dies mid-tool the notice should name what it was doing even for users who
    // keep tool-call syncing switched off.
    this.noteTurnTool(sessionId, event, toolName);

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
  /**
   * A turn started: reset the per-turn bookkeeping used by the abnormal
   * turn-end notice (which tool it is in, whether anything reached the user).
   * @param {string} sessionId
   * @param {Object} [event]
   */
  onDshTurnStart(sessionId, event) {
    this.turnState.set(sessionId, {
      turn: event?.data?.turn,
      lastTool: null,
      lastToolAt: 0,
      startedAt: Date.now(),
      sawOutput: false,
    });
    // A new turn means a previous /cancel is history.
    this.qqCancelledSessions.delete(sessionId);

    // Persist the fact that a turn is running: if this process dies before the
    // turn ends, the next boot has nothing else to go on.
    this.turnLedger?.record(sessionId, {
      userOpenid: this.getConfig().userOpenid ?? '',
      turn: event?.data?.turn ?? null,
      tool: null,
    });
  }

  /**
   * Remember the tool the current turn is inside.
   * Called from onDshToolCall BEFORE its syncToolCalls gate.
   * @param {string} sessionId
   * @param {Object} event
   * @param {string} toolName
   */
  noteTurnTool(sessionId, event, toolName) {
    if (!sessionId) return;
    const state = this.turnState.get(sessionId) || {
      turn: event?.data?.turn,
      lastTool: null,
      lastToolAt: 0,
      startedAt: Date.now(),
      sawOutput: false,
    };
    state.lastTool = String(toolName || '').slice(0, 80) || null;
    state.lastToolAt = Date.now();
    this.turnState.set(sessionId, state);
    this.turnLedger?.record(sessionId, {
      userOpenid: this.getConfig().userOpenid ?? '',
      turn: event?.data?.turn ?? null,
      tool: state.lastTool,
    });
  }

  /**
   * A turn ended.
   *
   * Always clears the assistant buffer. Additionally, when the turn did NOT end
   * normally (error / max-tokens / blocked / interrupted / aborted), it pushes a
   * status notice to QQ: otherwise a phone user watches the typing indicator stop
   * and learns nothing, unable to tell "still working" from "died an hour ago".
   *
   * @param {string} userOpenid
   * @param {string} sessionId
   * @param {Object} [event] carries `reason`: { turn, reason: { kind, ... } }
   */
  async onDshTurnEnd(userOpenid, sessionId, event) {
    this.assistantBuffers.delete(sessionId);

    const turn = this.turnState.get(sessionId) || {};
    this.turnState.delete(sessionId);
    // The turn is over (whatever the reason): its recovery record is stale. While
    // shutting down the ledger skips this, so the next boot can still report it.
    this.turnLedger?.clear(sessionId);

    const qqCancelled = this.qqCancelledSessions.delete(sessionId);
    const reason = event?.data?.reason ?? {};
    const decision = describeTurnEnd({ reason, qqCancelled });

    if (!decision.notify) {
      this.logger.debug?.(
        `[MessageBridge] turn/end ${sessionId}: kind=${decision.kind || '(none)'} -> no notice (${decision.why})`
      );
      return;
    }

    if (this.getConfig().notifyTurnAbnormal === false) {
      this.logger.info?.(
        `[MessageBridge] turn/end ${sessionId}: kind=${decision.kind} -> notice disabled by config`
      );
      return;
    }

    let sessionTitle = '';
    try {
      const info = await this.describeSession(sessionId);
      sessionTitle = info?.title || '';
    } catch {
      // A missing title must never suppress the notice.
    }

    const markdown = formatTurnEndNotice({ reason, sessionTitle, turn, now: Date.now() });
    try {
      await this.apiClient.sendC2CMessage(userOpenid, {
        markdown,
        keyboard: KeyboardBuilder.buildTurnEndBoard(),
        ...(this.lastMsgId && Date.now() - this.lastMsgTime < 240000 ? { msg_id: this.lastMsgId } : {}),
      });
      this.logger.info?.(
        `[MessageBridge] Notified QQ of abnormal turn end ${sessionId}: kind=${decision.kind}`
      );
    } catch (err) {
      this.logger.error?.(`[MessageBridge] Failed to send turn-end notice: ${err.message}`);
    }
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
    for (const state of this.streamState.values()) {
      if (state?.timer) clearTimeout(state.timer);
    }
    this.streamState.clear();
    this.recentRpcIds.clear();
    this.userNewSessionState.clear();
    this.userModelPageState.clear();
    this.userSessionPageState.clear();
    this.userSkillsPageState.clear();
    this.userMcpPageState.clear();
    this.lastAssistantText.clear();

    // Subscription runtime state. The persisted store survives (a restart must
    // keep the user's subscriptions) and so does the scheduler instance: start()
    // calls stop() on every (re)start, so nulling the scheduler here would leave
    // the bridge with a dead reference and arm() would become a no-op — that is
    // exactly why scheduled pushes never fired while "N 条待推送" still counted.
    // Only the pending timers and one-shot targets are cleared here; index.js
    // owns the scheduler's real lifetime and disposes it with the plugin.
    this.userReplyTarget.clear();
    this.subscriptionNoticeByMsgId.clear();
  }
}
