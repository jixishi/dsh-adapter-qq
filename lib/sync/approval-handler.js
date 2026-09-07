import { randomUUID } from 'node:crypto';
import { KeyboardBuilder } from '../ui/keyboard.js';

/**
 * Approval Bridge between DSH Approval System and QQ Bot
 * Intercepts `approval/request` waterfall on Cordis and races QQ decisions against Web UI decisions.
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

    /** @type {Map<string, { id: string, resolve: Function, req: Object, sessionId: string }>} */
    this.pendingApprovals = new Map();
    this.disposer = null;
  }

  /**
   * Register the approval/request waterfall listener on Cordis
   */
  start() {
    this.stop();

    // Register as an answerer in the approval/request waterfall
    this.disposer = this.ctx.on('approval/request', async (req, next) => {
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
          localAbortController.abort(originalSignal.reason);
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
          // Abort local signal so API gateway forwards cancellation to Web UI
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

    this.logger.info?.('[ApprovalHandler] Approval waterfall answerer registered.');
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
   * Stop and cleanup
   */
  stop() {
    if (this.disposer) {
      this.disposer();
      this.disposer = null;
    }
    for (const entry of this.pendingApprovals.values()) {
      entry.resolve('cancelled');
    }
    this.pendingApprovals.clear();
  }
}
