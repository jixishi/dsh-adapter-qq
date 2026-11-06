import { describeScheduleRule, formatDateTime } from './task-overview.js';

/**
 * Dedicated Typst card for `/tasks` (scheduled / automated tasks).
 *
 * The other card commands (/usage, /stats, /status, /jobs) all render a purpose
 * built Typst body; `/tasks` was the only one still handing a plain Markdown
 * document to the generic renderer, so it looked different from everything else.
 * This mirrors the /usage card language: stat cards, then a zebra table.
 */

const TYPST_PALETTES = {
  light: {
    text: '#1c1d21',
    muted: '#667085',
    accent: '#2f6feb',
    card: '#f4f7fd',
    border: '#e6eaf2',
    rowAlt: '#fafbfe',
    ok: '#1a7f37',
    idle: '#8a6d00',
  },
  dark: {
    text: '#e8eaed',
    muted: '#a0a6b2',
    accent: '#79a6ff',
    card: '#1c222b',
    border: '#2c313a',
    rowAlt: '#181d25',
    ok: '#5bd68a',
    idle: '#e0b341',
  },
};

function typstEscape(value) {
  return String(value ?? '').replace(/[\\)#$[\]*_`<>@~]/g, (char) => `\\${char}`);
}

function shortId(value) {
  const raw = String(value ?? '');
  return raw.length > 12 ? `${raw.slice(0, 12)}…` : raw || '-';
}

/**
 * @param {Array<Object>} tasks rows from collectScheduleTasks()
 * @param {{theme?:'light'|'dark', now?:number}} [options]
 * @returns {string} Typst markup (body only)
 */
export function buildScheduleTypst(tasks = [], { theme = 'light', now = Date.now() } = {}) {
  const c = TYPST_PALETTES[theme === 'dark' ? 'dark' : 'light'];
  const list = Array.isArray(tasks) ? tasks : [];
  const active = list.filter((task) => task.status !== 'inactive');
  const sorted = [...list].sort((a, b) => {
    if (a.status !== b.status) return a.status === 'inactive' ? 1 : -1;
    return String(a.scheduledAt || '').localeCompare(String(b.scheduledAt || ''));
  });
  const shown = sorted.slice(0, 30);

  const card = (title, value, sub) =>
    `block(width: 100%, fill: rgb("${c.card}"), radius: 9pt, inset: (x: 11pt, y: 10pt))[
  #text(size: 9pt, fill: rgb("${c.muted}"))[${typstEscape(title)}]
  #v(3pt)
  #text(size: 18pt, weight: "bold", fill: rgb("${c.text}"))[${typstEscape(value)}]
  #v(2pt)
  #text(size: 8pt, fill: rgb("${c.muted}"))[${typstEscape(sub)}]
]`;

  const cards = [
    card('任务总数', String(list.length), '全部定时/自动化任务'),
    card('启用中', String(active.length), '状态不是已结束'),
    card('已结束', String(list.length - active.length), '不再触发'),
    card('展示条数', String(shown.length), list.length > 30 ? `仅显示前 30 条` : '全部显示'),
  ].join(',\n  ');

  const statusLabel = (status) => {
    const labels = { active: '启用', running: '运行中', paused: '已暂停', inactive: '已结束' };
    return labels[status] || status || '-';
  };

  const rows = shown
    .map((task) => {
      const status = String(task.status || '');
      const statusColor = status === 'inactive' ? c.muted : status === 'paused' ? c.idle : c.ok;
      return `[${typstEscape(task.title || '(未命名)')}], [${typstEscape(describeScheduleRule(task))}], [#text(fill: rgb("${statusColor}"))[${typstEscape(statusLabel(status))}]], [${typstEscape(formatDateTime(task.scheduledAt))}], [${typstEscape(task.sessionId ? shortId(task.sessionId) : '-')}]`;
    })
    .join(',\n  ');

  const emptyRow = '[当前没有定时/自动化任务。], [], [], [], []';

  const truncated =
    list.length > 30
      ? `\n#v(6pt)\n#text(size: 9pt, fill: rgb("${c.muted}"))[仅显示前 30 条，剩余 ${list.length - 30} 条请到 DSH「任务」页面查看。]`
      : '';

  return `#grid(columns: (1fr, 1fr, 1fr, 1fr), gutter: 9pt,
  ${cards}
)
#v(12pt)
#block(below: 7pt)[#text(size: 15pt, weight: "bold", fill: rgb("${c.accent}"))[任务列表]]
#table(
  columns: (1.5fr, 1.1fr, 0.6fr, 1.05fr, 0.85fr),
  inset: (x: 8pt, y: 7pt),
  align: (left, left, center, left, left),
  stroke: none,
  fill: (col, row) => if row == 0 { rgb("${c.card}") } else if calc.odd(row) { rgb("${c.rowAlt}") } else { none },
  table.header(
    [*标题*], [*规则*], [*状态*], [*计划时间*], [*会话*]
  ),
  ${rows || emptyRow}
)${truncated}
#v(10pt)
#text(size: 9pt, fill: rgb("${c.muted}"))[生成时间：${typstEscape(
    new Date(now).toLocaleString('zh-CN', { hour12: false })
  )}]`;
}
