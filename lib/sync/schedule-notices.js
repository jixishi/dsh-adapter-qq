import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Per-task notification switches for the official scheduled tasks.
 *
 * The schedule service already knows how to fire a task and deliver a reminder
 * into its session; what it cannot do is tell a QQ user that the work finished.
 * This store holds the one decision that is ours: does the user want to be told
 * about this particular task?
 *
 * A task is enabled unless the user turned it off — the feature exists to inform,
 * and a silent default would look broken.
 */

const DEFAULT_ENABLED = true;

export class ScheduleNoticeStore {
  /**
   * @param {Object} options
   * @param {string} options.filePath - Under DSH_HOME so the choice survives restarts
   * @param {Object} [options.logger]
   * @param {Function} [options.now]
   */
  constructor({ filePath, logger = null, now = () => Date.now() }) {
    this.filePath = filePath;
    this.logger = logger;
    this.now = now;
    /** @type {Map<string, {enabled:boolean, title:string, sessionId:string, lastNotifiedAt:number, updatedAt:number}>} */
    this.tasks = new Map();
    /** Recently notified deliveries, so one firing is never announced twice. */
    this.recent = new Set();
  }

  /** @returns {{ok:boolean,count:number,reason?:string}} */
  load() {
    if (!this.filePath || !existsSync(this.filePath)) return { ok: true, count: 0 };
    try {
      const raw = JSON.parse(readFileSync(this.filePath, 'utf8'));
      const entries = raw?.tasks && typeof raw.tasks === 'object' ? raw.tasks : {};
      for (const [id, value] of Object.entries(entries)) {
        if (!id || !value || typeof value !== 'object') continue;
        this.tasks.set(id, {
          enabled: value.enabled !== false,
          title: String(value.title ?? ''),
          sessionId: String(value.sessionId ?? ''),
          lastNotifiedAt: Number(value.lastNotifiedAt) || 0,
          updatedAt: Number(value.updatedAt) || 0,
        });
      }
      return { ok: true, count: this.tasks.size };
    } catch (err) {
      this.logger?.warn?.(`[ScheduleNoticeStore] 无法读取（${this.filePath}）：${err?.message ?? err}`);
      this.tasks.clear();
      return { ok: false, count: 0, reason: err?.message ?? String(err) };
    }
  }

  /** Atomic save: temp file + rename. */
  save() {
    if (!this.filePath) return false;
    try {
      mkdirSync(dirname(this.filePath), { recursive: true });
      const payload = { version: 1, updatedAt: this.now(), tasks: Object.fromEntries(this.tasks) };
      const tmp = `${this.filePath}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8');
      renameSync(tmp, this.filePath);
      return true;
    } catch (err) {
      this.logger?.warn?.(`[ScheduleNoticeStore] 写入失败：${err?.message ?? err}`);
      return false;
    }
  }

  /**
   * Is this task's notification enabled?
   * @param {string} taskId
   * @returns {boolean}
   */
  isEnabled(taskId) {
    if (!taskId) return false;
    const entry = this.tasks.get(taskId);
    return entry ? entry.enabled !== false : DEFAULT_ENABLED;
  }

  /**
   * Remember a task's identity so the panel can list it even after it went
   * inactive, and flip its switch.
   * @param {string} taskId
   * @param {{ enabled?: boolean, title?: string, sessionId?: string }} [patch]
   */
  update(taskId, { enabled, title, sessionId } = {}) {
    if (!taskId) return null;
    const previous = this.tasks.get(taskId) || {
      enabled: DEFAULT_ENABLED,
      title: '',
      sessionId: '',
      lastNotifiedAt: 0,
      updatedAt: 0,
    };
    const next = {
      enabled: enabled === undefined ? previous.enabled : enabled !== false,
      title: title === undefined ? previous.title : String(title),
      sessionId: sessionId === undefined ? previous.sessionId : String(sessionId),
      lastNotifiedAt: previous.lastNotifiedAt,
      updatedAt: this.now(),
    };
    this.tasks.set(taskId, next);
    this.save();
    return { ...next };
  }

  /**
   * Record that a delivery was announced, and drop the dedupe key when the same
   * delivery is offered again — a recurring task can deliver a batch at once.
   * @param {string} taskId
   * @param {string} dedupeKey
   * @returns {boolean} whether this delivery is new
   */
  claim(taskId, dedupeKey) {
    if (!taskId) return false;
    if (dedupeKey && this.recent.has(dedupeKey)) return false;
    if (dedupeKey) {
      this.recent.add(dedupeKey);
      // The set only has to outlive one batch; cap it so a long-running host
      // cannot accumulate keys forever.
      if (this.recent.size > 500) {
        const first = this.recent.values().next().value;
        this.recent.delete(first);
      }
    }
    const entry = this.tasks.get(taskId) || {
      enabled: DEFAULT_ENABLED,
      title: '',
      sessionId: '',
      lastNotifiedAt: 0,
      updatedAt: 0,
    };
    entry.lastNotifiedAt = this.now();
    entry.updatedAt = this.now();
    this.tasks.set(taskId, entry);
    this.save();
    return true;
  }

  /** Forget a task that no longer exists in the schedule catalogue. */
  forget(taskId) {
    if (!taskId) return false;
    return this.tasks.delete(taskId);
  }

  /** Persisted view for the panel. */
  snapshot() {
    return [...this.tasks.entries()].map(([id, entry]) => ({ id, ...entry }));
  }
}

/**
 * Dedupe key for one task delivery: the same session at the same second is the
 * same firing, even if it arrives as several messages.
 * @param {string} sessionId
 * @param {number} at
 * @returns {string}
 */
export function deliveryKey(sessionId, at) {
  return `${sessionId}:${Math.floor(Number(at) / 1000)}`;
}
