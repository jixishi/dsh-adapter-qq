/**
 * Read-only overview used by the QQ "任务管理" (`/tasks`) and
 * "代理状态" (`/status`) commands.
 *
 * Data sources (all optional, resolved from the host context):
 *   - sessionManager: active session info (title/cwd/preset/permission)
 *   - ctx.agents:     live agent status (`running` | `inactive`)
 *   - ctx.subagents:  children of the active session
 *   - ctx.jobs:       background jobs per owning session
 *   - ctx.schedule:   host-wide scheduled reminders (`catalog()`)
 */

const JOB_KIND_LABELS = {
  bash: 'Shell',
  node: 'Node',
  python: 'Python',
  browser: '浏览器',
  http: 'HTTP',
  workflow: '工作流',
};

const SCHEDULE_KIND_LABELS = {
  at: '单次',
  every: '固定周期',
  daily: '每日',
  weekly: '每周',
  cron: 'Cron',
};

const SCHEDULE_STATUS_LABELS = {
  active: '启用',
  inactive: '已结束',
};

const AGENT_STATUS_LABELS = {
  running: '🔄 运行中',
  inactive: '💤 空闲',
  provisioning: '⏳ 准备中',
  failed: '❌ 失败',
};

/**
 * @param {unknown} value
 * @returns {string}
 */
export function formatDateTime(value) {
  if (value === undefined || value === null || value === '') return '-';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString('zh-CN', { hour12: false });
}

/**
 * @param {number} ms
 * @returns {string}
 */
export function formatDuration(ms) {
  const total = Math.max(0, Math.floor(Number(ms) || 0) / 1000);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = Math.floor(total % 60);
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

/**
 * @param {string} status
 * @returns {string}
 */
export function formatAgentStatus(status) {
  return AGENT_STATUS_LABELS[String(status || '').toLowerCase()] || `❔ ${status || '未知'}`;
}

/**
 * Human-readable schedule rule.
 * @param {Object} task
 * @returns {string}
 */
export function describeScheduleRule(task = {}) {
  const kind = String(task.kind || '');
  const time = task.time ? String(task.time) : '';
  const zone = task.timeZone ? String(task.timeZone) : '';
  switch (kind) {
    case 'at':
      return `单次 ${formatDateTime(task.scheduledAt)}`;
    case 'every':
      return `每 ${formatDuration(Number(task.everySeconds) * 1000)}`;
    case 'daily':
      return `每日 ${time}${zone ? ` (${zone})` : ''}`;
    case 'weekly': {
      const names = ['日', '一', '二', '三', '四', '五', '六'];
      const weekdays = Array.isArray(task.weekdays) ? task.weekdays : [];
      const label = weekdays.map((day) => names[Number(day) % 7] || String(day)).join('、');
      return `每周 ${label || '-'} ${time}${zone ? ` (${zone})` : ''}`;
    }
    case 'cron':
      return `Cron ${task.expression || '-'}${zone ? ` (${zone})` : ''}`;
    default:
      return kind || '未知规则';
  }
}

function escapeCell(value) {
  return String(value ?? '')
    .replace(/\|/g, '\\|')
    .replace(/\n+/g, ' ')
    .trim();
}

/**
 * Compact session id for tables: drop the "session-" prefix, keep 8 chars.
 * @param {string} id
 * @returns {string}
 */
export function shortSessionId(id) {
  const raw = String(id ?? '').replace(/^session-/, '');
  return raw ? raw.slice(0, 8) : '-';
}

function table(headers, rows) {
  const head = `| ${headers.join(' | ')} |`;
  const divider = `| ${headers.map(() => '---').join(' | ')} |`;
  const body = rows.map((row) => `| ${row.map(escapeCell).join(' | ')} |`);
  return [head, divider, ...body].join('\n');
}

/**
 * Build the Markdown behind the `/status` image.
 * @param {Object} overview
 * @param {Object|null} overview.main
 * @param {Array} [overview.children]
 * @param {Array} [overview.jobs]
 * @param {boolean} [overview.teamEnabled] official Agent Teams plugin active
 * @param {boolean} [overview.terminalEnabled] official persistent terminal active
 * @param {number} [now]
 * @returns {string}
 */
export function buildAgentStatusMarkdown({
  main,
  children = [],
  jobs = [],
  teamEnabled = false,
  terminalEnabled = false,
  now = Date.now(),
} = {}) {
  const teamTitle = teamEnabled ? `团队成员（${children.length}）` : `子代理（${children.length}）`;
  const childrenTable = teamEnabled
    ? table(
        ['成员', '角色', '状态', '会话'],
        children.map((child) => [
          child.name || child.label || '(未命名)',
          child.role === 'lead' ? 'Lead' : '成员',
          child.status || '未知',
          child.id ? shortSessionId(child.id) : '-',
        ])
      )
    : table(
        ['子代理', '状态', '会话'],
        children.map((child) => [
          child.label || '(未命名)',
          child.status || '未知',
          child.id ? shortSessionId(child.id) : '-',
        ])
      );

  const lines = [
    '## 主代理',
    main
      ? table(
          ['项目', '值'],
          [
            ['标题', main.title || '(未命名)'],
            ['会话', main.sessionId ? shortSessionId(main.sessionId) : '-'],
            ['状态', main.status || (main.running ? 'running' : 'inactive')],
            ['模型', main.model ? `${main.model}${main.provider ? ` (${main.provider})` : ''}` : '-'],
            ['预设', main.preset || '-'],
            ['权限', main.permission || '-'],
            ['目录', main.cwd || '-'],
          ]
        )
      : '当前没有活跃会话。',
    '',
    `## ${teamTitle}`,
    children.length
      ? childrenTable
      : teamEnabled
        ? '团队中没有其他成员。'
        : '无子代理。',
    '',
    `## 后台任务（${terminalEnabled ? jobs.length : 0}）`,
    !terminalEnabled
      ? '未启用官方持久终端（@deepseek-ai/dsh-terminal），无后台任务。'
      : jobs.length
        ? table(
            ['任务', '类型', '状态', '已运行', '进度'],
            jobs.map((job) => [
              job.label || job.id || '(未命名)',
              JOB_KIND_LABELS[job.kind] || job.kind || '-',
              job.status === 'stopping' ? '停止中' : '运行中',
              formatDuration(now - Number(job.startedAt || now)),
              job.progress || '-',
            ])
          )
        : '无正在进行的后台任务。',
  ];
  return lines.join('\n');
}

/**
 * Build a jobs-only Markdown document (used by `/jobs`).
 * @param {Array} jobs
 * @param {number} [now]
 * @returns {string}
 */
export function buildJobsMarkdown(jobs = [], now = Date.now()) {
  return [
    jobs.length
      ? table(
          ['任务', '类型', '状态', '已运行', '进度'],
          jobs.map((job) => [
            job.label || job.id || '(未命名)',
            JOB_KIND_LABELS[job.kind] || job.kind || '-',
            job.status === 'stopping' ? '停止中' : '运行中',
            formatDuration(now - Number(job.startedAt || now)),
            job.progress || '-',
          ])
        )
      : '无正在进行的后台任务。',
    '',
    `生成时间：${formatDateTime(now)}`,
  ].join('\n');
}

/**
 * Build the Markdown behind the `/tasks` image.
 * @param {Array} tasks schedule catalog records
 * @param {number} [now]
 * @returns {string}
 */
export function buildScheduleMarkdown(tasks = [], now = Date.now()) {
  const active = tasks.filter((task) => task.status !== 'inactive');
  const sorted = [...tasks].sort((a, b) => {
    if (a.status !== b.status) return a.status === 'inactive' ? 1 : -1;
    return String(a.scheduledAt || '').localeCompare(String(b.scheduledAt || ''));
  });
  const lines = [
    `共 ${tasks.length} 个任务（启用 ${active.length}，已结束 ${tasks.length - active.length}）。`,
    '',
    tasks.length
      ? table(
          ['标题', '规则', '状态', '计划时间', '绑定会话'],
          sorted.slice(0, 30).map((task) => [
            task.title || '(未命名)',
            describeScheduleRule(task),
            SCHEDULE_STATUS_LABELS[task.status] || task.status || '-',
            formatDateTime(task.scheduledAt),
            task.sessionId ? shortSessionId(task.sessionId) : '-',
          ])
        )
      : '当前没有定时/自动化任务。',
    '',
    tasks.length > 30 ? `仅显示前 30 条，剩余 ${tasks.length - 30} 条请到 DSH「任务」页面查看。` : '',
    `生成时间：${formatDateTime(now)}`,
  ];
  return lines.filter((line) => line !== '').join('\n');
}

/**
 * Collect the live main/team-member/background-job overview.
 *
 * - Team members are used when the official Agent Teams plugin exposes
 *   `ctx.agentTeams` (roster: lead + teammates with role/status).
 * - Otherwise plain subagents come from `ctx.subagents.listChildren()`.
 * - Background jobs are only reported when the official persistent terminal
 *   (`@deepseek-ai/dsh-terminal`, service `ctx.terminals`) is enabled.
 *
 * @param {Object} options
 * @param {import('@deepseek-ai/cordis').Context} options.ctx
 * @param {Object} options.sessionManager
 * @returns {Promise<{main:Object|null, children:Array, jobs:Array, teamEnabled:boolean, terminalEnabled:boolean}>}
 */
export async function collectAgentOverview({ ctx, sessionManager }) {
  const get = (name) => (typeof ctx?.get === 'function' ? ctx.get(name) : undefined);
  const agents = get('agents');
  const subagents = get('subagents');
  const jobs = get('jobs');
  const team = get('agentTeams');
  const terminals = get('terminals');
  const teamEnabled = Boolean(team?.listMembers);
  const terminalEnabled = Boolean(terminals);

  const info = await sessionManager.getActiveSessionInfo();
  if (!info) return { main: null, children: [], jobs: [], teamEnabled, terminalEnabled };

  let model = '';
  let provider = '';
  try {
    const catalog = await sessionManager.getModelCatalog();
    model = catalog?.current?.model || '';
    provider = catalog?.current?.provider || '';
  } catch {
    // model info is optional
  }

  const main = {
    sessionId: info.sessionId,
    title: info.title,
    cwd: info.cwd,
    preset: info.agentPreset,
    permission: info.permission,
    running: Boolean(info.running),
    model,
    provider,
    status: formatAgentStatus(agents?.get?.(info.sessionId)?.status || (info.running ? 'running' : 'inactive')),
  };

  const children = [];
  const mainAgent = agents?.get?.(info.sessionId);

  // Official Agent Teams: lead + teammates, with role and live status.
  if (teamEnabled && mainAgent) {
    try {
      const members = team.listMembers(mainAgent) || [];
      for (const member of members) {
        if (member.id === info.sessionId) continue;
        children.push({
          id: member.id,
          name: member.name,
          role: member.role,
          status: formatAgentStatus(member.status),
          description: member.description || '',
        });
      }
    } catch {
      // fall back to plain subagents below
    }
  }

  // Plain continuable subagents when no Team roster was available.
  if (children.length === 0 && subagents?.listChildren) {
    try {
      const entries = await subagents.listChildren(info.sessionId);
      for (const entry of entries || []) {
        if (entry?.kind === 'diagnostic') continue;
        children.push({
          id: entry.id,
          label: entry.label || entry.id,
          status: formatAgentStatus(agents?.get?.(entry.id)?.status || 'inactive'),
        });
      }
    } catch {
      // keep the section empty
    }
  }

  const running = [];
  if (terminalEnabled) {
    const ownerIds = [info.sessionId, ...children.map((child) => child.id)].filter(Boolean);
    for (const ownerId of ownerIds) {
      if (!jobs?.list) continue;
      try {
        for (const job of jobs.list(ownerId) || []) {
          if (job.status !== 'running' && job.status !== 'stopping') continue;
          running.push({ ...job, ownerSession: ownerId });
        }
      } catch {
        // one owner's jobs may be inaccessible; keep the rest
      }
    }
  }

  return { main, children, jobs: running, teamEnabled, terminalEnabled };
}

/**
 * Collect host-wide scheduled tasks, if the schedule service is loaded.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @returns {Promise<Array|null>} null when the service is unavailable
 */
export async function collectScheduleTasks(ctx) {
  const schedule = typeof ctx?.get === 'function' ? ctx.get('schedule') : undefined;
  if (!schedule?.catalog) return null;
  try {
    const tasks = await schedule.catalog();
    return Array.isArray(tasks) ? tasks : [];
  } catch {
    return [];
  }
}
