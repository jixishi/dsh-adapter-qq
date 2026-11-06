/**
 * Dedicated Typst cards for `/status` and `/jobs`.
 *
 * Every other card command (/usage, /stats, /tasks) renders a purpose-built Typst
 * body; these two were still handing raw Markdown to the generic renderer, which
 * is why their pictures looked like plain text instead of the card layout.
 */

import { resolvePermissionLabel, resolvePresetLabel } from '../labels.js';

const TYPST_PALETTES = {
  light: {
    text: '#1c1d21',
    muted: '#667085',
    accent: '#2f6feb',
    card: '#f4f7fd',
    rowAlt: '#fafbfe',
    ok: '#1a7f37',
    warn: '#8a6d00',
    idle: '#667085',
  },
  dark: {
    text: '#e8eaed',
    muted: '#a0a6b2',
    accent: '#79a6ff',
    card: '#1c222b',
    rowAlt: '#181d25',
    ok: '#5bd68a',
    warn: '#e0b341',
    idle: '#a0a6b2',
  },
};

function typstEscape(value) {
  return String(value ?? '').replace(/[\\)#$[\]*_`<>@~]/g, (char) => `\\${char}`);
}

function palette(theme) {
  return TYPST_PALETTES[theme === 'dark' ? 'dark' : 'light'];
}

function card(c, title, value, sub) {
  return `block(width: 100%, fill: rgb("${c.card}"), radius: 9pt, inset: (x: 11pt, y: 10pt))[
  #text(size: 9pt, fill: rgb("${c.muted}"))[${typstEscape(title)}]
  #v(3pt)
  #text(size: 18pt, weight: "bold", fill: rgb("${c.text}"))[${typstEscape(value)}]
  #v(2pt)
  #text(size: 8pt, fill: rgb("${c.muted}"))[${typstEscape(sub)}]
]`;
}

/** Status colour by the human-readable status label produced upstream. */
function statusColor(c, status) {
  const value = String(status || '');
  if (/运行中|running|🔄/.test(value)) return c.ok;
  if (/空闲|idle|💤/.test(value)) return c.warn;
  return c.idle;
}

/**
 * `/status` card: main agent, members/subagents, background jobs.
 *
 * @param {Object} overview result of collectAgentOverview()
 * @param {{theme?:'light'|'dark', now?:number}} [options]
 * @returns {string} Typst markup
 */
export function buildAgentStatusTypst(overview = {}, { theme = 'light', now = Date.now() } = {}) {
  const c = palette(theme);
  const main = overview.main || null;
  const children = Array.isArray(overview.children) ? overview.children : [];
  const jobs = Array.isArray(overview.jobs) ? overview.jobs : [];
  const teamEnabled = overview.teamEnabled === true;
  const terminalEnabled = overview.terminalEnabled === true;

  const cards = [
    card(c, '当前会话', main?.title || '(无活跃会话)', main?.cwd || '未指定工作区'),
    card(
      c,
      '预设 / 权限',
      main?.agentPreset ? resolvePresetLabel(main.agentPreset) : '-',
      main?.permission ? resolvePermissionLabel(main.permission) : '-'
    ),
    card(c, teamEnabled ? '团队成员' : '子代理', String(children.length), teamEnabled ? 'Agent Teams 成员' : '普通子代理'),
    card(c, '后台任务', terminalEnabled ? String(jobs.length) : '未启用', terminalEnabled ? '持久终端运行中' : '需 @deepseek-ai/dsh-terminal'),
  ].join(',\n  ');

  const memberRows = children
    .slice(0, 20)
    .map((item) => {
      const name = item.name || item.label || item.id || '(未命名)';
      const role = item.role === 'teammate' ? '成员' : item.role === 'lead' ? 'Lead' : '';
      return `[${typstEscape(name)}], [${typstEscape(role)}], [#text(fill: rgb("${statusColor(
        c,
        item.status
      )}"))[${typstEscape(item.status || '-')}]], [${typstEscape(String(item.id || '').slice(0, 14))}]`;
    })
    .join(',\n  ');

  const jobRows = jobs
    .slice(0, 20)
    .map(
      (job) =>
        `[${typstEscape(job.label || job.command || job.id || '-')}], [${typstEscape(
          job.kind || '-'
        )}], [#text(fill: rgb("${statusColor(c, job.status)}"))[${typstEscape(job.status || '-')}]], [${typstEscape(
          String(job.sessionId || '').slice(0, 14) || '-'
        )}]`
    )
    .join(',\n  ');

  const memberSection = children.length
    ? `#v(12pt)
#block(below: 7pt)[#text(size: 15pt, weight: "bold", fill: rgb("${c.accent}"))[${teamEnabled ? '团队成员' : '子代理'}]]
#table(
  columns: (1.4fr, 0.6fr, 0.8fr, 1fr),
  inset: (x: 8pt, y: 7pt),
  align: (left, left, left, left),
  stroke: none,
  fill: (col, row) => if row == 0 { rgb("${c.card}") } else if calc.odd(row) { rgb("${c.rowAlt}") } else { none },
  table.header([*名称*], [*角色*], [*状态*], [*会话*]),
  ${memberRows}
)`
    : '';

  const jobSection = terminalEnabled
    ? jobs.length
      ? `#v(12pt)
#block(below: 7pt)[#text(size: 15pt, weight: "bold", fill: rgb("${c.accent}"))[后台任务]]
#table(
  columns: (1.5fr, 0.7fr, 0.7fr, 1fr),
  inset: (x: 8pt, y: 7pt),
  align: (left, left, left, left),
  stroke: none,
  fill: (col, row) => if row == 0 { rgb("${c.card}") } else if calc.odd(row) { rgb("${c.rowAlt}") } else { none },
  table.header([*任务*], [*类型*], [*状态*], [*会话*]),
  ${jobRows}
)`
      : `#v(10pt)
#text(size: 10pt, fill: rgb("${c.muted}"))[当前没有正在运行的后台任务。]`
    : `#v(10pt)
#text(size: 10pt, fill: rgb("${c.warn}"))[未启用官方持久终端（@deepseek-ai/dsh-terminal），无后台任务信息。]`;

  return `#grid(columns: (1fr, 1fr, 1fr, 1fr), gutter: 9pt,
  ${cards}
)${memberSection}${jobSection}
#v(10pt)
#text(size: 9pt, fill: rgb("${c.muted}"))[生成时间：${typstEscape(
    new Date(now).toLocaleString('zh-CN', { hour12: false })
  )}]`;
}

/**
 * `/jobs` card: running background jobs only.
 *
 * @param {Array<Object>} jobs
 * @param {{theme?:'light'|'dark', now?:number}} [options]
 * @returns {string} Typst markup
 */
export function buildJobsTypst(jobs = [], { theme = 'light', now = Date.now() } = {}) {
  const c = palette(theme);
  const list = Array.isArray(jobs) ? jobs : [];
  const running = list.filter((job) => /running/i.test(String(job?.status || ''))).length;

  const cards = [
    card(c, '任务总数', String(list.length), '当前会话的后台任务'),
    card(c, '运行中', String(running), '状态为 running'),
    card(c, '安静', String(list.length - running), '已结束或暂停'),
    card(c, '终端', '已启用', '持久终端可用'),
  ].join(',\n  ');

  const rows = list
    .slice(0, 30)
    .map(
      (job) =>
        `[${typstEscape(job.label || job.command || job.id || '-')}], [${typstEscape(
          job.kind || '-'
        )}], [#text(fill: rgb("${statusColor(c, job.status)}"))[${typstEscape(job.status || '-')}]], [${typstEscape(
          String(job.sessionId || '').slice(0, 14) || '-'
        )}]`
    )
    .join(',\n  ');

  return `#grid(columns: (1fr, 1fr, 1fr, 1fr), gutter: 9pt,
  ${cards}
)
#v(12pt)
#block(below: 7pt)[#text(size: 15pt, weight: "bold", fill: rgb("${c.accent}"))[后台任务]]
#table(
  columns: (1.5fr, 0.7fr, 0.7fr, 1fr),
  inset: (x: 8pt, y: 7pt),
  align: (left, left, left, left),
  stroke: none,
  fill: (col, row) => if row == 0 { rgb("${c.card}") } else if calc.odd(row) { rgb("${c.rowAlt}") } else { none },
  table.header([*任务*], [*类型*], [*状态*], [*会话*]),
  ${rows || '[当前没有正在运行的后台任务。], [], [], []'}
)
#v(10pt)
#text(size: 9pt, fill: rgb("${c.muted}"))[生成时间：${typstEscape(
    new Date(now).toLocaleString('zh-CN', { hour12: false })
  )}]`;
}
