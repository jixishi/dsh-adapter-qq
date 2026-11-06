import z from '@deepseek-ai/schemastery';

/**
 * Settings namespace for DSH settings document
 */
export const SETTINGS_NAMESPACE = 'adapter-qq';

/**
 * Configuration schema for dsh-adapter-qq.
 *
 * Every field is `.volatile()`: DSH 0.2.1 only lets the Settings UI write
 * fields whose nearest schema node is volatile (`settings.write` refuses
 * everything else with `has no volatile fields`). The plugin reads volatile
 * refs through `unwrapVolatileConfig()` and follows the
 * `settings/document-updated` event, so edits apply without a restart.
 */
export const Config = z.object({
  enabled: z.boolean().default(true).volatile().description('是否启用 QQ Bot 适配器连接'),
  appId: z.string().default('').volatile().description('QQ 开放平台 Bot AppID (来自 q.qq.com 开发设置)'),
  clientSecret: z.string().role('secret').default('').volatile().description('QQ 开放平台 Bot AppSecret'),
  token: z.string().role('secret').default('').volatile().description('QQ 开放平台 Bot Token（备用/可选）'),
  userOpenid: z.string().default('').volatile().description('绑定的专属用户 OpenID（留空将在收到首条消息时自动绑定）'),
  sandbox: z.boolean().default(true).volatile().description('是否使用 QQ 沙箱测试环境（默认开启；机器人正式上线前请保持开启，并需在开放平台测试人员管理中加入您的 QQ 号）'),
  activeSessionId: z.string().default('').volatile().description('当前活跃 DSH 会话 ID'),
  defaultCwd: z.string().default('').volatile().description('新建会话默认工作根目录（留空使用 DSH 当前工作区）'),
  defaultPreset: z.string().default('standard').volatile().description('新建会话默认 Agent 预设 (如 standard, ptc, minimal, cordis)'),
  autoRegisterMenu: z.boolean().default(true).volatile().description('启动后自动向 QQ 开放平台注册快捷菜单 (PUT /v2/menu)'),
  markdown: z.boolean().default(true).volatile().description('回复消息时优先启用 Markdown 格式'),
  syncWebQuestions: z.boolean().default(false).volatile().description('是否同步 Web UI 端的提问到 QQ（默认关闭，避免电脑操作时频繁弹窗打扰）'),
  syncToolCalls: z.boolean().default(false).volatile().description('是否同步推送 Agent 工具调用执行细节到 QQ（默认关闭）'),
  toolCallAggregateWindowMs: z.number().default(30000).volatile().description('工具调用聚合推送时间窗口（毫秒，默认 30000ms / 30秒）'),
  sessionPageSize: z.number().default(6).volatile().description('会话列表每页数量（QQ 操作板建议不超过 6 个按键）'),
  sessionPathDisplay: z.string().default('tail').volatile().description('会话列表工作区路径显示方式：tail=仅最后一级文件夹，full=完整路径'),
  autoSendAttachments: z.boolean().default(true).volatile().description('Agent 回复中的图片/文件是否自动转发到 QQ'),
  sendOverviewCaption: z.boolean().default(false).volatile().description('渲染图片（/usage、/status 等）发送后是否再补发一条文字说明（默认关闭）'),
  busyDelivery: z
    .union([z.const('steer'), z.const('queue')])
    .default('steer')
    .volatile()
    .description('Agent 运行中时，QQ 里直接发送的普通文本如何投递：steer=立即插话（默认），queue=本轮结束后发送'),
  streamReply: z.boolean().default(false).volatile().description('是否启用流式回复（按增量持续推送回复文本，默认关闭）'),
  streamIntervalMs: z.number().default(1500).volatile().description('流式回复推送间隔（毫秒，默认 1500）'),
  notifyRestartRecovery: z
    .boolean()
    .default(false)
    .volatile()
    .description('宿主重启后，若上一进程仍有未完成的轮次，启动时向 QQ 补发一条中断提示（默认关闭）'),
  notifyTurnAbnormal: z
    .boolean()
    .default(true)
    .volatile()
    .description('轮次因出错/超限/被拦截/中断而非正常结束时，向 QQ 推送状态提示（默认开启）'),
  renderWidth: z.number().default(900).volatile().description('文本渲染为图片的像素宽度'),
  renderTheme: z.string().default('light').volatile().description('文本渲染图片主题（light | dark）'),
  subscriptionSendMode: z
    .string()
    .default('text')
    .volatile()
    .description('订阅汇聚通知的发送形式：text=纯文字（默认；内容超长时自动改发图片）/ image=总是渲染成图片 / auto=仅超长时用图片'),
  mcpManagerToken: z.string().role('secret').default('').volatile().description('dsh-mcp-manager 写操作访问令牌 token（可选，未设置则读取环境变量 DSH_MCP_MANAGER_TOKEN）'),
  allowFrom: z.array(z.string()).default(['*']).volatile().description('C2C 单聊白名单 OpenID 列表（["*"] 允许任意已添加测试人员）'),
});

/**
 * Flatten a validated volatile config: DSH hands volatile fields to `apply()`
 * as live refs (`{ get() }`), not raw values.
 * @param {Record<string, unknown>} raw
 * @returns {Record<string, unknown>}
 */
export function unwrapVolatileConfig(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [key, value] of Object.entries(raw)) {
    out[key] =
      value !== null && typeof value === 'object' && typeof value.get === 'function'
        ? value.get()
        : value;
  }
  return out;
}

/**
 * Default fallback configuration
 */
export const DEFAULT_CONFIG = {
  enabled: true,
  appId: '',
  clientSecret: '',
  token: '',
  userOpenid: '',
  sandbox: true,
  activeSessionId: '',
  defaultCwd: '',
  defaultPreset: 'standard',
  autoRegisterMenu: true,
  markdown: true,
  syncWebQuestions: false,
  syncToolCalls: false,
  toolCallAggregateWindowMs: 30000,
  sessionPageSize: 6,
  sessionPathDisplay: 'tail',
  autoSendAttachments: true,
  sendOverviewCaption: false,
  busyDelivery: 'steer',
  streamReply: false,
  streamIntervalMs: 1500,
  notifyRestartRecovery: false,
  notifyTurnAbnormal: true,
  renderWidth: 900,
  renderTheme: 'light',
  subscriptionSendMode: 'text',
  mcpManagerToken: '',
  allowFrom: ['*'],
};
