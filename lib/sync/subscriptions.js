/**
 * Session subscriptions with coalesced background notifications.
 *
 * Purpose: let the user follow sessions that are NOT the active one. When a
 * subscribed session produces new assistant output, the message is buffered and
 * flushed to QQ only every N minutes, merged into one summary — so following ten
 * sessions does not turn into ten pushes per minute.
 *
 * Design notes
 * ------------
 * - Pure state machine + storage; the bridge owns the QQ I/O. Everything here is
 *   injectable (clock, send) so it is unit-testable without a network or timers.
 * - One timer per subscription interval *bucket*, not per session: sessions
 *   sharing "every 5 min" are flushed by the same tick, which keeps the number
 *   of timers bounded no matter how many sessions are followed.
 * - Flush timing is a leading-edge suppression window: the first message starts
 *   the window, everything arriving inside it is collected, and the window closes
 *   at `intervalMs` after the first message. An empty window never fires.
 * - State is persisted atomically (tmp + rename) so a crash cannot leave half a
 *   JSON document; a corrupt file degrades to "no subscriptions" rather than
 *   breaking plugin startup.
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { formatDueIn } from './display-time.js';

/** Intervals offered in the UI. Order matters: it is the dropdown order. */
export const SUBSCRIPTION_INTERVALS = Object.freeze([1, 5, 15, 30, 60]);
export const DEFAULT_INTERVAL_MINUTES = 5;

/** Hard bounds so a hand-edited store file cannot spawn absurd timers. */
const MIN_INTERVAL_MS = 60 * 1000;
const MAX_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** How many buffered messages are kept per session (older ones are summarised). */
const MAX_BUFFERED_PER_SESSION = 40;
/** Preview length for one buffered message inside the digest. */
const PREVIEW_CHARS = 280;

/**
 * @typedef {Object} Subscription
 * @property {string} sessionId
 * @property {string} title
 * @property {number} intervalMinutes
 * @property {number} createdAt
 * @property {number} lastNotifiedAt
 * @property {number} totalNotified
 */

/**
 * @typedef {Object} BufferedMessage
 * @property {string} text
 * @property {number} at
 * @property {string} kind  'assistant' | 'question' | 'tool'
 */

/**
 * Normalise an interval in minutes to a supported value.
 * Unknown values snap to the nearest allowed bucket so the UI never shows a
 * value it cannot render, and hand-edited files stay usable.
 * @param {unknown} value
 * @returns {number}
 */
export function normalizeIntervalMinutes(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return DEFAULT_INTERVAL_MINUTES;
  if (SUBSCRIPTION_INTERVALS.includes(number)) return number;
  // Snap to the closest supported interval.
  let best = SUBSCRIPTION_INTERVALS[0];
  let bestDelta = Math.abs(number - best);
  for (const candidate of SUBSCRIPTION_INTERVALS) {
    const delta = Math.abs(number - candidate);
    if (delta < bestDelta) {
      best = candidate;
      bestDelta = delta;
    }
  }
  return best;
}

/** Clamp an interval to the timer-safe range (ms). */
function intervalMsOf(intervalMinutes) {
  const minutes = normalizeIntervalMinutes(intervalMinutes);
  return Math.min(MAX_INTERVAL_MS, Math.max(MIN_INTERVAL_MS, minutes * 60 * 1000));
}

/** Human label for an interval, used in menus and digests. */
export function intervalLabel(minutes) {
  const value = normalizeIntervalMinutes(minutes);
  if (value >= 60) return `${value / 60} 小时`;
  return `${value} 分钟`;
}

/**
 * Collapse whitespace and cut a message down to a digest-friendly preview.
 * @param {string} text
 * @param {number} [max]
 * @returns {string}
 */
export function previewMessage(text, max = PREVIEW_CHARS) {
  const flat = String(text ?? '')
    .replace(/<think>[\s\S]*?<\/think>/g, '')
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (flat.length <= max) return flat;
  return `${flat.slice(0, max)}…`;
}

/**
 * Build the digest pushed to QQ for one session's buffered messages.
 *
 * Kept pure so tests can pin the exact wording; the caller adds the keyboard.
 * @param {Object} options
 * @param {string} options.title
 * @param {string} options.sessionId
 * @param {BufferedMessage[]} options.messages
 * @param {number} [options.intervalMinutes]
 * @param {number} [options.now]
 * @returns {{markdown:string, count:number, dropped:number}}
 */
export function buildSubscriptionDigest({
  title = '',
  sessionId = '',
  messages = [],
  intervalMinutes = DEFAULT_INTERVAL_MINUTES,
  now = Date.now(),
} = {}) {
  const list = Array.isArray(messages) ? messages : [];
  const count = list.length;
  const totalChars = list.reduce((sum, item) => sum + String(item?.text || '').length, 0);
  const first = list[0]?.at ?? now;
  const last = list[list.length - 1]?.at ?? now;
  const spanMinutes = Math.max(0, Math.round((last - first) / 60000));
  const label = String(title || '').trim() || `会话 ${sessionId.slice(0, 8)}`;

  const windowText =
    spanMinutes >= 1 ? `跨 ${spanMinutes} 分钟` : `同一分钟内`;
  const header = [
    `🔔 **【订阅会话有新消息】**`,
    '',
    `> **会话**: ${label}`,
    `> **会话 ID**: \`${sessionId}\``,
    `> **新增**: ${count} 条 · ${windowText} · 汇聚间隔 ${intervalLabel(intervalMinutes)}`,
  ];

  // Short digest: show up to 5 previews; long ones keep the first 3 and the last 2
  // so the reader sees both the beginning and where it ended up.
  const PREVIEWS = 5;
  let shown = list;
  let elided = 0;
  if (list.length > PREVIEWS) {
    shown = [...list.slice(0, 3), ...list.slice(-2)];
    elided = list.length - PREVIEWS;
  }

  const body = [];
  let index = 0;
  for (const item of shown) {
    index += 1;
    if (elided > 0 && index === 4) {
      body.push(`> … 省略 ${elided} 条 …`);
      body.push('');
    }
    const stamp = new Date(item?.at ?? now).toLocaleTimeString('zh-CN', { hour12: false });
    const tag = item?.kind === 'question' ? '❓' : item?.kind === 'tool' ? '🔧' : '💬';
    body.push(`**${index}.** ${tag} \`${stamp}\` ${previewMessage(item?.text)}`);
    body.push('');
  }

  const footer = [
    `---`,
    `💬 回复本消息即可直接与 **${label}** 对话（无需切换当前会话）。`,
    `🛑 发送 \`/unsubscribe\` 可取消该会话订阅，或 \`/subscriptions\` 查看全部。`,
  ];

  return {
    markdown: [...header, '', ...body, ...footer].join('\n'),
    count,
    totalChars,
    dropped: 0,
    firstAt: first,
    lastAt: last,
  };
}

/**
 * Subscription store: persistence + the coalescing buffers.
 *
 * The store never sends anything by itself; `flushDue()` returns the digests it
 * would emit and the caller delivers them. That keeps all QQ I/O in the bridge
 * and makes the timing logic testable with a fake clock.
 */
export class SubscriptionStore {
  /**
   * @param {Object} options
   * @param {string} [options.filePath] absolute path of the JSON store
   * @param {() => number} [options.now]
   * @param {Object} [options.logger]
   */
  constructor({ filePath = '', now = () => Date.now(), logger = console } = {}) {
    this.filePath = filePath;
    this.now = now;
    this.logger = logger;
    /** @type {Map<string, Subscription>} */
    this.subscriptions = new Map();
    /** @type {Map<string, {messages: BufferedMessage[], startedAt: number}>} */
    this.buffers = new Map();
    /** @type {Map<number, {timer: any, at: number}>} */
    this.timers = new Map();
    this.loaded = false;
  }

  /** Read the store from disk. Corrupt data degrades to an empty store. */
  load() {
    this.loaded = true;
    if (!this.filePath) return { ok: false, reason: 'no-path' };
    let raw;
    try {
      raw = fs.readFileSync(this.filePath, 'utf8');
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        this.logger.warn?.(`[adapter-qq] 订阅存储读取失败：${error.message}`);
      }
      return { ok: false, reason: error?.code === 'ENOENT' ? 'missing' : 'unreadable' };
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      // Never throw on startup: a truncated file must not take the plugin down.
      this.logger.warn?.(`[adapter-qq] 订阅存储不是合法 JSON，已忽略：${error.message}`);
      return { ok: false, reason: 'bad-json' };
    }

    const items = Array.isArray(parsed?.subscriptions) ? parsed.subscriptions : [];
    for (const item of items) {
      const sessionId = String(item?.sessionId || '').trim();
      if (!sessionId) continue;
      this.subscriptions.set(sessionId, {
        sessionId,
        title: String(item?.title || ''),
        intervalMinutes: normalizeIntervalMinutes(item?.intervalMinutes),
        createdAt: Number(item?.createdAt) || this.now(),
        lastNotifiedAt: Number(item?.lastNotifiedAt) || 0,
        totalNotified: Number(item?.totalNotified) || 0,
      });
    }
    return { ok: true, count: this.subscriptions.size };
  }

  /** Atomic save: write a temp file in the same directory, then rename. */
  async save() {
    if (!this.filePath) return false;
    const payload = {
      version: 1,
      savedAt: this.now(),
      subscriptions: [...this.subscriptions.values()].sort(
        (a, b) => a.createdAt - b.createdAt
      ),
    };
    const dir = path.dirname(this.filePath);
    const tmp = `${this.filePath}.${process.pid}.tmp`;
    try {
      await fsp.mkdir(dir, { recursive: true });
      await fsp.writeFile(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
      await fsp.rename(tmp, this.filePath);
      return true;
    } catch (error) {
      this.logger.warn?.(`[adapter-qq] 订阅存储写入失败：${error.message}`);
      await fsp.rm(tmp, { force: true }).catch(() => {});
      return false;
    }
  }

  /** @returns {Subscription|undefined} */
  get(sessionId) {
    return this.subscriptions.get(String(sessionId || ''));
  }

  /** True when this session should produce background notifications. */
  has(sessionId) {
    return this.subscriptions.has(String(sessionId || ''));
  }

  /** All subscriptions, oldest first. */
  list() {
    return [...this.subscriptions.values()].sort((a, b) => a.createdAt - b.createdAt);
  }

  /**
   * Subscribe (or update) a session.
   * Re-subscribing an existing session keeps `createdAt` and updates the rest,
   * so the UI can use this call for interval edits too.
   * @returns {Promise<Subscription>}
   */
  async subscribe({ sessionId, title = '', intervalMinutes = DEFAULT_INTERVAL_MINUTES } = {}) {
    const id = String(sessionId || '').trim();
    if (!id) throw new Error('sessionId 不能为空');
    const existing = this.subscriptions.get(id);
    const subscription = {
      sessionId: id,
      title: String(title || existing?.title || ''),
      intervalMinutes: normalizeIntervalMinutes(intervalMinutes),
      createdAt: existing?.createdAt ?? this.now(),
      lastNotifiedAt: existing?.lastNotifiedAt ?? 0,
      totalNotified: existing?.totalNotified ?? 0,
    };
    this.subscriptions.set(id, subscription);
    await this.save();
    return subscription;
  }

  /** @returns {Promise<boolean>} whether anything was removed */
  async unsubscribe(sessionId) {
    const id = String(sessionId || '');
    if (!this.subscriptions.delete(id)) return false;
    // Drop the pending buffer too: a removed subscription must not keep a timer
    // alive or leak the next digest.
    this.buffers.delete(id);
    await this.save();
    return true;
  }

  /** Update the coalescing interval of one subscription. */
  async setIntervalMinutes(sessionId, intervalMinutes) {
    const subscription = this.subscriptions.get(String(sessionId || ''));
    if (!subscription) return null;
    subscription.intervalMinutes = normalizeIntervalMinutes(intervalMinutes);
    await this.save();
    return subscription;
  }

  /** Remember the session title (kept fresh by the bridge). */
  async rememberTitle(sessionId, title) {
    const subscription = this.subscriptions.get(String(sessionId || ''));
    if (!subscription || !title || subscription.title === title) return false;
    subscription.title = String(title);
    await this.save();
    return true;
  }

  /**
   * Queue one background message for a subscribed session.
   *
   * Returns the buffer state so the caller can decide whether to arm a timer;
   * `startedAt` is set on the first message of a window and never moves, which
   * makes the flush deadline stable even under a continuous stream of messages.
   *
   * @returns {{queued:boolean, count:number, startedAt:number, intervalMs:number}}
   */
  enqueue(sessionId, message) {
    const id = String(sessionId || '');
    const subscription = this.subscriptions.get(id);
    if (!subscription) return { queued: false, count: 0, startedAt: 0, intervalMs: 0 };

    const text = String(message?.text || '').trim();
    if (!text) return { queued: false, count: 0, startedAt: 0, intervalMs: 0 };

    let buffer = this.buffers.get(id);
    if (!buffer) {
      buffer = { messages: [], startedAt: this.now() };
      this.buffers.set(id, buffer);
    }
    buffer.messages.push({
      text,
      at: Number(message?.at) || this.now(),
      kind: message?.kind === 'question' ? 'question' : message?.kind === 'tool' ? 'tool' : 'assistant',
    });
    // Bound the memory: dropping the oldest keeps the newest context, which is
    // what a late reader cares about.
    if (buffer.messages.length > MAX_BUFFERED_PER_SESSION) {
      buffer.messages.splice(0, buffer.messages.length - MAX_BUFFERED_PER_SESSION);
    }

    return {
      queued: true,
      count: buffer.messages.length,
      startedAt: buffer.startedAt,
      intervalMs: intervalMsOf(subscription.intervalMinutes),
    };
  }

  /** Milliseconds until this session's next flush, or -1 when nothing is buffered. */
  dueInMs(sessionId) {
    const id = String(sessionId || '');
    const buffer = this.buffers.get(id);
    const subscription = this.subscriptions.get(id);
    if (!buffer || !subscription) return -1;
    return Math.max(0, buffer.startedAt + intervalMsOf(subscription.intervalMinutes) - this.now());
  }

  /** Sessions whose window has closed and should be flushed now. */
  dueSessionIds() {
    const due = [];
    for (const [id, buffer] of this.buffers) {
      const subscription = this.subscriptions.get(id);
      if (!subscription) {
        // Subscription vanished while messages were buffered: drop silently.
        this.buffers.delete(id);
        continue;
      }
      if (this.now() >= buffer.startedAt + intervalMsOf(subscription.intervalMinutes)) {
        due.push(id);
      }
    }
    return due;
  }

  /**
   * Take the buffered messages of one session and reset its window.
   * @returns {{subscription:Subscription, messages:BufferedMessage[]}|null}
   */
  take(sessionId) {
    const id = String(sessionId || '');
    const buffer = this.buffers.get(id);
    const subscription = this.subscriptions.get(id);
    if (!buffer || !subscription || buffer.messages.length === 0) {
      this.buffers.delete(id);
      return null;
    }
    const messages = buffer.messages.slice();
    this.buffers.delete(id);
    subscription.lastNotifiedAt = this.now();
    subscription.totalNotified += messages.length;
    return { subscription, messages };
  }

  /** Build (but do not send) the digest for one session. */
  digestFor(sessionId) {
    const taken = this.take(sessionId);
    if (!taken) return null;
    const digest = buildSubscriptionDigest({
      title: taken.subscription.title,
      sessionId: taken.subscription.sessionId,
      messages: taken.messages,
      intervalMinutes: taken.subscription.intervalMinutes,
      now: this.now(),
    });
    return { ...digest, subscription: taken.subscription };
  }

  /** Number of buffered messages across every subscription. */
  pendingCount() {
    let total = 0;
    for (const buffer of this.buffers.values()) total += buffer.messages.length;
    return total;
  }

  /** Drop every timer (called on plugin stop). */
  dispose() {
    for (const entry of this.timers.values()) {
      if (entry?.timer) clearTimeout(entry.timer);
    }
    this.timers.clear();
    this.buffers.clear();
  }

  /**
   * Snapshot for the sidebar panel / HTTP API.
   * @returns {{subscriptions:Array, intervals:number[], defaultInterval:number, pending:number}}
   */
  snapshot() {
    return {
      subscriptions: this.list().map((subscription) => {
        const buffer = this.buffers.get(subscription.sessionId);
        const dueInMs = this.dueInMs(subscription.sessionId);
        return {
          ...subscription,
          intervalLabel: intervalLabel(subscription.intervalMinutes),
          pendingCount: buffer?.messages.length ?? 0,
          dueInMs,
          // Human-readable countdown for the pane; '' when nothing is buffered.
          dueInLabel: formatDueIn(dueInMs),
        };
      }),
      intervals: [...SUBSCRIPTION_INTERVALS],
      defaultInterval: DEFAULT_INTERVAL_MINUTES,
      pending: this.pendingCount(),
    };
  }
}

/**
 * Timer scheduler that maps "next flush deadline" to a single setTimeout.
 *
 * Why not one timer per session: fifty subscriptions would mean fifty timers and
 * fifty wake-ups. Instead we keep exactly one armed timer for the earliest
 * deadline and re-arm after each flush.
 */
export class SubscriptionScheduler {
  /**
   * @param {Object} options
   * @param {SubscriptionStore} options.store
   * @param {(sessionId:string, digest:Object) => Promise<void>} options.flush
   * @param {() => number} [options.now]
   * @param {Object} [options.logger]
   */
  constructor({ store, flush, now = () => Date.now(), logger = console } = {}) {
    this.store = store;
    this.flush = flush;
    // The scheduler must judge deadlines with the SAME clock the store stamped
    // `startedAt` with. Two different clocks silently never agree, and the
    // window then never closes; so the store's clock wins when it has one.
    this.now = typeof store?.now === 'function' ? store.now : now;
    this.logger = logger;
    this.timer = null;
    this.armedFor = 0;
    this.stopped = false;
  }

  /**
   * Recompute the earliest deadline and arm the timer for it.
   * Safe to call on every enqueue: when the deadline has not moved the existing
   * timer is kept, so a busy session does not keep pushing the flush back.
   */
  arm() {
    if (this.stopped) return;
    const deadlines = [];
    for (const [id, buffer] of this.store.buffers) {
      const subscription = this.store.get(id);
      if (!subscription) continue;
      const minutes = normalizeIntervalMinutes(subscription.intervalMinutes);
      const intervalMs = Math.min(MAX_INTERVAL_MS, Math.max(MIN_INTERVAL_MS, minutes * 60 * 1000));
      deadlines.push(buffer.startedAt + intervalMs);
    }
    if (deadlines.length === 0) {
      if (this.timer) {
        clearTimeout(this.timer);
        this.timer = null;
        this.armedFor = 0;
      }
      return;
    }
    const next = Math.min(...deadlines);
    if (this.timer && this.armedFor === next) return;

    if (this.timer) clearTimeout(this.timer);
    this.armedFor = next;
    const delay = Math.max(0, next - this.now());
    this.timer = setTimeout(() => {
      this.timer = null;
      this.armedFor = 0;
      void this.runDue();
    }, delay);
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  /** Flush every session whose window closed, then re-arm. */
  async runDue() {
    if (this.stopped) return [];
    return this.flushSessions(this.store.dueSessionIds());
  }

  /**
   * Flush now, ignoring the coalescing window.
   *
   * This is what the "立即推送" button and `/flush` mean: the user explicitly
   * asked for the buffered messages, so waiting for the interval would make the
   * action a no-op. Sessions with an empty buffer are skipped.
   *
   * @returns {Promise<string[]>} session ids that were delivered
   */
  async flushAll() {
    if (this.stopped) return [];
    const pending = [];
    for (const [sessionId, buffer] of this.store.buffers) {
      if (buffer && buffer.messages.length > 0) pending.push(sessionId);
    }
    return this.flushSessions(pending);
  }

  /**
   * Deliver the given sessions' buffers and re-arm the scheduler.
   * @param {string[]} sessionIds
   * @returns {Promise<string[]>}
   */
  async flushSessions(sessionIds) {
    if (this.stopped) return [];
    const flushed = [];
    for (const sessionId of Array.isArray(sessionIds) ? sessionIds : []) {
      const digest = this.store.digestFor(sessionId);
      if (!digest) continue;
      try {
        await this.flush(sessionId, digest);
        flushed.push(sessionId);
      } catch (error) {
        this.logger.warn?.(`[adapter-qq] 订阅通知发送失败（${sessionId}）：${error.message}`);
      }
    }
    await this.store.save();
    this.arm();
    return flushed;
  }

  stop() {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
