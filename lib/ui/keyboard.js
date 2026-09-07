/**
 * QQ Open Platform InlineKeyboard Builder for Action Boards
 * Reference: https://bot.q.qq.com/wiki/develop/nodesdk/model/inline_keyboard.html
 */

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
        label: String(label).slice(0, 20),
        visited_label: String(visitedLabel || label).slice(0, 20),
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
   * Build sessions list action board with friendly numbered session titles
   * @param {Array<Object>} sessions - Sessions array with title, index, etc.
   * @param {string} activeSessionId - Currently active session ID
   */
  static buildSessionsBoard(sessions, activeSessionId) {
    const rows = [];
    const list = (sessions || []).slice(0, 6);

    // Group sessions in pairs of 2 buttons
    for (let i = 0; i < list.length; i += 2) {
      const row = [];
      const s1 = list[i];
      const isActive1 = s1.sessionId === activeSessionId;
      const title1 = (s1.title || s1.sessionId).slice(0, 9);
      const label1 = `${isActive1 ? '⭐ ' : ''}${s1.index ? s1.index + '. ' : ''}${title1}`;
      row.push(
        this.button({
          id: `sw_${i}`,
          label: label1,
          data: `/switch ${s1.sessionId}`,
          style: isActive1 ? 1 : 0,
        })
      );

      if (i + 1 < list.length) {
        const s2 = list[i + 1];
        const isActive2 = s2.sessionId === activeSessionId;
        const title2 = (s2.title || s2.sessionId).slice(0, 9);
        const label2 = `${isActive2 ? '⭐ ' : ''}${s2.index ? s2.index + '. ' : ''}${title2}`;
        row.push(
          this.button({
            id: `sw_${i + 1}`,
            label: label2,
            data: `/switch ${s2.sessionId}`,
            style: isActive2 ? 1 : 0,
          })
        );
      }
      rows.push(row);
      if (rows.length >= 3) break;
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
      this.button({ id: 'btn_preset', label: '⚙️ 切换预设', data: '/preset' }),
    ];
    const row2 = [
      this.button({ id: 'btn_perm', label: '🛡️ 切换权限', data: '/permission' }),
      this.button({ id: 'btn_stats', label: '📊 统计信息', data: '/stats' }),
    ];
    const row3 = [
      this.button({ id: 'btn_cancel', label: '🛑 停止执行', data: '/cancel' }),
      this.button({ id: 'btn_list', label: '📋 会话列表', data: '/sessions' }),
    ];
    return this.keyboard([row1, row2, row3]);
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
      this.button({ id: 'btn_list', label: '📋 会话列表', data: '/sessions' }),
    ];
    return this.keyboard([row1, row2]);
  }

  /**
   * Build model selection action board
   * @param {Array<Object>} models - Available models
   * @param {string} currentModelId - Currently selected model ID
   */
  static buildModelsBoard(models, currentModelId) {
    const rows = [];
    const list = (models || []).slice(0, 8);

    for (let i = 0; i < list.length; i += 2) {
      const row = [];
      const m1 = list[i];
      const isCur1 = m1.id === currentModelId;
      row.push(
        this.button({
          id: `mod_${i}`,
          label: `${isCur1 ? '✅ ' : ''}${m1.id.slice(0, 14)}`,
          data: `/model ${m1.id}`,
          style: isCur1 ? 1 : 0,
        })
      );

      if (i + 1 < list.length) {
        const m2 = list[i + 1];
        const isCur2 = m2.id === currentModelId;
        row.push(
          this.button({
            id: `mod_${i + 1}`,
            label: `${isCur2 ? '✅ ' : ''}${m2.id.slice(0, 14)}`,
            data: `/model ${m2.id}`,
            style: isCur2 ? 1 : 0,
          })
        );
      }
      rows.push(row);
      if (rows.length >= 4) break;
    }

    rows.push([
      this.button({ id: 'btn_back_curr', label: '📌 返回当前会话', data: '/current' }),
      this.button({ id: 'btn_list', label: '📋 会话列表', data: '/sessions' }),
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
}
