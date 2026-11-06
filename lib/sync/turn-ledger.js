import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * A minimal on-disk ledger of in-flight turns.
 *
 * Why it exists: when the DSH host restarts (or crashes, or reloads via HMR)
 * while a turn is running, that turn never emits a `turn/end`. The bridge's
 * in-memory `turnState` dies with the process, so the QQ user is left with a
 * stopped typing indicator and no explanation — the same "silent disconnect" the
 * live notice solves for a turn that ends *inside* one process.
 *
 * The ledger only has to answer one question at startup: "was a turn still
 * running the last time this plugin was alive, and did we already tell the user?"
 * So it stores the minimum: session, recipient, turn number, last tool, and the
 * boot that wrote it.
 *
 * Everything is best-effort: an unreadable or corrupt file degrades to "no
 * pending turns" rather than failing plugin startup, and a failed write is logged
 * and ignored (losing one recovery notice must never break a prompt).
 */

export const DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export class TurnLedger {
  /**
   * @param {Object} options
   * @param {string} options.filePath - Ledger location (under DSH_HOME)
   * @param {string} options.bootId - Identity of the running process
   * @param {Object} [options.logger]
   * @param {Function} [options.now] - Injectable clock for tests
   * @param {number} [options.maxAgeMs] - Entries older than this are discarded
   */
  constructor({ filePath, bootId, logger = null, now = () => Date.now(), maxAgeMs = DEFAULT_MAX_AGE_MS }) {
    this.filePath = filePath;
    this.bootId = String(bootId ?? '');
    this.logger = logger;
    this.now = now;
    this.maxAgeMs = maxAgeMs;
    /** @type {Map<string, {sessionId:string, userOpenid:string, turn:any, tool:string|null, bootId:string, updatedAt:number}>} */
    this.entries = new Map();
    this.shuttingDown = false;
    this.loaded = false;
  }

  /**
   * Read the ledger from disk. A missing file is normal (first run); a corrupt
   * one is reported and treated as empty.
   * @returns {{ ok: boolean, count: number, reason?: string }}
   */
  load() {
    this.loaded = true;
    if (!this.filePath || !existsSync(this.filePath)) return { ok: true, count: 0 };
    try {
      const raw = JSON.parse(readFileSync(this.filePath, 'utf8'));
      const list = Array.isArray(raw?.turns) ? raw.turns : [];
      for (const entry of list) {
        if (!entry || typeof entry.sessionId !== 'string' || !entry.sessionId) continue;
        this.entries.set(entry.sessionId, {
          sessionId: entry.sessionId,
          userOpenid: String(entry.userOpenid ?? ''),
          turn: entry.turn ?? null,
          tool: entry.tool ?? null,
          bootId: String(entry.bootId ?? ''),
          updatedAt: Number(entry.updatedAt) || 0,
        });
      }
      return { ok: true, count: this.entries.size };
    } catch (err) {
      this.logger?.warn?.(`[TurnLedger] 无法读取在途轮次账本（${this.filePath}）：${err?.message ?? err}`);
      this.entries.clear();
      return { ok: false, count: 0, reason: err?.message ?? String(err) };
    }
  }

  /** Persist the current entries atomically (temp file + rename). */
  save() {
    if (!this.filePath) return false;
    try {
      mkdirSync(dirname(this.filePath), { recursive: true });
      const payload = {
        version: 1,
        bootId: this.bootId,
        updatedAt: this.now(),
        turns: [...this.entries.values()],
      };
      const tmp = `${this.filePath}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8');
      renameSync(tmp, this.filePath);
      return true;
    } catch (err) {
      // Losing one recovery notice must never break a prompt.
      this.logger?.warn?.(`[TurnLedger] 写入在途轮次账本失败：${err?.message ?? err}`);
      return false;
    }
  }

  /**
   * Record (or refresh) a running turn.
   * @param {string} sessionId
   * @param {{ userOpenid?: string, turn?: any, tool?: string|null }} [info]
   */
  record(sessionId, { userOpenid = '', turn = null, tool = null } = {}) {
    if (!sessionId) return;
    const previous = this.entries.get(sessionId);
    // Only rewrite when something the notice would mention actually changed:
    // tool calls fire constantly and every write is a file rename.
    if (previous && previous.tool === tool && previous.turn === turn && previous.userOpenid === userOpenid) {
      previous.updatedAt = this.now();
      return;
    }
    this.entries.set(sessionId, {
      sessionId,
      userOpenid: String(userOpenid ?? ''),
      turn: turn ?? null,
      tool: tool ?? null,
      bootId: this.bootId,
      updatedAt: this.now(),
    });
    this.save();
  }

  /**
   * Drop a finished turn.
   *
   * Skipped entirely while shutting down: the `aborted (disposed)` that a process
   * exit produces must not erase the very entry the next boot needs to report.
   * @param {string} sessionId
   * @returns {boolean} whether anything was removed
   */
  clear(sessionId) {
    if (!sessionId || this.shuttingDown) return false;
    if (!this.entries.delete(sessionId)) return false;
    this.save();
    return true;
  }

  /** Mark the process as going away, so turn ends stop clearing entries. */
  markShuttingDown() {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    // Persist whatever is left as belonging to this boot; the next boot reports it.
    if (this.entries.size > 0) this.save();
  }

  /**
   * Turns left running by an *earlier* boot, newest first.
   *
   * Entries written by the current boot are excluded: the live notice handles
   * those. Anything older than `maxAgeMs` is dropped, because a day-old "still
   * running" claim is noise, not information.
   * @returns {Array<Object>}
   */
  pendingRecoveries() {
    const cutoff = this.now() - this.maxAgeMs;
    const pending = [];
    let dropped = 0;
    for (const entry of this.entries.values()) {
      if (entry.bootId === this.bootId) continue;
      if (!entry.userOpenid) continue; // nobody to tell
      if (!entry.updatedAt || entry.updatedAt < cutoff) {
        dropped += 1;
        this.entries.delete(entry.sessionId);
        continue;
      }
      pending.push({ ...entry });
    }
    if (dropped > 0) this.save();
    pending.sort((a, b) => b.updatedAt - a.updatedAt);
    return pending;
  }

  /**
   * Forget one reported turn so it is not announced twice.
   * @param {string} sessionId
   */
  consume(sessionId) {
    if (!sessionId) return;
    if (this.entries.delete(sessionId)) this.save();
  }

  /** Remove the file entirely (used by tests and by a full reset). */
  dispose() {
    // Entries belong to the next boot's report; only the in-memory view is dropped.
    this.entries.clear();
  }
}

/**
 * Build a boot identity for this process.
 *
 * Uniqueness matters more than readability: two boots of the same pid within the
 * same millisecond must not be treated as the same boot, or the recovery check
 * would think a leftover turn belongs to the current process and stay silent.
 * @returns {string} `<pid>-<start ms>-<random>`
 */
export function currentBootId() {
  return `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

