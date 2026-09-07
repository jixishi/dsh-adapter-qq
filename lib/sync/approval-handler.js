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

    // 1. Register as an answerer in the approval/request waterfall
    const approvalDisposer = this.ctx.on('approval/request', async (req, next) => {
      const sessionId = req.agent?.session?.id;
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
      const reason = req.reason || '该操作超出了当前权限级别，需确认授权。';
      const sessionTitle = req.agent?.session?.header?.title || sessionId;

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
    });
    this.disposers.push(approvalDisposer);

    // 2. Register as an answerer in the user-questions/request waterfall
    const questionDisposer = this.ctx.on('user-questions/request', async (req, next) => {
      const sessionId = req.agent?.session?.id;
      const activeSessionId = await this.sessionManager.getActiveSessionId();
      const userOpenid = this.getUserOpenid();

      if (!userOpenid || sessionId !== activeSessionId) {
        return next();
      }

      const q = req.questions?.[0];
      if (!q) return next();

      this.logger.info?.(`[ApprovalHandler] Received user question for session ${sessionId}: "${q.question}"`);

      const qId = q.id || randomUUID().slice(0, 8);
      let settled = false;

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

      const qqQuestionPromise = new Promise((resolve) => {
        this.pendingQuestions.set(qId, {
          id: qId,
          resolve,
          req,
          sessionId,
          abortController: localAbortController,
        });
      });

      const letters = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];
      const optionLines = (q.options || []).map((opt, idx) => {
        const letter = letters[idx] || String(idx + 1);
        const label = typeof opt === 'string' ? opt : opt.label || opt.name || `选项 ${letter}`;
        const desc = typeof opt === 'object' && opt.description ? ` *(${opt.description})*` : '';
        return `**${letter}.** ${label}${desc}`;
      });

      const lines = [
        '❓ **【DSH Agent 提问】**',
        q.header ? `> **主题**: ${q.header}` : '',
        `> **问题**: ${q.question}`,
        '',
        optionLines.length > 0 ? '📋 **可选项:**' : '',
        ...optionLines,
        '',
        '💡 请点击下方操作板字母选项，或直接在 DSH Web UI 中选择：',
      ].filter(Boolean);

      try {
        await this.apiClient.sendC2CMessage(userOpenid, {
          markdown: lines.join('\n'),
          keyboard: KeyboardBuilder.buildQuestionBoard(qId, q.options || []),
        });
      } catch (err) {
        this.logger.error?.(`[ApprovalHandler] Failed to send question card to QQ: ${err.message}`);
      }

      try {
        const raceResult = await Promise.race([
          qqQuestionPromise.then((answer) => ({ source: 'qq', outcome: answer })),
          next().then((answer) => ({ source: 'web', outcome: answer })),
          new Promise((resolve) => {
            if (originalSignal) {
              originalSignal.addEventListener('abort', () => resolve({ source: 'abort', outcome: null }), {
                once: true,
              });
            }
          }),
        ]);

        settled = true;
        this.pendingQuestions.delete(qId);

        if (raceResult.source === 'qq') {
          this.logger.info?.(`[ApprovalHandler] Question answered from QQ. Cancelling Web UI pending card...`);
          if (!localAbortController.signal.aborted) {
            localAbortController.abort(new Error('Question answered from QQ'));
          }
        } else if (raceResult.source === 'web' && raceResult.outcome) {
          const selectedText = raceResult.outcome.answers?.map((a) => a.selected?.join(', ')).join('; ') || '已回答';
          this.logger.info?.(`[ApprovalHandler] Question answered from Web UI: ${selectedText}`);
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
        settled = true;
        this.pendingQuestions.delete(qId);
        if (originalSignal) {
          originalSignal.removeEventListener('abort', onOriginalAbort);
        }
        req.signal = originalSignal;
      }
    });
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
   * Handle user question answer from QQ user
   * @param {string} questionId
   * @param {string} optionLabel
   * @returns {boolean} Whether question was found and settled
   */
  handleQuestionAnswer(questionId, optionLabel) {
    let targetEntry = null;
    if (!questionId && this.pendingQuestions.size === 1) {
      targetEntry = Array.from(this.pendingQuestions.values())[0];
    } else if (questionId) {
      targetEntry = this.pendingQuestions.get(questionId);
    }

    if (!targetEntry) {
      return false;
    }

    this.pendingQuestions.delete(targetEntry.id);

    const q = targetEntry.req.questions?.[0];
    const letters = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];
    let finalLabel = optionLabel;

    // If user clicked/replied with letter like 'A' or 'B'
    const trimmed = String(optionLabel || '').trim().toUpperCase();
    if (q?.options && letters.includes(trimmed)) {
      const idx = letters.indexOf(trimmed);
      if (q.options[idx]) {
        finalLabel = typeof q.options[idx] === 'string' ? q.options[idx] : q.options[idx].label || q.options[idx].name || finalLabel;
      }
    }

    const answer = {
      answers: [
        {
          id: q?.id || targetEntry.id,
          selected: [finalLabel],
        },
      ],
    };
    targetEntry.resolve(answer);
    return true;
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
