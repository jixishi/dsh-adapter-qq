/**
 * QQ Open Platform InlineKeyboard Builder for Action Boards
 * Reference: https://bot.q.qq.com/wiki/develop/nodesdk/model/inline_keyboard.html
 */

import { emojiForSlot } from './emoji.js';

/** QQ renders `render_data.label` at a maximum of 10 characters (code points). */
const MAX_LABEL_CODEPOINTS = 10;

/**
 * Truncate text by Unicode code points (`Array.from`), never by UTF-16 units,
 * so a surrogate pair (emoji) is never split and always counts as 1 character.
 * @param {string} text
 * @param {number} [max=10]
 * @returns {string}
 */
function truncateLabel(text, max = MAX_LABEL_CODEPOINTS) {
  const chars = Array.from(String(text ?? ''));
  const limit = Number.isFinite(max) ? Math.max(0, Math.trunc(max)) : MAX_LABEL_CODEPOINTS;
  return chars.length <= limit ? chars.join('') : chars.slice(0, limit).join('');
}

export class KeyboardBuilder {
  /**
   * Create a single button object
   * Default actionType=1 (Callback) for 100% reliable mobile and desktop clicks
   * @param {Object} options
   * @param {string} options.id - Button unique ID
   * @param {string} options.label - Display label
   * @param {string} [options.visitedLabel] - Label after click
   * @param {number} [options.style=0] - 0=Gray/Default, 1=Blue/Primary
   * @param {number} [options.actionType=1] - 1=Callback (INTERACTION_CREATE), 2=Instruction, 0=URL
   * @param {string} options.data - Command to send or callback data
   * @param {boolean} [options.enter=true] - Auto send directly on click
   * @returns {Object}
   */
  static button({
    id,
    label,
    visitedLabel,
    style = 0,
    actionType = 1,
    data,
    enter = true,
  }) {
    return {
      id: String(id),
      render_data: {
        label: truncateLabel(label, 20),
        visited_label: truncateLabel(visitedLabel || label, 20),
        style,
      },
      action: {
        type: actionType,
        permission: { type: 2 }, // Available to everyone in chat
        data,
        enter,
        unsupport_tips: '当前QQ客户端不支持该按钮操作',
      },
    };
  }

  /**
   * Wrap button rows into a valid QQ keyboard payload
   * @param {Array<Array<Object>>} rows - Matrix of buttons (max 5 rows, max 5 buttons per row)
   * @returns {Object}
   */
  static keyboard(rows) {
    return {
      content: {
        rows: rows.map((buttons) => ({
          buttons: buttons.slice(0, 5),
        })).slice(0, 5),
      },
    };
  }

  /**
   * Build main help / command action board
   */
  static buildHelpBoard() {
    const row1 = [
      this.button({ id: 'btn_sess', label: '📋 会话列表', data: '/sessions', style: 1 }),
      this.button({ id: 'btn_curr', label: '📌 当前会话', data: '/current' }),
    ];
    const row2 = [
      this.button({ id: 'btn_new', label: '➕ 新建会话', data: '/new', style: 1 }),
      this.button({ id: 'btn_model', label: '🤖 切换模型', data: '/model' }),
    ];
    const row3 = [
      this.button({ id: 'btn_preset', label: '⚙️ 切换预设', data: '/preset' }),
      this.button({ id: 'btn_perm', label: '🛡️ 权限切换', data: '/permission' }),
    ];
    const row4 = [
      this.button({ id: 'btn_stats', label: '📊 统计信息', data: '/stats' }),
      this.button({ id: 'btn_cancel', label: '🛑 停止任务', data: '/cancel' }),
    ];
    return this.keyboard([row1, row2, row3, row4]);
  }

  /**
   * Helper to format compact button title while preserving branch markers like (1)
   * @param {string} rawTitle
   * @param {number} [max=9] - Maximum code points for the title part
   * @returns {string}
   */
  static formatButtonTitle(rawTitle, max = 9) {
    if (!rawTitle) return '';
    const limit = Number.isFinite(max) ? Math.max(1, Math.trunc(max)) : 9;
    const branchMatch = String(rawTitle).match(/\s*(\(\d+\))\s*$/);
    const branchSuffix = branchMatch ? branchMatch[1] : '';
    const cleanTitle = String(rawTitle).replace(/\s*\(\d+\)\s*$/, '').trim();
    if (branchSuffix) {
      const branchChars = Array.from(branchSuffix).length;
      return truncateLabel(cleanTitle, Math.max(1, limit - branchChars)) + branchSuffix;
    }
    return truncateLabel(cleanTitle, limit);
  }

  /**
   * Code-point-safe label truncation shared by every new operator board button.
   * @param {string} text
   * @param {number} [max=10]
   * @returns {string}
   */
  static truncateLabel(text, max = MAX_LABEL_CODEPOINTS) {
    return truncateLabel(text, max);
  }

  /**
   * Build the paginated sessions operator board.
   * Layout: up to 3 rows x 2 session buttons, then an optional paging row,
   * then [new session][refresh]; never more than 5 rows.
   * @param {Object} options
   * @param {Array<{sessionId:string,title:string,index:number,emoji:string,running:boolean}>} [options.sessions] - Sessions of the current page
   * @param {string} [options.activeSessionId]
   * @param {number} [options.page=1] - 1-based current page
   * @param {number} [options.totalPages=1]
   * @param {string} [legacyActiveSessionId] - Only for the legacy array call shape
   */
  static buildSessionsBoard(options = {}, legacyActiveSessionId) {
    // Tolerate the legacy (sessionsArray, activeSessionId) call shape.
    const opts = Array.isArray(options)
      ? { sessions: options, activeSessionId: legacyActiveSessionId }
      : options || {};
    const sessions = Array.isArray(opts.sessions) ? opts.sessions : [];
    const activeSessionId = opts.activeSessionId;
    const rawPage = Number(opts.page);
    const rawTotalPages = Number(opts.totalPages);
    const page = Number.isFinite(rawPage) ? Math.max(1, Math.trunc(rawPage)) : 1;
    const totalPages = Number.isFinite(rawTotalPages) ? Math.max(1, Math.trunc(rawTotalPages)) : 1;
    const safePage = Math.min(page, totalPages);

    const rows = [];
    const list = sessions.slice(0, 6); // max 3 rows x 2 buttons

    for (let i = 0; i < list.length; i += 2) {
      const row = [];
      for (let j = i; j < Math.min(i + 2, list.length); j++) {
        const s = list[j];
        const isActive = s.sessionId === activeSessionId;
        const emoji = s.emoji || emojiForSlot(j);
        const indexPrefix = s.index ? `${s.index}.` : '';
        const prefix = `${isActive ? '⭐' : ''}${emoji}${indexPrefix}`;
        const titleBudget = Math.max(1, MAX_LABEL_CODEPOINTS - Array.from(prefix).length);
        const title = this.formatButtonTitle(s.title || s.sessionId, titleBudget);
        row.push(
          this.button({
            id: `sw_${j}`,
            label: truncateLabel(`${prefix}${title}`, MAX_LABEL_CODEPOINTS),
            data: `/switch ${s.sessionId}`,
            style: isActive ? 1 : 0,
          })
        );
      }
      rows.push(row);
    }

    // Paging row (only when more than one page exists)
    if (totalPages > 1) {
      const pageRow = [];
      if (safePage > 1) {
        pageRow.push(
          this.button({ id: 'btn_sess_prev', label: '⬅️ 上页', data: `/sessions page ${safePage - 1}` })
        );
      }
      pageRow.push(
        this.button({
          id: 'btn_sess_page',
          label: `📄 ${safePage}/${totalPages} 页`,
          data: `/sessions page ${safePage}`,
        })
      );
      if (safePage < totalPages) {
        pageRow.push(
          this.button({ id: 'btn_sess_next', label: '➡️ 下页', data: `/sessions page ${safePage + 1}` })
        );
      }
      rows.push(pageRow);
    }

    // Bottom action row
    rows.push([
      this.button({ id: 'btn_new', label: '➕ 新建会话', data: '/new', style: 1 }),
      this.button({ id: 'btn_refresh', label: '🔄 刷新列表', data: '/sessions' }),
    ]);

    return this.keyboard(rows);
  }

  /**
   * Build New Session: Select Workspace Action Board (Step 1)
   * Lists existing local and remote workspaces for selection, plus browse option
   * @param {Array<Object>} workspaces - List of workspace items
   */
  static buildNewSessionWorkspacesBoard(workspaces) {
    const rows = [];
    const list = (workspaces || []).slice(0, 6);

    for (let i = 0; i < list.length; i += 2) {
      const row = [];
      const ws1 = list[i];
      const isRemote1 = ws1.isRemote || ws1.path?.includes('remote-workspaces');
      const label1 = `📁 ${ws1.title.slice(0, 8)}${isRemote1 ? '(远)' : ''}`;
      row.push(
        this.button({
          id: `ws_pick_${i}`,
          label: label1,
          data: `/new select-ws ${ws1.id}`,
          style: 1,
        })
      );

      if (i + 1 < list.length) {
        const ws2 = list[i + 1];
        const isRemote2 = ws2.isRemote || ws2.path?.includes('remote-workspaces');
        const label2 = `📁 ${ws2.title.slice(0, 8)}${isRemote2 ? '(远)' : ''}`;
        row.push(
          this.button({
            id: `ws_pick_${i + 1}`,
            label: label2,
            data: `/new select-ws ${ws2.id}`,
            style: 1,
          })
        );
      }
      rows.push(row);
    }

    // Custom browse and cancel options
    rows.push([
      this.button({ id: 'btn_browse_custom', label: '🔍 浏览并选择目录', data: '/new browse', style: 0 }),
      this.button({ id: 'btn_cancel_new', label: '❌ 取消', data: '/current' }),
    ]);

    return this.keyboard(rows);
  }

  /**
   * Build Directory Browser Action Board (Step 2)
   * Shows subdirectories, navigation (up, parent, page), mkdir, and confirmation
   * @param {Object} options
   * @param {string} options.currentPath - Current directory path
   * @param {Array<string>} options.subdirs - List of subdirectories on current page
   * @param {number} options.page - Current page number
   * @param {number} options.totalPages - Total pages
   * @param {boolean} options.canGoUp - Whether going to parent directory is allowed
   */
  static buildDirectoryBrowserBoard({ currentPath, subdirs, page = 1, totalPages = 1, canGoUp = true }) {
    const rows = [];
    const list = subdirs || [];

    // Up to 2 rows of subdirectories (2 per row = 4 subdirectories)
    for (let i = 0; i < list.length; i += 2) {
      const row = [];
      const d1 = list[i];
      row.push(
        this.button({
          id: `subdir_${i}`,
          label: `📁 ${d1.slice(0, 10)}`,
          data: `/new enter-dir ${encodeURIComponent(d1)}`,
          style: 0,
        })
      );

      if (i + 1 < list.length) {
        const d2 = list[i + 1];
        row.push(
          this.button({
            id: `subdir_${i + 1}`,
            label: `📁 ${d2.slice(0, 10)}`,
            data: `/new enter-dir ${encodeURIComponent(d2)}`,
            style: 0,
          })
        );
      }
      rows.push(row);
      if (rows.length >= 2) break;
    }

    // Navigation and paging row
    const navRow = [];
    if (canGoUp) {
      navRow.push(this.button({ id: 'btn_dir_up', label: '⬆️ 上级目录', data: '/new up-dir' }));
    }
    if (totalPages > 1) {
      if (page > 1) {
        navRow.push(this.button({ id: 'btn_page_prev', label: '⬅️ 上页', data: `/new page ${page - 1}` }));
      }
      if (page < totalPages) {
        navRow.push(this.button({ id: 'btn_page_next', label: '➡️ 下页', data: `/new page ${page + 1}` }));
      }
    }
    navRow.push(this.button({ id: 'btn_mkdir', label: '➕ 新建目录', data: '/new prompt-mkdir' }));
    if (navRow.length > 0) {
      rows.push(navRow);
    }

    // Confirmation & cancellation row
    rows.push([
      this.button({ id: 'btn_confirm_dir', label: '✅ 选定当前目录创建', data: `/new confirm-dir`, style: 1 }),
      this.button({ id: 'btn_cancel_dir', label: '❌ 取消', data: '/new' }),
    ]);

    return this.keyboard(rows);
  }

  /**
   * Build current session control board
   */
  static buildCurrentSessionBoard() {
    const row1 = [
      this.button({ id: 'btn_model', label: '🤖 切换模型', data: '/model', style: 1 }),
      this.button({ id: 'btn_effort', label: '🧠 思考等级', data: '/effort', style: 1 }),
    ];
    const row2 = [
      this.button({ id: 'btn_preset', label: '⚙️ 切换预设', data: '/preset' }),
      this.button({ id: 'btn_perm', label: '🛡️ 切换权限', data: '/permission' }),
    ];
    const row3 = [
      this.button({ id: 'btn_stats', label: '📊 统计信息', data: '/stats' }),
      this.button({ id: 'btn_cancel', label: '🛑 停止执行', data: '/cancel' }),
    ];
    const row4 = [
      this.button({ id: 'btn_list', label: '📋 会话列表', data: '/sessions' }),
      this.button({ id: 'btn_help', label: '❓ 帮助', data: '/help' }),
    ];
    return this.keyboard([row1, row2, row3, row4]);
  }

  /**
   * Build stats action board
   */
  static buildStatsBoard() {
    const row1 = [
      this.button({ id: 'btn_refresh_stats', label: '🔄 刷新统计', data: '/stats', style: 1 }),
      this.button({ id: 'btn_curr', label: '📌 当前会话', data: '/current' }),
    ];
    const row2 = [
      this.button({ id: 'btn_model', label: '🤖 切换模型', data: '/model' }),
      this.button({ id: 'btn_effort', label: '🧠 思考等级', data: '/effort' }),
    ];
    return this.keyboard([row1, row2]);
  }

  /**
   * Build model selection action board with pagination support
   * @param {Array<Object>} models - Available models
   * @param {string} currentModelId - Currently selected model ID
   * @param {string} [currentProvider] - Currently selected provider
   * @param {number} [page=1] - Current page
   * @param {number} [pageSize=6] - Page size
   */
  static buildModelsBoard(models, currentModelId, currentProvider, page = 1, pageSize = 6) {
    const rows = [];
    const total = (models || []).length;
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const safePage = Math.min(Math.max(1, page), totalPages);
    const offset = (safePage - 1) * pageSize;
    const list = (models || []).slice(offset, offset + pageSize);

    for (let i = 0; i < list.length; i += 2) {
      const row = [];
      const m1 = list[i];
      const isCur1 = m1.id === currentModelId && (!currentProvider || m1.provider === currentProvider);
      const provTag1 = m1.providerName ? ` (${m1.providerName.slice(0, 4)})` : '';
      row.push(
        this.button({
          id: `mod_${offset + i}`,
          label: `${isCur1 ? '✅ ' : ''}${m1.id.slice(0, 9)}${provTag1}`,
          data: `/model ${m1.id} ${m1.provider}`,
          style: isCur1 ? 1 : 0,
        })
      );

      if (i + 1 < list.length) {
        const m2 = list[i + 1];
        const isCur2 = m2.id === currentModelId && (!currentProvider || m2.provider === currentProvider);
        const provTag2 = m2.providerName ? ` (${m2.providerName.slice(0, 4)})` : '';
        row.push(
          this.button({
            id: `mod_${offset + i + 1}`,
            label: `${isCur2 ? '✅ ' : ''}${m2.id.slice(0, 9)}${provTag2}`,
            data: `/model ${m2.id} ${m2.provider}`,
            style: isCur2 ? 1 : 0,
          })
        );
      }
      rows.push(row);
    }

    // Pagination row when multiple pages exist
    if (totalPages > 1) {
      const pageRow = [];
      if (safePage > 1) {
        pageRow.push(this.button({ id: 'btn_mod_prev', label: '⬅️ 上页', data: `/model page ${safePage - 1}`, style: 0 }));
      }
      pageRow.push(this.button({ id: 'btn_mod_info', label: `📄 ${safePage}/${totalPages}页`, data: `/model page ${safePage}` }));
      if (safePage < totalPages) {
        pageRow.push(this.button({ id: 'btn_mod_next', label: '➡️ 下页', data: `/model page ${safePage + 1}`, style: 0 }));
      }
      rows.push(pageRow);
    }

    rows.push([
      this.button({ id: 'btn_effort_from_mod', label: '🧠 思考等级', data: '/effort', style: 1 }),
      this.button({ id: 'btn_back_curr', label: '📌 当前会话', data: '/current' }),
    ]);

    return this.keyboard(rows);
  }

  /**
   * Build reasoning effort action board
   * @param {string} [currentEffort] - Current reasoning effort
   */
  static buildReasoningEffortBoard(currentEffort) {
    const efforts = [
      { id: 'off', label: '🔴 关闭 (off)' },
      { id: 'low', label: '🟢 低 (low)' },
      { id: 'medium', label: '🟡 中 (medium)' },
      { id: 'high', label: '🔵 高 (high)' },
      { id: 'xhigh', label: '🟣 超高 (xhigh)' },
      { id: 'max', label: '⚡ 最大 (max)' },
    ];

    const rows = [];
    for (let i = 0; i < efforts.length; i += 2) {
      const row = [];
      const e1 = efforts[i];
      const isCur1 = e1.id === currentEffort;
      row.push(
        this.button({
          id: `eff_${i}`,
          label: `${isCur1 ? '✅ ' : ''}${e1.label}`,
          data: `/effort ${e1.id}`,
          style: isCur1 ? 1 : 0,
        })
      );

      if (i + 1 < efforts.length) {
        const e2 = efforts[i + 1];
        const isCur2 = e2.id === currentEffort;
        row.push(
          this.button({
            id: `eff_${i + 1}`,
            label: `${isCur2 ? '✅ ' : ''}${e2.label}`,
            data: `/effort ${e2.id}`,
            style: isCur2 ? 1 : 0,
          })
        );
      }
      rows.push(row);
    }

    rows.push([
      this.button({ id: 'btn_back_mod', label: '🤖 模型列表', data: '/model' }),
      this.button({ id: 'btn_curr', label: '📌 当前会话', data: '/current' }),
    ]);

    return this.keyboard(rows);
  }

  /**
   * Build preset selection action board
   * @param {Array<Object>} presets - Dynamically discovered presets
   * @param {string} currentPreset - Current session preset
   */
  static buildPresetsBoard(presets, currentPreset) {
    const rows = [];
    const list = (presets || []).slice(0, 8);

    for (let i = 0; i < list.length; i += 2) {
      const row = [];
      const p1 = list[i];
      const isCur1 = p1.id === currentPreset;
      row.push(
        this.button({
          id: `pre_${i}`,
          label: `${isCur1 ? '✅ ' : ''}${p1.id}`,
          data: `/preset ${p1.id}`,
          style: isCur1 ? 1 : 0,
        })
      );

      if (i + 1 < list.length) {
        const p2 = list[i + 1];
        const isCur2 = p2.id === currentPreset;
        row.push(
          this.button({
            id: `pre_${i + 1}`,
            label: `${isCur2 ? '✅ ' : ''}${p2.id}`,
            data: `/preset ${p2.id}`,
            style: isCur2 ? 1 : 0,
          })
        );
      }
      rows.push(row);
      if (rows.length >= 4) break;
    }

    rows.push([
      this.button({ id: 'btn_back', label: '📌 返回当前会话', data: '/current' }),
      this.button({ id: 'btn_help', label: '❓ 帮助', data: '/help' }),
    ]);

    return this.keyboard(rows);
  }

  /**
   * Build permission selection action board
   * @param {Array<Object>} permissions - Available permission presets
   * @param {string} currentMode - Current mode
   */
  static buildPermissionsBoard(permissions, currentMode) {
    const rows = [];
    const row = [];

    const permLabels = {
      'read-only': '只读',
      'workspace-write': '工作区写入',
      'danger-full-access': '全系统',
    };

    for (let i = 0; i < (permissions || []).length; i++) {
      const p = permissions[i];
      const isCur = p.id === currentMode;
      const display = permLabels[p.id] || p.name || p.id;
      row.push(
        this.button({
          id: `perm_${i}`,
          label: `${isCur ? '✅ ' : ''}${display}`,
          data: `/permission ${p.id}`,
          style: isCur ? 1 : 0,
        })
      );
    }
    rows.push(row);

    rows.push([
      this.button({ id: 'btn_back', label: '📌 返回当前会话', data: '/current' }),
      this.button({ id: 'btn_help', label: '❓ 帮助', data: '/help' }),
    ]);

    return this.keyboard(rows);
  }

  /**
   * Build approval request action board
   * @param {string} approvalId - Approval request ID
   */
  static buildApprovalBoard(approvalId) {
    const row = [
      this.button({
        id: 'btn_appr_allow',
        label: '✅ 允许执行 (单次)',
        data: `/approve ${approvalId}`,
        style: 1,
      }),
      this.button({
        id: 'btn_appr_reject',
        label: '❌ 拒绝执行',
        data: `/reject ${approvalId}`,
        style: 0,
      }),
    ];
    return this.keyboard([row]);
  }

  /**
   * Build user question options action board.
   * Buttons display compact letters A, B, C, D while the text card presents full option details.
   * @param {string} questionId - Request id echoed back by the button
   * @param {Array<Object|string>} options - Options list
   * @param {Object} [extra]
   * @param {string[]} [extra.selected=[]] - Currently selected option labels (multi-select)
   * @param {boolean} [extra.multiSelect=false] - Show selection state and a submit button
   */
  static buildQuestionBoard(questionId, options, extra = {}) {
    const letters = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];
    const rows = [];
    const list = (options || []).slice(0, 8);
    const selected = Array.isArray(extra.selected) ? extra.selected : [];
    const multiSelect = extra.multiSelect === true;

    for (let i = 0; i < list.length; i += 4) {
      const row = [];
      for (let j = i; j < Math.min(i + 4, list.length); j++) {
        const o = list[j];
        const letter = letters[j] || String(j + 1);
        const label = typeof o === 'string' ? o : o.label || o.name || `选项 ${letter}`;
        const isSelected = selected.includes(label);
        row.push(
          this.button({
            id: `opt_${j}`,
            label: truncateLabel(`${isSelected ? '✅' : ''}${letter}`),
            data: `/answer ${questionId} ${encodeURIComponent(label)}`,
            style: isSelected ? 1 : 0,
          })
        );
      }
      rows.push(row);
    }

    if (multiSelect) {
      rows.push([
        this.button({ id: 'btn_q_submit', label: '✅ 提交选择', data: `/answer ${questionId} __submit__`, style: 1 }),
        this.button({ id: 'btn_q_clear', label: '🗑️ 清空', data: `/answer ${questionId} __clear__` }),
      ]);
    }

    return this.keyboard(rows);
  }

  /**
   * Build the skills overview board (2 buttons per row, max 3 rows + paging + actions).
   * @param {Object} options
   * @param {Array<{name:string,disabled?:boolean}>} [options.skills]
   * @param {number} [options.page=1]
   * @param {number} [options.totalPages=1]
   */
  static buildSkillsBoard({ skills = [], page = 1, totalPages = 1 } = {}) {
    return this._buildPagedListBoard({
      entries: skills,
      page,
      totalPages,
      pageCommand: '/skills',
      refreshLabel: '🔄 刷新技能',
      entryLabel: (skill) => truncateLabel(skill?.name || skill?.id || '未命名', MAX_LABEL_CODEPOINTS),
      entryData: (skill) => `/skills ${skill?.name || skill?.id}`,
      entryStyle: () => 0,
    });
  }

  /**
   * Build the single-skill detail board.
   * @param {Object} options
   * @param {string} options.name - Skill name
   * @param {boolean} [options.enabled=true]
   */
  static buildSkillDetailBoard({ name = '', enabled = true } = {}) {
    const toggle = enabled
      ? this.button({ id: 'btn_skill_toggle', label: '🚫 禁用技能', data: `/skill off ${name}`, style: 0 })
      : this.button({ id: 'btn_skill_toggle', label: '✅ 启用技能', data: `/skill on ${name}`, style: 1 });

    const rows = [
      [toggle],
      [
        this.button({ id: 'btn_skill_back', label: '⬅️ 返回技能列表', data: '/skills' }),
        this.button({ id: 'btn_help', label: '❓ 帮助', data: '/help' }),
      ],
    ];
    return this.keyboard(rows);
  }

  /**
   * Build the MCP server overview board.
   * @param {Object} options
   * @param {Array<{id:string,serverName:string,enabled?:boolean}>} [options.servers]
   * @param {number} [options.page=1]
   * @param {number} [options.totalPages=1]
   */
  static buildMcpBoard({ servers = [], page = 1, totalPages = 1 } = {}) {
    return this._buildPagedListBoard({
      entries: servers,
      page,
      totalPages,
      pageCommand: '/mcp',
      refreshLabel: '🔄 刷新服务',
      entryLabel: (server) => truncateLabel(server?.serverName || server?.name || server?.id || '未命名', MAX_LABEL_CODEPOINTS),
      entryData: (server) => `/mcp ${server?.id ?? server?.serverName}`,
      entryStyle: (server) => (server?.enabled ? 1 : 0),
    });
  }

  /**
   * Build the single-MCP-server detail board. Read-only rows when !canManage.
   * @param {Object} options
   * @param {string} options.id - MCP server id
   * @param {boolean} [options.enabled=true]
   * @param {boolean} [options.canManage=true]
   */
  static buildMcpDetailBoard({ id = '', enabled = true, canManage = true } = {}) {
    const rows = [];

    if (canManage !== false) {
      rows.push([
        enabled
          ? this.button({ id: 'btn_mcp_toggle', label: '🚫 禁用服务', data: `/mcp off ${id}`, style: 0 })
          : this.button({ id: 'btn_mcp_toggle', label: '✅ 启用服务', data: `/mcp on ${id}`, style: 1 }),
        this.button({ id: 'btn_mcp_restart', label: '🔄 重启服务', data: `/mcp restart ${id}` }),
      ]);
    }

    rows.push([this.button({ id: 'btn_mcp_back', label: '⬅️ 返回MCP列表', data: '/mcp' })]);

    return this.keyboard(rows);
  }

  /**
   * Build the render shortcut board (render current reply as an image + help).
   */
  static buildRenderBoard() {
    return this.keyboard([
      [
        this.button({ id: 'btn_render_reply', label: '🖼️ 渲染当前回复', data: '/render', style: 1 }),
        this.button({ id: 'btn_help', label: '❓ 帮助', data: '/help' }),
      ],
    ]);
  }

  /**
   * Shared layout for paged list boards (skills / MCP): 3 rows x 2 entries,
   * an optional paging row, then refresh + help. Never more than 5 rows.
   * @private
   */
  static _buildPagedListBoard({ entries, page = 1, totalPages = 1, pageCommand, refreshLabel, entryLabel, entryData, entryStyle }) {
    const list = Array.isArray(entries) ? entries.slice(0, 6) : [];
    const rawPage = Number(page);
    const rawTotalPages = Number(totalPages);
    const safePage = Number.isFinite(rawPage) ? Math.max(1, Math.trunc(rawPage)) : 1;
    const safeTotalPages = Number.isFinite(rawTotalPages) ? Math.max(1, Math.trunc(rawTotalPages)) : 1;
    const currentPage = Math.min(safePage, safeTotalPages);
    const rows = [];

    for (let i = 0; i < list.length; i += 2) {
      const row = [];
      for (let j = i; j < Math.min(i + 2, list.length); j++) {
        const entry = list[j];
        row.push(
          this.button({
            id: `entry_${j}`,
            label: entryLabel(entry),
            data: entryData(entry),
            style: entryStyle(entry),
          })
        );
      }
      rows.push(row);
    }

    if (safeTotalPages > 1) {
      const pageRow = [];
      if (currentPage > 1) {
        pageRow.push(
          this.button({ id: 'btn_list_prev', label: '⬅️ 上页', data: `${pageCommand} page ${currentPage - 1}` })
        );
      }
      pageRow.push(
        this.button({
          id: 'btn_list_page',
          label: `📄 ${currentPage}/${safeTotalPages} 页`,
          data: `${pageCommand} page ${currentPage}`,
        })
      );
      if (currentPage < safeTotalPages) {
        pageRow.push(
          this.button({ id: 'btn_list_next', label: '➡️ 下页', data: `${pageCommand} page ${currentPage + 1}` })
        );
      }
      rows.push(pageRow);
    }

    rows.push([
      this.button({ id: 'btn_list_refresh', label: refreshLabel, data: pageCommand }),
      this.button({ id: 'btn_help', label: '❓ 帮助', data: '/help' }),
    ]);

    return this.keyboard(rows);
  }
}
