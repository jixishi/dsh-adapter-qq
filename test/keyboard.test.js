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

  it('should generate sessions board with friendly titles and numbering', () => {
    const mockSessions = [
      { sessionId: 'sess-1', title: '开发需求单', index: 1 },
      { sessionId: 'sess-2', title: '界面重叠分析', index: 2 },
    ];
    const kb = KeyboardBuilder.buildSessionsBoard(mockSessions, 'sess-1');
    const firstRowButtons = kb.content.rows[0].buttons;
    assert.equal(firstRowButtons.length, 2);
    assert.ok(firstRowButtons[0].render_data.label.includes('⭐'));
    assert.ok(firstRowButtons[0].render_data.label.includes('1.'));
    assert.equal(firstRowButtons[0].action.data, '/switch sess-1');
    assert.equal(firstRowButtons[1].action.data, '/switch sess-2');
  });

  it('should generate new session workspace selection board with remote support', () => {
    const mockWorkspaces = [
      { id: 'ws_local', title: 'qq-bot', path: 'F:/dsh-plugin/qq-bot', isRemote: false },
      { id: 'ws_remote', title: '免费:~', path: 'C:/Users/lydxh/.dsh/remote-workspaces/123', isRemote: true },
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
      currentPath: 'F:/dsh-plugin',
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
});
