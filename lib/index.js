import { Config, DEFAULT_CONFIG, SETTINGS_NAMESPACE, unwrapVolatileConfig } from './config.js';
import { QQApiClient } from './qq/client.js';
import { QQGatewayClient } from './qq/gateway.js';
import { SessionManager } from './sync/session-manager.js';
import { ApprovalHandler } from './sync/approval-handler.js';
import { MessageBridge } from './sync/message-bridge.js';
import { AdminInventory } from './sync/inventory.js';
import { hasTerminalPlugin } from './sync/task-overview.js';
import { renderTextImage } from './render/index.js';
import { createRenderTextImageTool } from './tools/qq-render-text-image.js';
import { createSendFileTool } from './tools/qq-send-file.js';
import { BindTaskStore, createOnboardRoute } from './qq/onboard.js';

export const name = 'adapter-qq';

// Declare primary injected services
export const inject = [
  'sessionController',
  'sessions',
  'settings',
  'sessionProjections',
  'agentDefaultModel',
  'agents',
  'agentPresets',
  'permissionPresets',
  'workspaceRegistry',
  'attachments',
  'tools',
];

export { Config, SETTINGS_NAMESPACE };

/**
 * Main Cordis plugin apply function.
 *
 * Named `apply` (object plugin shape) so the DSH 0.2.1 Loader can read the
 * exported `Config` schema (`fiber.runtime.Config`) and project the plugin's
 * settings form; a default-export function does not carry that schema.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {Object} [config]
 */
export function apply(ctx, config = {}) {
  const logger = (typeof ctx.logger === 'function' ? ctx.logger('adapter-qq') : ctx.get('logger')?.('adapter-qq')) || console;
  logger.info?.('[adapter-qq] Initializing DeepSeek Harness QQ Bot Adapter...');

  // Volatile config fields arrive as live refs ({ get() }). Keep the raw refs
  // and read them on demand: the settings service writes into these refs when
  // the user saves the QQ settings tab, so no restart is needed.
  const rawConfig = config && typeof config === 'object' ? config : {};
  let pendingOverrides = {};

  const readLiveConfig = () => ({
    ...DEFAULT_CONFIG,
    ...unwrapVolatileConfig(rawConfig),
    ...pendingOverrides,
  });

  /** Drop overrides already reflected by the live refs (the write landed). */
  const pruneAppliedOverrides = () => {
    const live = unwrapVolatileConfig(rawConfig);
    for (const key of Object.keys(pendingOverrides)) {
      if (Object.prototype.hasOwnProperty.call(live, key) && Object.is(live[key], pendingOverrides[key])) {
        delete pendingOverrides[key];
      }
    }
  };

  // Helper getters/setters for dynamic configuration
  const getConfig = () => readLiveConfig();
  const updateConfig = (patch) => {
    pendingOverrides = { ...pendingOverrides, ...patch };
    // If settings service is available, persist the patch
    const settings = ctx.get('settings');
    if (settings && typeof settings.update === 'function') {
      void settings.update(SETTINGS_NAMESPACE, patch).catch((err) => {
        logger.warn?.(`[adapter-qq] Failed to persist settings update: ${err.message}`);
      });
    }
  };

  // 1. Initialize QQ API Client & WebSocket Gateway
  const initialConfig = getConfig();
  const apiClient = new QQApiClient({
    appId: initialConfig.appId,
    clientSecret: initialConfig.clientSecret,
    sandbox: initialConfig.sandbox,
    logger,
  });

  const gateway = new QQGatewayClient({
    apiClient,
    logger,
  });

  // 2. Initialize Session Manager
  const sessionManager = new SessionManager({
    ctx,
    getActiveSessionId: () => getConfig().activeSessionId,
    setActiveSessionId: (sid) => updateConfig({ activeSessionId: sid }),
    logger,
  });

  // 3. Initialize Approval Handler
  const approvalHandler = new ApprovalHandler({
    ctx,
    apiClient,
    sessionManager,
    getUserOpenid: () => getConfig().userOpenid,
    logger,
  });

  // 4. Initialize skills / MCP admin inventory (degrades gracefully when absent)
  const inventory = new AdminInventory({
    ctx,
    getConfig,
    logger,
  });

  // 5. Initialize Message Bridge
  const messageBridge = new MessageBridge({
    ctx,
    apiClient,
    gateway,
    sessionManager,
    approvalHandler,
    inventory,
    getConfig,
    updateConfig,
    logger,
  });

  // Sync / Connect helper function
  let lastConnectEnabled = false;
  const applyConfigAndConnect = (newConfig = {}) => {
    if (newConfig && typeof newConfig === 'object') {
      pendingOverrides = { ...pendingOverrides, ...unwrapVolatileConfig(newConfig) };
    }
    const next = getConfig();
    const prevAppId = apiClient.appId;
    const prevSecret = apiClient.clientSecret;
    const prevSandbox = apiClient.sandbox;
    const prevEnabled = lastConnectEnabled;

    apiClient.updateConfig({
      appId: next.appId,
      clientSecret: next.clientSecret,
      sandbox: next.sandbox,
    });
    lastConnectEnabled = next.enabled;

    const isConfigured = apiClient.isConfigured();
    logger.info?.(`[adapter-qq] Config state: enabled=${next.enabled}, configured=${isConfigured} (appId: ${next.appId ? next.appId : '<empty>'})`);

    if (next.enabled && isConfigured) {
      const credsChanged =
        next.appId !== prevAppId ||
        next.clientSecret !== prevSecret ||
        next.sandbox !== prevSandbox;

      if (!gateway.connected || credsChanged || !prevEnabled) {
        logger.info?.('[adapter-qq] Connecting to QQ Gateway with authoritative configuration...');
        gateway.connect();
      }
    } else {
      if (gateway.connected) {
        logger.info?.('[adapter-qq] Disconnecting QQ Bot (disabled or unconfigured)...');
        gateway.disconnect();
      }
    }
  };

  // 5. Settings are projected from the exported `Config` schema by the DSH
  //    0.2.1 Loader (`settings.describe` reads `fiber.runtime.Config`); no
  //    installSection call exists in 0.2.1. The client half registers the
  //    "QQ 机器人" tab under Settings -> Plugins and edits the `adapter-qq`
  //    namespace through `ctx.remote.settings`.
  //
  //    Settings edits reach the running instance through the profile reload
  //    path; keep the authoritative config in sync when the host asks.
  ctx.inject(['settings'], (settingsCtx) => {
    try {
      if (typeof settingsCtx.settings?.configure === 'function') {
        settingsCtx.settings.configure({ auto: false });
      }
    } catch (err) {
      logger.warn?.(`[adapter-qq] Failed to configure settings page policy: ${err.message}`);
    }
  });

  // Track live settings revisions so the gateway follows edits without a restart.
  try {
    const settingsService = ctx.get('settings');
    if (typeof settingsService?.describe === 'function') {
      const sync = () => {
        try {
          pruneAppliedOverrides();
          applyConfigAndConnect({});
          logger.info?.('[adapter-qq] Settings changed; synchronized from DSH settings document.');
        } catch (err) {
          logger.warn?.(`[adapter-qq] Failed to synchronize settings: ${err.message}`);
        }
      };
      ctx.on('settings/document-updated', (ns) => {
        if (ns === SETTINGS_NAMESPACE) sync();
      });
    }
  } catch (err) {
    logger.warn?.(`[adapter-qq] Settings watcher unavailable: ${err.message}`);
  }

  // Safety net: volatile refs are live, so a cheap fingerprint poll catches a
  // settings write even if the document-updated event is missed. This keeps
  // credential/enable changes hot-applied without a restart.
  let lastConfigFingerprint = JSON.stringify(getConfig());
  ctx.effect(() => {
    const timer = setInterval(() => {
      try {
        pruneAppliedOverrides();
        const fingerprint = JSON.stringify(getConfig());
        if (fingerprint !== lastConfigFingerprint) {
          lastConfigFingerprint = fingerprint;
          applyConfigAndConnect({});
          logger.info?.('[adapter-qq] Live config changed; re-applied connection settings.');
        }
      } catch (err) {
        logger.warn?.(`[adapter-qq] Live config check failed: ${err.message}`);
      }
    }, 2000);
    if (typeof timer.unref === 'function') timer.unref();
    return () => clearInterval(timer);
  }, 'dsh-adapter-qq: live config poll');

  // 6. Same-origin onboarding API used by the settings tab (扫码绑定).
  //    The browser cannot call q.qq.com directly (CORS) and must never see the
  //    AES key, so create/poll/decrypt all happen here.
  const bindTasks = new BindTaskStore();
  ctx.inject(['webServer'], (webCtx) => {
    try {
      const server = webCtx.get ? webCtx.get('webServer') : webCtx.webServer;
      if (!server || typeof server.register !== 'function') {
        logger.warn?.('[adapter-qq] webServer unavailable; scan-to-bind API not registered.');
        return;
      }
      webCtx.effect(
        () =>
          server.register({
            kind: 'exact',
            path: '/dsh-adapter-qq/api',
            handler: createOnboardRoute({ store: bindTasks, logger }),
          }),
        'dsh-adapter-qq: onboard api route'
      );
      logger.info?.('[adapter-qq] Scan-to-bind API registered at /dsh-adapter-qq/api');
    } catch (err) {
      logger.warn?.(`[adapter-qq] Failed to register scan-to-bind API: ${err.message}`);
    }
  });

  // 7. When gateway connects and is READY
  gateway.on('ready', async ({ botUser }) => {
    logger.info?.(`[adapter-qq] QQ Bot ready! Connected as "${botUser?.username}" (${botUser?.id})`);

    // Auto-register global custom shortcut menu (PUT /v2/menu) if enabled.
    // Items for team status / tasks / background jobs only appear when the
    // corresponding official plugins are present in this composition.
    if (getConfig().autoRegisterMenu) {
      try {
        // Isolated services (persistent terminals, agent-scoped jobs) are only
        // visible from the live Agent's scoped context, not the host context.
        let agent;
        let agentCtx;
        try {
          const activeId = await sessionManager.getActiveSessionId();
          agent = ctx.get('agents')?.get?.(activeId);
          agentCtx = agent?.ctx;
        } catch {
          agentCtx = undefined;
        }
        const scopedGet = (name) => {
          const scoped = agentCtx && typeof agentCtx.get === 'function' ? agentCtx.get(name) : undefined;
          return scoped ?? ctx.get(name);
        };
        let terminalToolEnabled = false;
        try {
          const tools = agentCtx?.get?.('tools') ?? ctx.get('tools');
          terminalToolEnabled = Boolean(
            agent && tools?.get && (tools.get('terminal_send', agent) || tools.get('terminal_open', agent))
          );
        } catch {
          terminalToolEnabled = false;
        }
        const capabilities = {
          team: Boolean(scopedGet('agentTeams')?.listMembers),
          schedule: Boolean(scopedGet('schedule')?.catalog),
          terminal:
            Boolean(scopedGet('terminals')) || terminalToolEnabled || (await hasTerminalPlugin(ctx)),
        };
        await apiClient.registerDefaultGlobalMenu(capabilities);
        logger.info?.(
          `[adapter-qq] Global custom menu registered (team=${capabilities.team}, schedule=${capabilities.schedule}, terminal=${capabilities.terminal}).`
        );
      } catch (err) {
        logger.warn?.(`[adapter-qq] Auto-register menu failed: ${err.message}`);
      }
    }
  });

  // 7. Start services
  approvalHandler.start();
  messageBridge.start();

  // 8. Register agent-callable tools (render text -> image, send local file to QQ)
  try {
    const tools = ctx.get('tools');
    if (tools?.register) {
      // SVG fallback output is a vector document, not a raster image: send it as a file.
      const sendRenderedMedia = (openid, payload) => {
        if (/\.svg$/i.test(String(payload?.filename || ''))) {
          return apiClient.sendFile(openid, payload);
        }
        return apiClient.sendImage(openid, payload);
      };
      tools.register(
        createRenderTextImageTool({
          renderTextImage,
          sendImage: sendRenderedMedia,
          getConfig,
          logger,
        })
      );
      tools.register(
        createSendFileTool({
          sendImage: (openid, payload) => apiClient.sendImage(openid, payload),
          sendFile: (openid, payload) => apiClient.sendFile(openid, payload),
          getConfig,
          logger,
        })
      );
      logger.info?.('[adapter-qq] Registered agent tools: qq_render_text_image, qq_send_file');
    } else {
      logger.warn?.('[adapter-qq] tools service is unavailable; QQ agent tools were not registered.');
    }
  } catch (err) {
    logger.warn?.(`[adapter-qq] Failed to register agent tools: ${err.message}`);
  }

  // If already configured by bundle entry config
  if (getConfig().enabled && apiClient.isConfigured()) {
    logger.info?.('[adapter-qq] Initial configuration present, connecting to QQ Gateway...');
    gateway.connect();
  }

  // 8. Reversible effect for plugin disposal
  ctx.effect(() => () => {
    logger.info?.('[adapter-qq] Stopping QQ Bot adapter...');
    gateway.disconnect();
    approvalHandler.stop();
    messageBridge.stop();
  }, 'dsh-adapter-qq: cleanup');
}
