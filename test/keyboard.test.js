import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { KeyboardBuilder } from '../lib/ui/keyboard.js';

describe('KeyboardBuilder', () => {
  it('should build a single button conforming to QQ InlineKeyboard schema', () => {
    const btn = KeyboardBuilder.button({
      id: 'btn_1',
      label: '测试按钮',
      data: '/sessions',
      style: 1,
      enter: true,
    });

    assert.equal(btn.id, 'btn_1');
    assert.equal(btn.render_data.label, '测试按钮');
    assert.equal(btn.render_data.style, 1);
    assert.equal(btn.action.type, 1); // Callback button
    assert.equal(btn.action.data, '/sessions');
    assert.equal(btn.action.enter, true);
    assert.equal(btn.action.permission.type, 2);
    assert.ok(btn.action.unsupport_tips);
  });

  it('should wrap buttons into rows matrix <= 5 rows and <= 5 cols', () => {
    const rows = [
      [
        KeyboardBuilder.button({ id: '1', label: 'B1', data: '1' }),
        KeyboardBuilder.button({ id: '2', label: 'B2', data: '2' }),
      ],
      [
        KeyboardBuilder.button({ id: '3', label: 'B3', data: '3' }),
      ],
    ];

    const kb = KeyboardBuilder.keyboard(rows);
    assert.ok(kb.content);
    assert.equal(kb.content.rows.length, 2);
    assert.equal(kb.content.rows[0].buttons.length, 2);
    assert.equal(kb.content.rows[1].buttons.length, 1);
  });

  it('should generate help board with standard shortcuts', () => {
    const kb = KeyboardBuilder.buildHelpBoard();
    assert.ok(kb.content.rows.length >= 3);
    const allData = kb.content.rows.flatMap((r) => r.buttons.map((b) => b.action.data));
    assert.ok(allData.includes('/sessions'));
    assert.ok(allData.includes('/current'));
    assert.ok(allData.includes('/new'));
    assert.ok(allData.includes('/preset'));
    assert.ok(allData.includes('/permission'));
    assert.ok(allData.includes('/cancel'));
  });

  it('should generate paginated sessions board with emoji labels within 10 code points', () => {
    const mockSessions = [
      { sessionId: 'sess-1', title: '开发需求单', index: 1, emoji: '🍎', running: true },
      { sessionId: 'sess-2', title: '界面重叠分析报告', index: 2, emoji: '🍊', running: false },
      { sessionId: 'sess-3', title: '插件接口对齐', index: 3, emoji: '🍋', running: false },
      { sessionId: 'sess-4', title: '远程运维', index: 4, emoji: '🍇', running: false },
      { sessionId: 'sess-5', title: '模型切换', index: 5, emoji: '🍉', running: false },
      { sessionId: 'sess-6', title: '渲染管线', index: 6, emoji: '🍓', running: false },
    ];
    const kb = KeyboardBuilder.buildSessionsBoard({
      sessions: mockSessions,
      activeSessionId: 'sess-1',
      page: 1,
      totalPages: 3,
    });

    assert.ok(kb.content.rows.length <= 5, 'board must fit in at most 5 rows');
    for (const row of kb.content.rows) {
      assert.ok(row.buttons.length <= 5, 'each row must fit at most 5 buttons');
    }

    const sessionButtons = kb.content.rows.slice(0, 3).flatMap((r) => r.buttons);
    assert.equal(sessionButtons.length, 6);
    for (const btn of sessionButtons) {
      assert.ok(Array.from(btn.render_data.label).length <= 10, `label too long: ${btn.render_data.label}`);
    }

    // Active session: star prefix, blue style, session command
    assert.equal(sessionButtons[0].action.data, '/switch sess-1');
    assert.equal(sessionButtons[0].render_data.style, 1);
    assert.ok(sessionButtons[0].render_data.label.startsWith('⭐🍎1.'));

    // Inactive session: emoji + index + title, no star
    assert.equal(sessionButtons[1].action.data, '/switch sess-2');
    assert.equal(sessionButtons[1].render_data.style, 0);
    assert.ok(sessionButtons[1].render_data.label.startsWith('🍊2.'));

    // Every session on one page gets its own emoji prefix
    const emojiPrefixes = sessionButtons.map((btn) =>
      Array.from(btn.render_data.label).find((ch) => '🍎🍊🍋🍇🍉🍓'.includes(ch))
    );
    assert.equal(new Set(emojiPrefixes).size, 6);

    // Paging row
    const pagerData = kb.content.rows[3].buttons.map((b) => b.action.data);
    assert.ok(pagerData.includes('/sessions page 2'));
    assert.ok(!pagerData.includes('/sessions page 0'));

    // Bottom row keeps new + refresh
    const lastRowData = kb.content.rows[kb.content.rows.length - 1].buttons.map((b) => b.action.data);
    assert.deepEqual(lastRowData, ['/new', '/sessions']);
  });

  it('should omit the sessions pager row on a single page', () => {
    const kb = KeyboardBuilder.buildSessionsBoard({
      sessions: [{ sessionId: 'sess-1', title: '只有一个会话', index: 1, emoji: '🍎' }],
      activeSessionId: 'sess-1',
      page: 1,
      totalPages: 1,
    });

    const allData = kb.content.rows.flatMap((r) => r.buttons.map((b) => b.action.data));
    assert.ok(!allData.some((data) => data.startsWith('/sessions page')));
    assert.equal(kb.content.rows.length, 2);
    assert.equal(kb.content.rows[0].buttons[0].action.data, '/switch sess-1');
  });

  it('should clamp an out-of-range sessions page instead of emitting bad page data', () => {
    const sessions = Array.from({ length: 6 }, (_, i) => ({
      sessionId: `sess-${i + 1}`,
      title: `会话${i + 1}`,
      index: i + 13,
      emoji: ['🍎', '🍊', '🍋', '🍇', '🍉', '🍓'][i],
    }));

    const kb = KeyboardBuilder.buildSessionsBoard({ sessions, activeSessionId: 'sess-9', page: 9, totalPages: 3 });
    const pager = kb.content.rows[3].buttons;
    const pagerLabels = pager.map((b) => b.render_data.label);
    const pagerData = pager.map((b) => b.action.data);

    assert.ok(pagerLabels.includes('📄 3/3 页'));
    assert.ok(!pagerData.includes('/sessions page 10'));
    assert.ok(!pagerData.includes('/sessions page 4'));
    // 2-digit session indexes still fit the label budget
    for (const btn of kb.content.rows.slice(0, 3).flatMap((r) => r.buttons)) {
      assert.ok(Array.from(btn.render_data.label).length <= 10);
    }
  });

  it('should truncate labels by code points without splitting emoji', () => {
    assert.equal(KeyboardBuilder.truncateLabel('🍎1.开发需求单分析报告', 10), '🍎1.开发需求单分析');
    assert.equal(Array.from(KeyboardBuilder.truncateLabel('🍇2.界面重叠分析报告', 10)).length, 10);
    assert.equal(KeyboardBuilder.truncateLabel('短标题', 10), '短标题');
    assert.equal(KeyboardBuilder.truncateLabel('', 10), '');
  });

  it('should generate new session workspace selection board with remote support', () => {
    const mockWorkspaces = [
      { id: 'ws_local', title: 'qq-bot', path: '/workspaces/qq-bot', isRemote: false },
      { id: 'ws_remote', title: '免费:~', path: '/remote-workspaces/123', isRemote: true },
    ];
    const kb = KeyboardBuilder.buildNewSessionWorkspacesBoard(mockWorkspaces);
    assert.ok(kb.content.rows.length >= 2);
    const b1 = kb.content.rows[0].buttons[0];
    const b2 = kb.content.rows[0].buttons[1];
    assert.ok(b1.render_data.label.includes('qq-bot'));
    assert.equal(b1.action.data, '/new select-ws ws_local');
    assert.ok(b2.render_data.label.includes('(远)'));
    assert.equal(b2.action.data, '/new select-ws ws_remote');

    // Bottom row has browse option
    const lastRow = kb.content.rows[kb.content.rows.length - 1].buttons;
    assert.equal(lastRow[0].action.data, '/new browse');
  });

  it('should generate directory browser board with subdirs and pagination', () => {
    const kb = KeyboardBuilder.buildDirectoryBrowserBoard({
      currentPath: '/workspaces',
      subdirs: ['qq-bot', 'demo-app'],
      page: 1,
      totalPages: 2,
      canGoUp: true,
    });

    assert.ok(kb.content.rows.length >= 3);
    const subButtons = kb.content.rows[0].buttons;
    assert.equal(subButtons.length, 2);
    assert.ok(subButtons[0].render_data.label.includes('qq-bot'));
    assert.ok(subButtons[0].action.data.includes('/new enter-dir'));

    const allData = kb.content.rows.flatMap((r) => r.buttons.map((b) => b.action.data));
    assert.ok(allData.includes('/new up-dir'));
    assert.ok(allData.includes('/new page 2'));
    assert.ok(allData.includes('/new prompt-mkdir'));
    assert.ok(allData.includes('/new confirm-dir'));
  });

  it('should generate approval board with allow and reject buttons', () => {
    const kb = KeyboardBuilder.buildApprovalBoard('appr_123');
    const buttons = kb.content.rows[0].buttons;
    assert.equal(buttons.length, 2);
    assert.equal(buttons[0].action.data, '/approve appr_123');
    assert.equal(buttons[1].action.data, '/reject appr_123');
  });

  it('should generate presets board', () => {
    const presets = [
      { id: 'standard', name: 'Standard' },
      { id: 'ptc', name: 'PTC' },
    ];
    const kb = KeyboardBuilder.buildPresetsBoard(presets, 'standard');
    assert.ok(kb.content.rows.length >= 2);
    const b1 = kb.content.rows[0].buttons[0];
    assert.ok(b1.render_data.label.includes('✅'));
    assert.equal(b1.action.data, '/preset standard');
  });

  it('should generate permissions board', () => {
    const perms = [
      { id: 'read-only', name: '只读' },
      { id: 'workspace-write', name: '工作区写入' },
    ];
    const kb = KeyboardBuilder.buildPermissionsBoard(perms, 'workspace-write');
    const b2 = kb.content.rows[0].buttons[1];
    assert.ok(b2.render_data.label.includes('✅'));
    assert.equal(b2.action.data, '/permission workspace-write');
  });

  it('should generate skills board with paging and refresh', () => {
    const skills = [
      { name: 'pdf-converter' },
      { name: 'excel-automation' },
      { name: 'genui' },
      { name: 'office-docx' },
      { name: 'kicad-pcb' },
      { name: 'smart-ocr' },
    ];
    const kb = KeyboardBuilder.buildSkillsBoard({ skills, page: 2, totalPages: 2 });

    assert.ok(kb.content.rows.length <= 5);
    const entryButtons = kb.content.rows.slice(0, 3).flatMap((r) => r.buttons);
    assert.equal(entryButtons.length, 6);
    assert.equal(entryButtons[0].action.data, '/skills pdf-converter');
    assert.equal(entryButtons[0].render_data.label, 'pdf-conver');
    for (const btn of entryButtons) {
      assert.ok(Array.from(btn.render_data.label).length <= 10);
    }

    const allData = kb.content.rows.flatMap((r) => r.buttons.map((b) => b.action.data));
    assert.ok(allData.includes('/skills page 1'));
    assert.ok(allData.includes('/skills'));
    assert.ok(allData.includes('/help'));
  });

  it('should generate skill detail board with the correct toggle direction', () => {
    const enabledBoard = KeyboardBuilder.buildSkillDetailBoard({ name: 'pdf-converter', enabled: true });
    assert.equal(enabledBoard.content.rows[0].buttons[0].action.data, '/skill off pdf-converter');
    assert.ok(enabledBoard.content.rows[0].buttons[0].render_data.label.includes('🚫'));

    const disabledBoard = KeyboardBuilder.buildSkillDetailBoard({ name: 'pdf-converter', enabled: false });
    assert.equal(disabledBoard.content.rows[0].buttons[0].action.data, '/skill on pdf-converter');
    assert.ok(disabledBoard.content.rows[0].buttons[0].render_data.label.includes('✅'));

    const allData = enabledBoard.content.rows.flatMap((r) => r.buttons.map((b) => b.action.data));
    assert.ok(allData.includes('/skills'));
    assert.ok(allData.includes('/help'));
  });

  it('should generate MCP board with server ids and paging', () => {
    const servers = [
      { id: 'mcp-stepfun-web-search', serverName: 'stepfun-web-search', enabled: true },
      { id: 'mcp-kicad', serverName: 'kicad', enabled: false },
    ];
    const kb = KeyboardBuilder.buildMcpBoard({ servers, page: 1, totalPages: 2 });

    const first = kb.content.rows[0].buttons[0];
    assert.equal(first.action.data, '/mcp mcp-stepfun-web-search');
    assert.ok(Array.from(first.render_data.label).length <= 10);
    assert.equal(kb.content.rows[0].buttons[1].render_data.style, 0);

    const allData = kb.content.rows.flatMap((r) => r.buttons.map((b) => b.action.data));
    assert.ok(allData.includes('/mcp page 2'));
    assert.ok(allData.includes('/mcp'));
    assert.ok(allData.includes('/help'));
  });

  it('should generate MCP detail board and degrade to read-only', () => {
    const managed = KeyboardBuilder.buildMcpDetailBoard({ id: 'mcp-kicad', enabled: true, canManage: true });
    const managedData = managed.content.rows.flatMap((r) => r.buttons.map((b) => b.action.data));
    assert.ok(managedData.includes('/mcp off mcp-kicad'));
    assert.ok(managedData.includes('/mcp restart mcp-kicad'));
    assert.ok(managedData.includes('/mcp'));

    const readOnly = KeyboardBuilder.buildMcpDetailBoard({ id: 'mcp-kicad', enabled: true, canManage: false });
    const readOnlyData = readOnly.content.rows.flatMap((r) => r.buttons.map((b) => b.action.data));
    assert.deepEqual(readOnlyData, ['/mcp']);
  });

  it('should generate render shortcut board', () => {
    const kb = KeyboardBuilder.buildRenderBoard();
    const allData = kb.content.rows.flatMap((r) => r.buttons.map((b) => b.action.data));
    assert.ok(allData.includes('/render'));
    assert.ok(allData.includes('/help'));
    assert.ok(kb.content.rows[0].buttons[0].render_data.label.includes('渲染'));
  });

  it('should build a multi-select question board with submit/clear and selected marks', () => {
    const kb = KeyboardBuilder.buildQuestionBoard(
      'req_1',
      [{ label: '日志' }, { label: '告警' }],
      { selected: ['日志'], multiSelect: true }
    );
    const rows = kb.content.rows;
    const firstRow = rows[0].buttons;
    assert.equal(firstRow[0].action.data, `/answer req_1 ${encodeURIComponent('日志')}`);
    assert.ok(firstRow[0].render_data.label.includes('✅'));
    assert.equal(firstRow[0].render_data.style, 1);
    assert.equal(firstRow[1].render_data.style, 0);

    const lastRowData = rows.at(-1).buttons.map((b) => b.action.data);
    assert.deepEqual(lastRowData, ['/answer req_1 __submit__', '/answer req_1 __clear__']);
  });

  it('should keep single-select question board free of submit row', () => {
    const kb = KeyboardBuilder.buildQuestionBoard('req_2', ['A 方案', 'B 方案']);
    const allData = kb.content.rows.flatMap((r) => r.buttons.map((b) => b.action.data));
    assert.ok(!allData.some((data) => data.includes('__submit__')));
    assert.ok(allData.every((label) => label.startsWith('/answer req_2 ')));
  });
});
