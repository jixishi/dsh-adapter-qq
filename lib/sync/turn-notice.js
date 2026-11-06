/**
 * Abnormal turn-end notices.
 *
 * A DSH turn can end without producing an assistant message: the gateway errors,
 * the model hits its output cap, a safety policy blocks the step, or the run is
 * interrupted. The Web UI shows a status bar for all of these; QQ used to show
 * nothing, so a phone user could not tell "still working" from "died an hour
 * ago".
 *
 * This module owns the decision, the wording and the reason parsing — pure
 * functions only, so the behaviour is unit-testable without a live agent.
 *
 * `reason.kind` values were read from the DSH source
 * (`@deepseek-ai/dsh-acp/lib/index.js`, `turnEndToStopReason`): completed,
 * max-tokens, aborted, interrupted, blocked, error. The type is documented there
 * as merge-extensible, hence the explicit fallback for unknown kinds.
 */

/** Human-facing label + severity for each known `reason.kind`. */
export const TURN_END_KINDS = {
  completed: { label: '已完成', icon: '', notify: false },
  error: { label: '执行出错', icon: '⚠️', notify: true },
  'max-tokens': { label: '达到单轮输出上限', icon: '⏸️', notify: true },
  blocked: { label: '被权限或安全策略拦截', icon: '🚫', notify: true },
  interrupted: { label: '被中断', icon: '⚡', notify: true },
  aborted: { label: '已中止', icon: '⏹️', notify: true },
};

/**
 * Error codes that the host already retries or that carry no information for the
 * user. Reporting them would be noise: the turn usually recovers on its own.
 */
const QUIET_ERROR_CODES = ['STREAM_CLOSED', 'ECONNRESET', 'EPIPE'];

/**
 * Pull a short human summary out of a turn-end reason.
 *
 * The reason object is not uniform: it carries `error`, `failure`, `message`,
 * `text` or `reason` depending on who ended the turn (see the DSH sources). Try
 * them in that order and never assume any field exists.
 *
 * @param {Object} reason
 * @returns {{code:string, message:string}}
 */
export function summarizeTurnEndReason(reason) {
  const r = reason && typeof reason === 'object' ? reason : {};
  const candidates = [r.error, r.failure, r.message, r.text, r.reason];
  for (const candidate of candidates) {
    if (candidate === undefined || candidate === null) continue;
    if (typeof candidate === 'string') {
      const text = candidate.trim();
      if (text) return { code: '', message: text.slice(0, 300) };
      continue;
    }
    if (typeof candidate === 'object') {
      const code = String(candidate.code ?? candidate.name ?? '').trim();
      const message = String(candidate.message ?? candidate.text ?? '').trim();
      if (code || message) return { code, message: message.slice(0, 300) };
    }
  }
  return { code: '', message: '' };
}

/**
 * Decide whether a turn end deserves a QQ notice.
 *
 * Suppressed cases, each for a concrete reason:
 *  - `completed`                      — the normal path, the answer already went out.
 *  - user pressed /cancel on QQ       — `aborted` is the expected result and
 *                                       /cancel already sent its own receipt.
 *  - quiet transient error codes      — the host retries them; a notice would be
 *                                       a false alarm.
 *
 * @param {Object} options
 * @param {Object} options.reason      event.data.reason
 * @param {boolean} [options.qqCancelled] the user cancelled this turn from QQ
 * @returns {{notify:boolean, kind:string, label:string, icon:string, code:string, message:string, why:string}}
 */
export function describeTurnEnd({ reason, qqCancelled = false } = {}) {
  const r = reason && typeof reason === 'object' ? reason : {};
  const kind = String(r.kind ?? '').trim();
  const known = TURN_END_KINDS[kind];
  const { code, message } = summarizeTurnEndReason(r);

  const base = {
    kind,
    label: known?.label ?? '非正常结束',
    icon: known?.icon ?? '❔',
    code,
    message,
  };

  if (kind === 'completed') return { ...base, notify: false, why: 'completed' };

  if (qqCancelled) return { ...base, notify: false, why: 'qq-cancelled' };

  // Only a recognised transient code justifies staying quiet; an unknown kind
  // with no code stays visible on purpose.
  if (code && QUIET_ERROR_CODES.some((quiet) => code.toUpperCase().includes(quiet))) {
    return { ...base, notify: false, why: 'transient' };
  }

  if (!known) return { ...base, notify: true, why: 'unknown-kind' };

  return { ...base, notify: known.notify, why: 'kind' };
}

/** `HH:MM:SS` in local time, for "as of" lines. */
function clockOf(at) {
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString('zh-CN', { hour12: false });
}

/**
 * Render the QQ notice for an abnormal turn end.
 *
 * @param {Object} options
 * @param {Object} options.reason
 * @param {string} [options.sessionTitle]
 * @param {Object} [options.turn] last known turn state ({lastTool, lastToolAt, sawOutput, startedAt})
 * @param {number} [options.now]
 * @returns {string} markdown
 */
export function formatTurnEndNotice({ reason, sessionTitle = '', turn = {}, now = Date.now() } = {}) {
  const info = describeTurnEnd({ reason });
  const lines = [`${info.icon} **【轮次未正常结束】${info.label}**`];

  if (sessionTitle) lines.push(`> **会话**: ${sessionTitle}`);

  // Say what it was doing: the most useful fact when the user comes back later.
  if (turn.lastTool) {
    const ago = turn.lastToolAt ? Math.max(0, Math.round((now - turn.lastToolAt) / 1000)) : null;
    const when = ago === null ? '' : ago < 60 ? `（${ago} 秒前）` : `（${Math.round(ago / 60)} 分钟前）`;
    lines.push(`> **最后动作**: 调用工具 \`${turn.lastTool}\`${when}`);
  } else if (turn.startedAt) {
    lines.push(`> **最后动作**: 尚未调用工具（截止 ${clockOf(turn.startedAt)} 开始后）`);
  }

  if (info.code) lines.push(`> **错误码**: \`${info.code}\``);
  if (info.message) lines.push(`> **详情**: ${info.message}`);

  if (turn.sawOutput === false) {
    lines.push('', '本轮**没有产出任何内容**就结束了，QQ 端不会有正文气泡。');
  } else {
    lines.push('', '本轮在此之后没有更多的正文产出。');
  }

  // Recovery is just "send anything"; say so instead of implying a lost cause.
  lines.push('', '💡 直接发送任意消息即可**继续**（会开启新一轮），或点下方按钮查看当前状态。');

  return lines.join('\n');
}
