/**
 * Display helpers shared by the subscription API and the sidebar pane:
 * compact relative timestamps and workspace grouping.
 *
 * The relative-time units mirror DSH's own left sidebar so the two never disagree:
 * `刚刚 / N分钟 / N小时 / N天 / N个月 / N年`
 * (source: dsh-client-ui-workspace `timeLabel` + its `time.*` locale keys).
 */

/** One minute, in ms. */
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const MONTH = 30 * DAY;
const YEAR = 365 * DAY;

/**
 * Compact relative time, matching DSH's sidebar wording.
 *
 * Edge cases matter here: a missing / zero / future timestamp must not render as
 * "NaN天" or a huge negative number. Those all collapse to "刚刚".
 *
 * @param {number} updatedAt epoch ms
 * @param {number} [now] epoch ms
 * @returns {string}
 */
export function formatRelativeTime(updatedAt, now = Date.now()) {
  const then = Number(updatedAt);
  const current = Number(now);
  if (!Number.isFinite(then) || then <= 0) return '';
  if (!Number.isFinite(current)) return '';

  const delta = current - then;
  // Future timestamps (clock skew) and sub-minute gaps both read as "刚刚".
  if (delta < MINUTE) return '刚刚';
  if (delta < HOUR) return `${Math.floor(delta / MINUTE)}分钟`;
  if (delta < DAY) return `${Math.floor(delta / HOUR)}小时`;
  if (delta < MONTH) return `${Math.floor(delta / DAY)}天`;
  if (delta < YEAR) return `${Math.floor(delta / MONTH)}个月`;
  return `${Math.floor(delta / YEAR)}年`;
}

/**
 * Countdown until the next coalesced push.
 *
 * Shown next to each subscription so "汇聚间隔 5 分钟" stops being an abstract
 * setting and the user can see how long the buffered messages will wait.
 *
 * @param {number} dueInMs milliseconds remaining
 * @returns {string} e.g. '4分12秒后推送', '即将推送', '' when nothing is buffered
 */
export function formatDueIn(dueInMs) {
  const remaining = Number(dueInMs);
  // Negative means nothing is buffered (the store reports -1 for "no window").
  if (!Number.isFinite(remaining) || remaining < 0) return '';
  if (remaining === 0) return '即将推送';
  const totalSeconds = Math.ceil(remaining / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}小时${minutes}分后推送`;
  if (minutes > 0) return `${minutes}分${seconds}秒后推送`;
  return `${seconds}秒后推送`;
}

/**
 * Workspace label for a session's cwd: the final path segment, matching the
 * `sessionPathDisplay: 'tail'` convention used elsewhere in this plugin.
 *
 * @param {string} cwd
 * @returns {string}
 */
export function workspaceLabel(cwd) {
  const raw = String(cwd || '').trim();
  if (!raw) return '未指定工作区';
  const trimmed = raw.replace(/[\\/]+$/, '');
  const parts = trimmed.split(/[\\/]/).filter(Boolean);
  if (parts.length === 0) return trimmed || '未指定工作区';
  return parts[parts.length - 1];
}

/**
 * Group rows by workspace, newest activity first inside each group and groups
 * ordered by their most recent member.
 *
 * A stable key is kept alongside the label because two different paths can share
 * a tail segment (`D:/a/proj` and `E:/b/proj`); grouping by label alone would
 * silently merge unrelated projects.
 *
 * @param {Array<Object>} rows each with `cwd` and `updatedAt`
 * @param {(row:Object)=>number} [timestampOf]
 * @returns {Array<{key:string,label:string,path:string,sessions:Array<Object>,updatedAt:number}>}
 */
export function groupByWorkspace(rows, timestampOf = (row) => Number(row?.updatedAt) || 0) {
  const groups = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row) continue;
    const cwd = String(row.cwd || '').trim();
    const key = cwd || '__none__';
    let group = groups.get(key);
    if (!group) {
      group = { key, label: workspaceLabel(cwd), path: cwd, sessions: [], updatedAt: 0 };
      groups.set(key, group);
    }
    group.sessions.push(row);
    group.updatedAt = Math.max(group.updatedAt, timestampOf(row));
  }

  const list = [...groups.values()];
  for (const group of list) {
    group.sessions.sort((a, b) => timestampOf(b) - timestampOf(a));
  }
  list.sort((a, b) => b.updatedAt - a.updatedAt);
  return list;
}
