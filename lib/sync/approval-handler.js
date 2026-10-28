import { randomUUID } from 'node:crypto';
import { KeyboardBuilder } from '../ui/keyboard.js';

/**
 * Approval & User Question Bridge between DSH and QQ Bot
 * Intercepts `approval/request` and `user-questions/request` waterfalls on Cordis.
 * Races QQ user decisions against Web UI decisions with mutual cancellation.
 */
export class ApprovalHandler {
  /**
   * @param {Object} options
   * @param {import('@deepseek-ai/cordis').Context} options.ctx - Cordis context
   * @param {import('../qq/client.js').QQApiClient} options.apiClient - QQ API client
   * @param {import('./session-manager.js').SessionManager} options.sessionManager - Session manager
   * @param {Function} options.getUserOpenid - Target user openid getter
   * @param {Object} [options.logger]
   */
  constructor({ ctx, apiClient, sessionManager, getUserOpenid, logger = console }) {
    this.ctx = ctx;
    this.apiClient = apiClient;
    this.sessionManager = sessionManager;
    this.getUserOpenid = getUserOpenid;
    this.logger = logger;

    /** @type {Map<string, { id: string, resolve: Function, req: Object, sessionId: string, abortController: AbortController }>} */
    this.pendingApprovals = new Map();
    /** @type {Map<string, { id: string, resolve: Function, req: Object, sessionId: string, abortController: AbortController }>} */
    this.pendingQuestions = new Map();
    this.disposers = [];
  }

  /**
   * Register the approval/request and user-questions/request waterfall listeners on Cordis
   */
  start() {
    this.stop();

    // 1. Register as an answerer in the approval/request waterfall.
    //    `prepend` matters: the Web-UI forwarder is a core answerer registered
    //    first and holds the waterfall until the browser answers, so a normally
    //    appended listener would never run. Running first lets us show the QQ
    //    card and then hand the same request to the Web UI via next() (race).
    const approvalDisposer = this.ctx.on('approval/request', async (req, next) => {
      // DSH 0.2.1-rc.3: ApprovalRequestEvent.agent is a bare Agent { id } (no session/header).
      const sessionId = req.agent?.id;
      const activeSessionId = await this.sessionManager.getActiveSessionId();
      const userOpenid = this.getUserOpenid();

      // If no QQ user configured or this approval is not for the active session, delegate immediately to next()
      if (!userOpenid || sessionId !== activeSessionId) {
        return next();
      }

      this.logger.info?.(`[ApprovalHandler] Received approval request for session ${sessionId}, tool: ${req.toolName}`);

      const approvalId = randomUUID().slice(0, 8);
      let settled = false;

      // Wrap req.signal with a local AbortController so QQ decision can cancel Web UI pending presentation
      const originalSignal = req.signal;
      const localAbortController = new AbortController();

      const onOriginalAbort = () => {
        if (!localAbortController.signal.aborted) {
          localAbortController.abort(originalSignal?.reason);
        }
      };

      if (originalSignal) {
        if (originalSignal.aborted) {
          localAbortController.abort(originalSignal.reason);
        } else {
          originalSignal.addEventListener('abort', onOriginalAbort, { once: true });
        }
      }

      req.signal = localAbortController.signal;

      // Promise for QQ user decision
      const qqDecisionPromise = new Promise((resolve) => {
        this.pendingApprovals.set(approvalId, {
          id: approvalId,
          resolve,
          req,
          sessionId,
          abortController: localAbortController,
        });
      });

      // Send approval notification card to QQ
      const toolName = req.toolName || '未知工具';
      const reason =
        req.reason ||
        req.displayReason?.zh ||
        req.displayReason?.['zh-CN'] ||
        req.displayReason?.en ||
        '该操作超出了当前权限级别，需确认授权。';
      const sessionTitle =
        (await this.sessionManager.getActiveSessionInfo?.())?.title || sessionId;

      const approvalCard = [
        '⚠️ **【DSH 权限审批请求】**',
        `> **会话**: ${sessionTitle}`,
        `> **工具**: \`${toolName}\``,
        `> **原因**: ${reason}`,
        '',
        '💡 您可以在下方操作板点击处理，或直接在 DSH Web UI 中审批：',
      ].join('\n');

      try {
        await this.apiClient.sendC2CMessage(userOpenid, {
          markdown: approvalCard,
          keyboard: KeyboardBuilder.buildApprovalBoard(approvalId),
        });
      } catch (err) {
        this.logger.error?.(`[ApprovalHandler] Failed to send approval card to QQ: ${err.message}`);
      }

      // Race QQ decision against Web UI decision (next())
      try {
        const raceResult = await Promise.race([
          qqDecisionPromise.then((decision) => ({ source: 'qq', outcome: decision })),
          next().then((outcome) => ({ source: 'web', outcome })),
          // Abort on original caller signal (e.g. model timeout or cancellation)
          new Promise((resolve) => {
            if (originalSignal) {
              originalSignal.addEventListener('abort', () => resolve({ source: 'abort', outcome: 'cancelled' }), {
                once: true,
              });
            }
          }),
        ]);

        settled = true;
        this.pendingApprovals.delete(approvalId);

        if (raceResult.source === 'qq') {
          this.logger.info?.(`[ApprovalHandler] Approval resolved from QQ: ${raceResult.outcome}. Cancelling Web UI pending card...`);
          if (!localAbortController.signal.aborted) {
            localAbortController.abort(new Error(`Settled by QQ user: ${raceResult.outcome}`));
          }
        } else if (raceResult.source === 'web') {
          // Web UI approved or rejected, notify QQ
          const isAllowed = raceResult.outcome === 'allowed-once';
          this.logger.info?.(`[ApprovalHandler] Approval resolved from Web UI: ${raceResult.outcome}`);
          try {
            await this.apiClient.sendC2CMessage(userOpenid, {
              content: `ℹ️ 【审批同步】已在 DSH Web UI 中完成处理: ${isAllowed ? '✅ 允许执行' : '❌ 已拒绝'}`,
            });
          } catch {
            // ignore
          }
        }

        return raceResult.outcome;
      } finally {
        settled = true;
        this.pendingApprovals.delete(approvalId);
        if (originalSignal) {
          originalSignal.removeEventListener('abort', onOriginalAbort);
        }
        req.signal = originalSignal;
      }
    }, true);
    this.disposers.push(approvalDisposer);

    // 2. Register as an answerer in the user-questions/request waterfall.
    //    DSH expects ONE answer item per question, so multi-question batches are
    //    presented as a short wizard and resolved only after every question is answered.
    const questionDisposer = this.ctx.on('user-questions/request', async (req, next) => {
      // DSH 0.2.1-rc.3: AskUserQuestionRequestEvent.agent is a bare Agent { id }.
      const sessionId = req.agent?.id;
      const activeSessionId = await this.sessionManager.getActiveSessionId();
      const userOpenid = this.getUserOpenid();

      if (!userOpenid || sessionId !== activeSessionId) {
        return next();
      }

      const questions = Array.isArray(req.questions) ? req.questions : [];
      if (questions.length === 0) return next();

      const originalSignal = req.signal;
      const localAbortController = new AbortController();
      const onOriginalAbort = () => {
        if (!localAbortController.signal.aborted) {
          localAbortController.abort(originalSignal?.reason);
        }
      };
      if (originalSignal) {
        if (originalSignal.aborted) {
          localAbortController.abort(originalSignal.reason);
        } else {
          originalSignal.addEventListener('abort', onOriginalAbort, { once: true });
        }
      }
      req.signal = localAbortController.signal;

      let resolveAnswer = () => {};
      const qqAnswerPromise = new Promise((resolve) => {
        resolveAnswer = resolve;
      });

      const entry = {
        id: randomUUID().slice(0, 8),
        req,
        sessionId,
        openid: userOpenid,
        questions,
        index: 0,
        selections: questions.map(() => []),
        cardMsgId: null,
        settled: false,
        resolve: resolveAnswer,
        abortController: localAbortController,
      };
      this.pendingQuestions.set(entry.id, entry);

      this.logger.info?.(
        `[ApprovalHandler] Received ${questions.length} user question(s) for session ${sessionId} (request ${entry.id})`
      );

      try {
        await this.renderQuestionCard(entry);

        const raceResult = await Promise.race([
          qqAnswerPromise.then((answer) => ({ source: 'qq', outcome: answer })),
          next().then((answer) => ({ source: 'web', outcome: answer })),
          new Promise((resolve) => {
            if (originalSignal) {
              originalSignal.addEventListener('abort', () => resolve({ source: 'abort', outcome: null }), {
                once: true,
              });
            }
          }),
        ]);

        entry.settled = true;
        this.pendingQuestions.delete(entry.id);

        if (raceResult.source === 'qq') {
          this.logger.info?.('[ApprovalHandler] Questions answered from QQ. Cancelling Web UI pending card...');
          if (!localAbortController.signal.aborted) {
            localAbortController.abort(new Error('Questions answered from QQ'));
          }
        } else if (raceResult.source === 'web' && raceResult.outcome) {
          const selectedText = raceResult.outcome.answers?.map((a) => a.selected?.join(', ')).join('; ') || '已回答';
          this.logger.info?.(`[ApprovalHandler] Questions answered from Web UI: ${selectedText}`);
          try {
            await this.apiClient.sendC2CMessage(userOpenid, {
              content: `ℹ️ 【提问同步】已在 DSH Web UI 中完成选择: ${selectedText}`,
            });
          } catch {
            // ignore
          }
        }

        return raceResult.outcome;
      } finally {
        entry.settled = true;
        this.pendingQuestions.delete(entry.id);
        if (originalSignal) {
          originalSignal.removeEventListener('abort', onOriginalAbort);
        }
        req.signal = originalSignal;
      }
    }, true);
    this.disposers.push(questionDisposer);

    this.logger.info?.('[ApprovalHandler] Approval and Question waterfall answerers registered.');
  }

  /**
   * Handle approval response command from QQ user
   * @param {string} approvalId
   * @param {'allowed-once'|'rejected'} decision
   * @returns {boolean} Whether approval was found and settled
   */
  handleUserDecision(approvalId, decision) {
    let targetEntry = null;
    if (!approvalId && this.pendingApprovals.size === 1) {
      targetEntry = Array.from(this.pendingApprovals.values())[0];
    } else if (approvalId) {
      targetEntry = this.pendingApprovals.get(approvalId);
    }

    if (!targetEntry) {
      return false;
    }

    this.pendingApprovals.delete(targetEntry.id);
    targetEntry.resolve(decision);
    return true;
  }

  /**
   * Find the pending question entry addressed by a button/command token.
   * Tokens may be the request id (stable across the wizard) or a question id.
   * @param {string} token
   * @returns {Object|null}
   */
  findQuestionEntry(token) {
    const key = String(token ?? '').trim();
    if (key && this.pendingQuestions.has(key)) return this.pendingQuestions.get(key);
    if (key) {
      for (const entry of this.pendingQuestions.values()) {
        if (entry.questions.some((q) => String(q?.id) === key)) return entry;
      }
      return null;
    }
    if (this.pendingQuestions.size === 1) return Array.from(this.pendingQuestions.values())[0];
    return null;
  }

  /**
   * Render (or re-render) the card for the entry's current question.
   * @param {Object} entry
   * @param {{ notice?: string }} [options]
   */
  async renderQuestionCard(entry, { notice } = {}) {
    const q = entry.questions[entry.index];
    if (!q) return;

    const total = entry.questions.length;
    const progress = total > 1 ? `（第 ${entry.index + 1}/${total} 题）` : '';
    const selected = entry.selections[entry.index] || [];
    const options = Array.isArray(q.options) ? q.options : [];
    const letters = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];

    const lines = [
      `❓ **【DSH Agent 提问】${progress}**`,
      q.header ? `> **主题**: ${q.header}` : '',
      `> **问题**: ${q.question}`,
      q.detail ? `> **说明**: ${q.detail}` : '',
      q.multiSelect ? `> **类型**: 多选（可点多个；选好后点【✅ 提交选择】，或回复 \`/answer ${entry.id} A,B\`）` : '',
      '',
    ].filter(Boolean);

    if (options.length > 0) {
      lines.push('📋 **可选项:**');
      options.forEach((opt, idx) => {
        const letter = letters[idx] || String(idx + 1);
        const label = typeof opt === 'string' ? opt : opt.label || opt.name || `选项 ${letter}`;
        const desc = typeof opt === 'object' && opt.description ? ` *(${opt.description})*` : '';
        const mark = selected.includes(label) ? ' ✅' : '';
        lines.push(`**${letter}.** ${label}${desc}${mark}`);
      });
    } else {
      lines.push(`💡 本题没有预设选项，请直接回复 \`/answer ${entry.id} 你的回答\`。`);
    }

    if (q.multiSelect) {
      lines.push('', `已选: ${selected.length > 0 ? selected.join('、') : '（尚未选择）'}`);
    } else {
      lines.push('', '💡 点击选项字母按钮即可作答，也可在 DSH Web UI 中选择。');
    }
    if (notice) lines.push('', `> ${notice}`);

    if (entry.cardMsgId && typeof this.apiClient?.recallC2CMessage === 'function') {
      void this.apiClient.recallC2CMessage(entry.openid || this.getUserOpenid(), entry.cardMsgId);
    }

    try {
      const res = await this.apiClient.sendC2CMessage(entry.openid || this.getUserOpenid(), {
        markdown: lines.join('\n'),
        keyboard: KeyboardBuilder.buildQuestionBoard(entry.id, options, {
          selected,
          multiSelect: q.multiSelect === true,
        }),
      });
      entry.cardMsgId = res?.id || null;
    } catch (err) {
      this.logger.error?.(`[ApprovalHandler] Failed to send question card to QQ: ${err.message}`);
    }
  }

  /**
   * Advance to the next question of the batch, or resolve the whole batch once
   * every question has an answer (DSH requires one answer item per question).
   * @param {Object} entry
   * @returns {Promise<{ok:boolean, kind:string, message?:string}>}
   */
  async completeCurrentQuestion(entry) {
    const total = entry.questions.length;
    entry.index += 1;

    if (entry.index >= total) {
      const answer = {
        answers: entry.questions.map((question, index) => ({
          id: question.id,
          selected: [...(entry.selections[index] || [])],
        })),
      };
      entry.settled = true;
      entry.resolve(answer);
      if (!entry.abortController.signal.aborted) {
        entry.abortController.abort(new Error('All questions answered from QQ'));
      }
      return { ok: true, kind: 'submitted', message: `✅ 已提交全部 ${total} 个问题的回答。` };
    }

    await this.renderQuestionCard(entry, {
      notice: `已提交第 ${entry.index} 题，请继续回答第 ${entry.index + 1}/${total} 题。`,
    });
    return {
      ok: true,
      kind: 'advanced',
      message: `✅ 已提交第 ${entry.index} 题，请继续回答第 ${entry.index + 1}/${total} 题。`,
    };
  }

  /**
   * Handle a user-question answer/toggle from QQ.
   *
   * Multi-question requests are a wizard: the card always addresses the current
   * question and the batch resolves only after the last one. Multi-select
   * questions toggle options and need an explicit submit.
   *
   * @param {string} questionId - request id (or question id)
   * @param {string} optionLabel - option label/letter, `__submit__`, `__clear__`,
   *   or a comma-separated list for multi-select
   * @returns {Promise<{ok:boolean, kind?:string, message?:string, error?:string}>}
   */
  async handleQuestionAnswer(questionId, optionLabel) {
    const entry = this.findQuestionEntry(questionId);
    if (!entry || entry.settled) {
      return { ok: false, error: '未找到对应的待回答问题（可能已被处理或已超时）。' };
    }

    const q = entry.questions[entry.index];
    const raw = String(optionLabel ?? '').trim();
    if (!q) return { ok: false, error: '当前问题状态异常，请重新提问。' };
    if (!raw) return { ok: false, error: '回答内容为空。' };

    const letters = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];
    const options = Array.isArray(q.options) ? q.options : [];

    if (raw === '__submit__') {
      const current = entry.selections[entry.index] || [];
      if (q.multiSelect && current.length === 0) {
        await this.renderQuestionCard(entry, { notice: '请先选择至少一个选项，再点【✅ 提交选择】。' });
        return { ok: true, kind: 'pending', message: '请先选择至少一个选项。' };
      }
      return this.completeCurrentQuestion(entry);
    }

    if (raw === '__clear__') {
      entry.selections[entry.index] = [];
      await this.renderQuestionCard(entry, { notice: '已清空本题选择。' });
      return { ok: true, kind: 'toggled', message: '已清空选择。' };
    }

    // Letters ("A", "A,B") map to option labels; anything else stays a literal label
    // (labels may contain spaces, so do not split arbitrary text).
    const letterListPattern = /^[A-Ha-h](?:\s*[,，、\s]\s*[A-Ha-h])*$/;
    let resolved;
    if (letterListPattern.test(raw)) {
      resolved = raw
        .split(/[,，、\s]+/)
        .filter(Boolean)
        .map((token) => {
          const opt = options[letters.indexOf(token.toUpperCase())];
          return opt === undefined ? token : typeof opt === 'string' ? opt : opt.label || opt.name || token;
        });
    } else if (q.multiSelect && /[,，、]/.test(raw)) {
      resolved = raw.split(/[,，、]+/).map((token) => token.trim()).filter(Boolean);
    } else {
      resolved = [raw];
    }
    if (resolved.length === 0) return { ok: false, error: '无法识别的回答。' };

    if (q.multiSelect) {
      if (resolved.length > 1) {
        entry.selections[entry.index] = resolved;
      } else {
        const current = entry.selections[entry.index] || [];
        const position = current.indexOf(resolved[0]);
        if (position >= 0) current.splice(position, 1);
        else current.push(resolved[0]);
        entry.selections[entry.index] = current;
      }
      await this.renderQuestionCard(entry);
      return { ok: true, kind: 'toggled', message: '已更新选择。' };
    }

    entry.selections[entry.index] = [resolved[0]];
    return this.completeCurrentQuestion(entry);
  }

  /**
   * Stop and cleanup
   */
  stop() {
    for (const d of this.disposers) {
      try {
        d();
      } catch {
        // ignore
      }
    }
    this.disposers = [];

    for (const entry of this.pendingApprovals.values()) {
      entry.resolve('cancelled');
    }
    this.pendingApprovals.clear();

    for (const entry of this.pendingQuestions.values()) {
      entry.resolve(null);
    }
    this.pendingQuestions.clear();
  }
}
