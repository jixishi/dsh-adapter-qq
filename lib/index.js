import { Config, DEFAULT_CONFIG, SETTINGS_NAMESPACE } from './config.js';
import { QQApiClient } from './qq/client.js';
import { QQGatewayClient } from './qq/gateway.js';
import { SessionManager } from './sync/session-manager.js';
import { ApprovalHandler } from './sync/approval-handler.js';
import { MessageBridge } from './sync/message-bridge.js';

export const name = 'adapter-qq';

// Declare primary injected services
export const inject = ['sessionController', 'sessions', 'settings'];

export { Config, SETTINGS_NAMESPACE };

/**
 * Main Cordis plugin apply function
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {Object} [config]
 */
export default function apply(ctx, config = {}) {
  const logger = (typeof ctx.logger === 'function' ? ctx.logger('adapter-qq') : ctx.get('logger')?.('adapter-qq')) || console;
  logger.info?.('[adapter-qq] Initializing DeepSeek Harness QQ Bot Adapter...');

  let getAuthoritative = () => ({ ...DEFAULT_CONFIG, ...config });
  let currentConfig = getAuthoritative();

  // Helper getters/setters for dynamic configuration
  const getConfig = () => currentConfig;
  const updateConfig = (patch) => {
    currentConfig = { ...currentConfig, ...patch };
    // If settings service is available, persist the patch
    const settings = ctx.get('settings');
    if (settings && typeof settings.update === 'function') {
      void settings.update(SETTINGS_NAMESPACE, patch).catch((err) => {
        logger.warn?.(`[adapter-qq] Failed to persist settings update: ${err.message}`);
      });
    }
  };

  // 1. Initialize QQ API Client & WebSocket Gateway
  const apiClient = new QQApiClient({
    appId: currentConfig.appId,
    clientSecret: currentConfig.clientSecret,
    sandbox: currentConfig.sandbox,
    logger,
  });

  const gateway = new QQGatewayClient({
    apiClient,
    logger,
  });

  // 2. Initialize Session Manager
  const sessionManager = new SessionManager({
    ctx,
    getActiveSessionId: () => currentConfig.activeSessionId,
    setActiveSessionId: (sid) => updateConfig({ activeSessionId: sid }),
    logger,
  });

  // 3. Initialize Approval Handler
  const approvalHandler = new ApprovalHandler({
    ctx,
    apiClient,
    sessionManager,
    getUserOpenid: () => currentConfig.userOpenid,
    logger,
  });

  // 4. Initialize Message Bridge
  const messageBridge = new MessageBridge({
    ctx,
    apiClient,
    gateway,
    sessionManager,
    approvalHandler,
    getConfig,
    updateConfig,
    logger,
  });

  // Sync / Connect helper function
  const applyConfigAndConnect = (newConfig) => {
    const prevAppId = currentConfig.appId;
    const prevSecret = currentConfig.clientSecret;
    const prevEnabled = currentConfig.enabled;
    const prevSandbox = currentConfig.sandbox;

    currentConfig = { ...currentConfig, ...newConfig };

    apiClient.updateConfig({
      appId: currentConfig.appId,
      clientSecret: currentConfig.clientSecret,
      sandbox: currentConfig.sandbox,
    });

    const isConfigured = apiClient.isConfigured();
    logger.info?.(`[adapter-qq] Config state: enabled=${currentConfig.enabled}, configured=${isConfigured} (appId: ${currentConfig.appId ? currentConfig.appId : '<empty>'})`);

    if (currentConfig.enabled && isConfigured) {
      const credsChanged =
        currentConfig.appId !== prevAppId ||
        currentConfig.clientSecret !== prevSecret ||
        currentConfig.sandbox !== prevSandbox;

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

  // 5. Install settings section in DSH settings service (if available)
  ctx.inject(['settings'], (settingsCtx) => {
    try {
      settingsCtx.settings.installSection(ctx, SETTINGS_NAMESPACE, Config, currentConfig, {
        setSource: (authoritative) => {
          if (typeof authoritative === 'function') {
            getAuthoritative = authoritative;
          }
        },
        onChange: () => {
          logger.info?.('[adapter-qq] Settings changed/synchronized from DSH settings file/UI.');
          const resolved = getAuthoritative();
          applyConfigAndConnect(resolved);
        },
      });
      logger.info?.('[adapter-qq] Registered into DSH settings system successfully.');
    } catch (err) {
      logger.warn?.(`[adapter-qq] Failed to install settings section: ${err.message}`);
    }
  });

  // 6. When gateway connects and is READY
  gateway.on('ready', async ({ botUser }) => {
    logger.info?.(`[adapter-qq] QQ Bot ready! Connected as "${botUser?.username}" (${botUser?.id})`);

    // Auto-register global custom shortcut menu (PUT /v2/menu) if enabled
    if (currentConfig.autoRegisterMenu) {
      try {
        await apiClient.registerDefaultGlobalMenu();
        logger.info?.('[adapter-qq] Global custom menu registered successfully on QQ Open Platform.');
      } catch (err) {
        logger.warn?.(`[adapter-qq] Auto-register menu failed: ${err.message}`);
      }
    }
  });

  // 7. Start services
  approvalHandler.start();
  messageBridge.start();

  // If already configured by bundle entry config
  if (currentConfig.enabled && apiClient.isConfigured()) {
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
