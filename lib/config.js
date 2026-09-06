import z from '@deepseek-ai/schemastery';

/**
 * Settings namespace for DSH settings document
 */
export const SETTINGS_NAMESPACE = 'adapter-qq';

/**
 * Configuration schema for dsh-adapter-qq
 */
export const Config = z.object({
  enabled: z.boolean().default(true).description('是否启用 QQ Bot 适配器连接'),
  appId: z.string().default('').description('QQ 开放平台 Bot AppID (来自 q.qq.com 开发设置)'),
  clientSecret: z.string().role('secret').default('').description('QQ 开放平台 Bot AppSecret'),
  token: z.string().role('secret').default('').description('QQ 开放平台 Bot Token（备用/可选）'),
  userOpenid: z.string().default('').description('绑定的专属用户 OpenID（留空将在收到首条消息时自动绑定）'),
  sandbox: z.boolean().default(false).description('是否使用 QQ 沙箱测试环境 (测试人员需加入沙箱管理)'),
  activeSessionId: z.string().default('').description('当前活跃 DSH 会话 ID'),
  defaultCwd: z.string().default('').description('新建会话默认工作根目录（留空使用 DSH 当前工作区）'),
  defaultPreset: z.string().default('standard').description('新建会话默认 Agent 预设 (如 standard, ptc, minimal, cordis)'),
  autoRegisterMenu: z.boolean().default(true).description('启动后自动向 QQ 开放平台注册快捷菜单 (PUT /v2/menu)'),
  markdown: z.boolean().default(true).description('回复消息时优先启用 Markdown 格式'),
  syncToolCalls: z.boolean().default(false).description('是否同步推送 Agent 工具调用执行细节到 QQ（默认关闭）'),
  toolCallAggregateWindowMs: z.number().default(30000).description('工具调用聚合推送时间窗口（毫秒，默认 30000ms / 30秒）'),
  allowFrom: z.array(z.string()).default(['*']).description('C2C 单聊白名单 OpenID 列表（["*"] 允许任意已添加测试人员）'),
});

/**
 * Default fallback configuration
 */
export const DEFAULT_CONFIG = {
  enabled: true,
  appId: '',
  clientSecret: '',
  token: '',
  userOpenid: '',
  sandbox: false,
  activeSessionId: '',
  defaultCwd: '',
  defaultPreset: 'standard',
  autoRegisterMenu: true,
  markdown: true,
  syncToolCalls: false,
  toolCallAggregateWindowMs: 30000,
  allowFrom: ['*'],
};
