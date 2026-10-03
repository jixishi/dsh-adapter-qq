import { randomUUID } from 'node:crypto';
import { KeyboardBuilder } from '../ui/keyboard.js';

/** Letters offered on one question's action board, in option order. */
const QUESTION_LETTERS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];

/** Replies that mean "explicitly skip this question" rather than free-form text. */
const SKIP_TOKENS = new Set(['-', '--', 'skip', '跳过', '不回答']);

/**
 * Approval & User Question Bridge between DSH and QQ Bot
 * Intercepts `approval/request` and `user-questions/request` waterfalls on Cordis.
 * Races QQ user decisions against Web UI decisions with mutual cancellation.
 *
 * One `user-questions/request` call may carry several questions, and the harness
 * reads the returned batch as complete: the tool result is handed to the model
 * verbatim, and only the *continued* reply path validates that the batch names
 * every question exactly once. So a call is presented as one card per question
 * and settles only once every question has been answered.
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
    /**
     * One entry per in-flight `user-questions/request` call, keyed by a per-call
     * id. A call's N questions must all be answered before its waterfall may
     * settle, so the call — not the individual question — is the unit of
     * bookkeeping; `answers` holds the questions answered so far, by question id.
     * @type {Map<string, { id: string, questions: Array<Object>, answers: Map<number, { selected: string[], custom?: string }>, resolve: Function|null, req: Object, sessionId: string, abortController: AbortController }>}
     */
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

      const questions = this.normalizeQuestions(req.questions);
      if (questions.length === 0) return next();

      this.logger.info?.(
        `[ApprovalHandler] Received ${questions.length} user question(s) for session ${sessionId}: "${questions[0].question}"`
      );

      const callId = `qcall_${randomUUID().slice(0, 8)}`;
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

      const entry = {
        id: callId,
        userOpenid,
        questions,
        hasList: questions.length > 1,
        // Answers are keyed by question *position*, not by question id: the
        // harness only enforces id uniqueness for the timed tool variant, so two
        // questions may share an id, and id-keyed state would then deadlock the
        // call on a duplicate that can never be answered.
        answers: new Map(),
        lastRecorded: null,
        listCardMsgId: null,
        openIndex: null,
        openCardMsgId: null,
        resolve: null,
        req,
        sessionId,
        abortController: localAbortController,
      };

      const qqQuestionPromise = new Promise((resolve) => {
        entry.resolve = resolve;
        this.pendingQuestions.set(callId, entry);
      });

      // The list card is the call's navigation surface and stays on screen until
      // every question is answered; the open question card is its only companion.
      // A single-question call has nothing to navigate and opens directly.
      let cardsDelivered = 0;
      try {
        cardsDelivered = await this.presentCall(entry);
      } catch (err) {
        this.logger.error?.(`[ApprovalHandler] Failed to present the question cards to QQ: ${err.message}`);
      }

      try {
        // A downstream rejection is not a decision. The forwarded waterfall
        // rejects once the Web UI side stops answering for this request: the
        // Client delegates it, its countdown runs out, or it disconnects — with
        // no Client at all the request is simply parked until one attaches. That
        // rejection is therefore parked too, rather than allowed to settle the
        // race, which would kill the QQ card before the user could tap it.
        //
        // Parking is only sound while the QQ card actually reached the user and
        // the caller's signal can still bound the wait; otherwise the request
        // must fail the way it did before this listener existed.
        const webAnswer = next()
          .then((answer) => ({ source: 'web', outcome: answer }))
          .catch((error) => {
            this.logger.warn?.(
              `[ApprovalHandler] Web UI answerer did not serve the question request (${error?.message ?? error}); waiting for the QQ answer instead.`
            );
            if (!originalSignal || cardsDelivered === 0) throw error;
            return new Promise(() => {});
          });

        const raceResult = await Promise.race([
          qqQuestionPromise.then((answer) => ({ source: 'qq', outcome: answer })),
          webAnswer,
          new Promise((resolve) => {
            if (!originalSignal) return;
            if (originalSignal.aborted) {
              resolve({ source: 'abort' });
              return;
            }
            originalSignal.addEventListener('abort', () => resolve({ source: 'abort' }), { once: true });
          }),
        ]);

        this.pendingQuestions.delete(callId);

        if (raceResult.source === 'abort') {
          // Nothing can answer this call from QQ any more, so its cards must not
          // stay behind with live-looking buttons. Then propagate the caller's own
          // cancellation: the harness maps its ASK_TIMED_OUT / abort reasons to the
          // pending result and to turn cancellation, so returning a value here
          // would fake an answer.
          await this.recallCards(entry);
          throw originalSignal?.reason ?? new Error('user question cancelled');
        }

        if (raceResult.source === 'qq') {
          this.logger.info?.(
            `[ApprovalHandler] All ${questions.length} question(s) answered from QQ `
              + `(${raceResult.outcome?.answers?.length ?? 0} answer item(s)). Cancelling Web UI pending card...`
          );
          if (!localAbortController.signal.aborted) {
            localAbortController.abort(new Error('Questions answered from QQ'));
          }
        } else if (raceResult.source === 'web' && raceResult.outcome) {
          // Answered in the browser: the QQ cards are stale, so drop them before
          // announcing the outcome.
          await this.recallCards(entry);
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
        this.pendingQuestions.delete(callId);
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
   * Put a call's first card on screen: the list for a multi-question call, or
   * the single question directly when there is nothing to navigate.
   * @param {Object} entry - Pending question call
   * @returns {Promise<number>} How many cards the QQ API accepted
   */
  async presentCall(entry) {
    return entry.hasList ? this.sendQuestionList(entry) : this.openQuestion(entry, 0);
  }

  /**
   * Send (or re-send) a call's question list — the navigation card that stays on
   * screen until every question is answered. A single-question call has no list,
   * so this is a no-op for it.
   *
   * QQ exposes no message-edit endpoint, so "updating" the list means recalling
   * the previous copy and sending the new one, exactly like the `/new` wizard.
   * @param {Object} entry - Pending question call
   * @returns {Promise<number>} How many cards the QQ API accepted
   */
  async sendQuestionList(entry) {
    if (!entry.hasList) return 0;

    await this.recallCard(entry, 'list');
    try {
      const sent = await this.apiClient.sendC2CMessage(entry.userOpenid, this.buildQuestionListCard(entry));
      entry.listCardMsgId = sent?.id ?? null;
      return entry.listCardMsgId ? 1 : 0;
    } catch (err) {
      this.logger.error?.(`[ApprovalHandler] Failed to send the question list card to QQ: ${err.message}`);
      entry.listCardMsgId = null;
      return 0;
    }
  }

  /**
   * Open one question: recall whichever question card was open, then send this
   * question's card and its option board. Together with the list this is the
   * second — and last — card on screen.
   * @param {Object} entry - Pending question call
   * @param {number} index - Question position within the call
   * @returns {Promise<number>} How many cards the QQ API accepted
   */
  async openQuestion(entry, index) {
    const question = entry.questions[index];
    if (question === undefined) return 0;

    await this.recallCard(entry, 'open');

    try {
      const sent = await this.apiClient.sendC2CMessage(entry.userOpenid, this.buildQuestionCard(entry, index));
      entry.openIndex = index;
      entry.openCardMsgId = sent?.id ?? null;
      return entry.openCardMsgId ? 1 : 0;
    } catch (err) {
      this.logger.error?.(
        `[ApprovalHandler] Failed to send question card ${index + 1}/${entry.questions.length} to QQ: ${err.message}`
      );
      entry.openIndex = null;
      entry.openCardMsgId = null;
      return 0;
    }
  }

  /**
   * Recall one tracked card and forget its id.
   * @param {Object} entry - Pending question call
   * @param {'list'|'open'} role - Which card to recall
   * @returns {Promise<void>}
   */
  async recallCard(entry, role) {
    const key = role === 'list' ? 'listCardMsgId' : 'openCardMsgId';
    const messageId = entry[key];
    if (role === 'open') entry.openIndex = null;
    entry[key] = null;
    if (!messageId) return;
    if (typeof this.apiClient?.recallC2CMessage !== 'function') return;
    try {
      await this.apiClient.recallC2CMessage(entry.userOpenid, messageId);
    } catch (err) {
      this.logger.warn?.(`[ApprovalHandler] Failed to recall the ${role} question card: ${err.message}`);
    }
  }

  /**
   * Recall every card a call still owns. Used when the call stops being
   * answerable from QQ: answered in the Web UI, timed out, cancelled, or unloaded.
   * @param {Object} entry - Pending question call
   * @returns {Promise<void>}
   */
  async recallCards(entry) {
    await this.recallCard(entry, 'open');
    await this.recallCard(entry, 'list');
  }

  /**
   * Normalize the request's questions into the shape the cards and the answer
   * batch share.
   * @param {Array<Object>|undefined} raw - `req.questions`
   * @returns {Array<Object>} One entry per question, each with an id, text, and options array
   */
  normalizeQuestions(raw) {
    const list = Array.isArray(raw) ? raw : [];
    return list
      .filter((question) => question && typeof question === 'object')
      .map((question, index) => ({
        id: typeof question.id === 'string' && question.id !== '' ? question.id : `q${index + 1}`,
        header: question.header,
        detail: question.detail,
        question: typeof question.question === 'string' ? question.question : String(question.question ?? ''),
        options: Array.isArray(question.options) ? question.options : [],
        multiSelect: question.multiSelect === true,
      }));
  }

  /**
   * Build the question-list card: the call's roster with per-question status and
   * the last recorded answer, plus one button per question that opens it.
   * @param {Object} entry - Pending question call
   * @returns {{ markdown: string, keyboard: Object }}
   */
  buildQuestionListCard(entry) {
    const total = entry.questions.length;
    const lines = [`❓ **【DSH Agent 提问】本次共 ${total} 题，已答 ${entry.answers.size} 题**`];

    if (entry.lastRecorded) {
      lines.push(`✅ 第 ${entry.lastRecorded.index + 1} 题已记录：${ApprovalHandler.describeAnswer(entry.lastRecorded.answer)}`);
    }
    lines.push('');

    for (const [index, question] of entry.questions.entries()) {
      const answer = entry.answers.get(index);
      const mark = answer ? '✅' : entry.openIndex === index ? '✏️' : '⏳';
      const suffix = answer ? ` → ${ApprovalHandler.describeAnswer(answer)}` : '';
      lines.push(`${mark} **${index + 1}.** ${ApprovalHandler.truncate(question.question, 60)}${suffix}`);
    }

    lines.push('', '💡 点击下方按钮选择要作答的题目（可任意顺序，答完自动提交）：');

    return {
      markdown: lines.join('\n'),
      keyboard: KeyboardBuilder.buildQuestionListBoard(entry.questions.map((question, index) => ({
        ordinal: index + 1,
        title: question.header || question.question,
        answered: entry.answers.has(index),
        open: entry.openIndex === index,
      }))),
    };
  }

  /**
   * Build one question's card and its option board.
   * @param {Object} entry - Pending question call
   * @param {number} index - Question position within the call
   * @returns {{ markdown: string, keyboard: Object|undefined }}
   */
  buildQuestionCard(entry, index) {
    const question = entry.questions[index];
    const total = entry.questions.length;
    const ordinal = index + 1;

    const optionLines = question.options.map((option, optionIndex) => {
      const letter = QUESTION_LETTERS[optionIndex] || String(optionIndex + 1);
      const label = ApprovalHandler.optionLabel(option) || `选项 ${letter}`;
      const description = option && typeof option === 'object' && option.description
        ? ` *(${option.description})*`
        : '';
      return `**${letter}.** ${label}${description}`;
    });

    const lines = [`❓ **【DSH Agent 提问】第 ${ordinal}/${total} 题**`];
    if (question.header) lines.push(`> **主题**: ${question.header}`);
    lines.push(`> **问题**: ${question.question}`);
    if (question.detail) lines.push(`> **详情**: ${question.detail}`);

    if (optionLines.length > 0) {
      lines.push('', '📋 **可选项:**', ...optionLines);
    }
    lines.push('', this.answerHint(question, ordinal));

    return {
      markdown: lines.join('\n'),
      keyboard: question.options.length > 0
        ? KeyboardBuilder.buildQuestionBoard(ordinal, question.options)
        : undefined,
    };
  }

  /**
   * The reply hint under one question card.
   * @param {Object} question - Normalized question
   * @param {number} ordinal - 1-based position shown on the list card
   * @returns {string} One hint line naming the exact command to type
   */
  answerHint(question, ordinal) {
    if (question.options.length === 0) {
      return `💡 该题没有预设选项，请直接回复：\`/answer ${ordinal} 你的回答\``;
    }
    const skip = `跳过用 \`/answer ${ordinal} -\``;
    if (question.multiSelect) {
      return `💡 点击下方选项按钮作答；多选请回复 \`/answer ${ordinal} 选项A,选项B\`；${skip}`;
    }
    return `💡 点击下方选项按钮作答；也可回复 \`/answer ${ordinal} 选项文字\`；${skip}`;
  }

  /**
   * One-line rendering of a recorded answer, shared by the list card and the
   * QQ reply text.
   * @param {{ selected?: string[], custom?: string }} [answer]
   * @returns {string} Selected labels, free-form text, and "skipped" as applicable
   */
  static describeAnswer(answer) {
    const selected = (answer?.selected ?? []).join(', ');
    if (selected && answer?.custom) return `${selected} + 补充: ${answer.custom}`;
    if (selected) return selected;
    if (answer?.custom) return `补充回答: ${answer.custom}`;
    return '已跳过';
  }

  /** Display label of one option, tolerating the string and `{label}`/`{name}` shapes. */
  static optionLabel(option) {
    if (typeof option === 'string') return option;
    if (option && typeof option === 'object') return option.label || option.name || '';
    return '';
  }

  /** Longest single-line prefix of `value` within `max` characters. */
  static truncate(value, max) {
    const text = String(value ?? '').replace(/\s+/g, ' ').trim();
    return text.length > max ? `${text.slice(0, max - 1)}…` : text;
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
   * Resolve a question reference to its pending call entry. Boards send the
   * 1-based ordinal (short, and comfortable to type on a phone); an exact
   * question id is still accepted, and a missing reference is honoured only
   * while it is unambiguous — exactly one question across all pending calls is
   * still unanswered.
   * @param {string} [questionRef] - Ordinal or question id carried by the button/command
   * @returns {{ status: 'ok', entry: Object, question: Object, index: number }
   *   | { status: 'not-found' }
   *   | { status: 'ambiguous', candidates: Array<{ id: string, index: number }> }}
   */
  resolveQuestionRef(questionRef) {
    const wanted = typeof questionRef === 'string' ? questionRef.trim() : '';

    if (wanted !== '') {
      const entries = [...this.pendingQuestions.values()];

      if (/^\d+$/.test(wanted)) {
        const ordinal = Number(wanted);
        const matches = [];
        for (const entry of entries) {
          const index = ordinal - 1;
          if (index >= 0 && index < entry.questions.length) {
            matches.push({ entry, question: entry.questions[index], index });
          }
        }
        if (matches.length === 1) return { status: 'ok', ...matches[0] };
        if (matches.length === 0) return { status: 'not-found' };
        return {
          status: 'ambiguous',
          candidates: matches.map(({ question, index }) => ({ id: question.id, index })),
        };
      }

      for (const entry of entries) {
        const index = entry.questions.findIndex((question) => question.id === wanted);
        if (index >= 0) return { status: 'ok', entry, question: entry.questions[index], index };
      }
      return { status: 'not-found' };
    }

    const open = [];
    for (const entry of this.pendingQuestions.values()) {
      for (let index = 0; index < entry.questions.length; index += 1) {
        const question = entry.questions[index];
        if (!entry.answers.has(index)) open.push({ entry, question, index });
      }
    }
    if (open.length === 0) return { status: 'not-found' };
    if (open.length === 1) return { status: 'ok', ...open[0] };
    return {
      status: 'ambiguous',
      candidates: open.map(({ question, index }) => ({ id: question.id, index })),
    };
  }

  /**
   * Open one question from the list: recall the question card that was open and
   * show this one. Answering is a separate step (`handleQuestionAnswer`).
   * @param {string} [questionRef] - Ordinal or question id from the list button
   * @returns {Promise<Object>} Outcome the caller may render back to the QQ user
   */
  async pickQuestion(questionRef) {
    const located = this.resolveQuestionRef(questionRef);
    if (located.status !== 'ok') return located;

    const { entry, question, index } = located;
    const total = entry.questions.length;
    const answer = entry.answers.get(index);
    if (answer !== undefined) {
      return {
        status: 'duplicate',
        question,
        index,
        total,
        answer,
        answerText: ApprovalHandler.describeAnswer(answer),
      };
    }

    const delivered = await this.openQuestion(entry, index);
    return { status: 'opened', question, index, total, delivered };
  }

  /**
   * Turn one QQ reply into the harness answer shape for one question.
   * A board letter or an option label selects; several labels select for a
   * multi-select question; anything else is free-form `custom`; `-`/`skip`/`跳过`
   * is an explicit skip (empty `selected`, no `custom`).
   *
   * A blank value never reaches here: `handleQuestionAnswer` reports it as
   * `empty` so that a stray command cannot masquerade as a skip.
   * @param {Object} question - Normalized question
   * @param {string} [rawValue] - Raw reply text
   * @returns {{ selected: string[], custom?: string }}
   */
  interpretAnswer(question, rawValue) {
    const raw = typeof rawValue === 'string' ? rawValue.trim() : '';
    if (raw === '' || SKIP_TOKENS.has(raw) || SKIP_TOKENS.has(raw.toLowerCase())) {
      return { selected: [] };
    }
    if (question.options.length === 0) return { selected: [], custom: raw };

    const labels = question.options.map((option) => ApprovalHandler.optionLabel(option));

    // A board letter is resolved against *this* question's options, so a click on
    // question 3's "B" can never land on question 1's option list.
    const letterIndex = QUESTION_LETTERS.indexOf(raw.toUpperCase());
    if (letterIndex >= 0 && letterIndex < labels.length && labels[letterIndex] !== '') {
      return { selected: [labels[letterIndex]] };
    }

    const exact = labels.find((label) => label !== '' && label.toLowerCase() === raw.toLowerCase());
    if (exact !== undefined) return { selected: [exact] };

    if (question.multiSelect === true) {
      const parts = raw.split(/[,，]/).map((part) => part.trim()).filter((part) => part !== '');
      if (parts.length > 1) {
        const matched = [];
        for (const part of parts) {
          const hit = labels.find((label) => label !== '' && label.toLowerCase() === part.toLowerCase());
          if (hit === undefined) {
            matched.length = 0;
            break;
          }
          if (!matched.includes(hit)) matched.push(hit);
        }
        if (matched.length > 0) return { selected: matched };
      }
    }

    return { selected: [], custom: raw };
  }

  /**
   * Record one question's answer from QQ and settle the call once its batch is
   * complete. The promise only ever resolves with one answer item per question,
   * in request order, because the harness reads the returned batch as complete.
   *
   * Cards follow the answer: the answered question's card is recalled, and the
   * always-visible list is re-sent with its status, so the user lands back on the
   * list ready to pick the next question.
   * @param {string} [questionRef] - Ordinal or question id carried by the button/command
   * @param {string} [optionLabel] - Letter, option label(s), free text, or a skip token
   * @returns {Promise<Object>} Outcome the caller renders back to the QQ user
   */
  async handleQuestionAnswer(questionRef, optionLabel) {
    const located = this.resolveQuestionRef(questionRef);
    if (located.status !== 'ok') return located;

    const { entry, question, index } = located;
    const total = entry.questions.length;

    // An empty value is not an answer: skipping has its own explicit tokens, so a
    // stray `/answer 1` must not hand the model an empty batch.
    if (String(optionLabel ?? '').trim() === '') {
      return { status: 'empty', question, index, total };
    }

    const existing = entry.answers.get(index);
    if (existing !== undefined) {
      return {
        status: 'duplicate',
        question,
        index,
        total,
        answer: existing,
        answerText: ApprovalHandler.describeAnswer(existing),
      };
    }

    const answer = this.interpretAnswer(question, optionLabel);
    entry.answers.set(index, answer);
    entry.lastRecorded = { index, answer };

    // The answered question's card has served its purpose.
    if (entry.openIndex === index) await this.recallCard(entry, 'open');

    if (entry.answers.size < total) {
      await this.sendQuestionList(entry);
      return {
        status: 'recorded',
        question,
        index,
        total,
        answer,
        answerText: ApprovalHandler.describeAnswer(answer),
        remaining: entry.questions
          .map((item, itemIndex) => ({ question: item, index: itemIndex }))
          .filter((item) => !entry.answers.has(item.index)),
      };
    }

    const answers = entry.questions.map((item, itemIndex) => {
      const recorded = entry.answers.get(itemIndex) ?? { selected: [] };
      return {
        id: item.id,
        selected: [...recorded.selected],
        ...recorded.custom === undefined ? {} : { custom: recorded.custom },
      };
    });

    this.pendingQuestions.delete(entry.id);
    entry.resolve({ answers });
    // The finished list stays behind as the record of what was answered.
    await this.sendQuestionList(entry);
    return { status: 'completed', answers, total };
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

    // A pending question call settles with null (not a partial batch): teardown
    // must never hand the harness an answer set that names only some questions.
    // Its cards are dropped too — they are no longer answerable.
    for (const entry of this.pendingQuestions.values()) {
      entry.resolve(null);
      void this.recallCards(entry);
    }
    this.pendingQuestions.clear();
  }
}
