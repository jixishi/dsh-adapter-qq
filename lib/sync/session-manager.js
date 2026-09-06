import { randomUUID } from 'node:crypto';
import { resolve, join, dirname, basename } from 'node:path';
import { readdir, mkdir, stat } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';

/**
 * Session and Workspace Manager for DSH
 * Bridges QQ user interactions to DSH session lifecycle, workspaces, dynamic presets, and permissions.
 */
export class SessionManager {
  /**
   * @param {Object} options
   * @param {import('@deepseek-ai/cordis').Context} options.ctx - Cordis host context
   * @param {Function} [options.getActiveSessionId] - Getter for persisted active session ID
   * @param {Function} [options.setActiveSessionId] - Setter to persist active session ID
   * @param {Object} [options.logger]
   */
  constructor({ ctx, getActiveSessionId, setActiveSessionId, logger = console }) {
    this.ctx = ctx;
    this.getActiveSessionIdFn = getActiveSessionId;
    this.setActiveSessionIdFn = setActiveSessionId;
    this.logger = logger;
    this.cachedActiveSessionId = null;
  }

  get sessions() {
    return this.ctx.get ? this.ctx.get('sessions') : this.ctx.sessions;
  }

  get sessionController() {
    return this.ctx.get ? this.ctx.get('sessionController') : this.ctx.sessionController;
  }

  get agents() {
    return this.ctx.get ? this.ctx.get('agents') : this.ctx.agents;
  }

  get agentPresets() {
    return this.ctx.get ? this.ctx.get('agentPresets') : this.ctx.agentPresets;
  }

  get permissionPresets() {
    return this.ctx.get ? this.ctx.get('permissionPresets') : this.ctx.permissionPresets;
  }

  get workspaceRegistry() {
    return this.ctx.get ? this.ctx.get('workspaceRegistry') : this.ctx.workspaceRegistry;
  }

  /**
   * Get currently active session ID (from memory, config, or latest session)
   * @returns {Promise<string|null>}
   */
  async getActiveSessionId() {
    if (this.cachedActiveSessionId) {
      return this.cachedActiveSessionId;
    }

    const persisted = this.getActiveSessionIdFn?.();
    if (persisted && (await this.sessionExists(persisted))) {
      this.cachedActiveSessionId = persisted;
      return persisted;
    }

    // Auto-select the latest session
    const latest = await this.findLatestSession();
    if (latest) {
      this.cachedActiveSessionId = latest.sessionId;
      this.setActiveSessionIdFn?.(latest.sessionId);
      return latest.sessionId;
    }

    return null;
  }

  /**
   * Set currently active session ID
   * @param {string} sessionId
   * @returns {Promise<boolean>}
   */
  async setActiveSessionId(sessionId) {
    if (!sessionId) return false;
    const exists = await this.sessionExists(sessionId);
    if (!exists) {
      throw new Error(`Session "${sessionId}" does not exist.`);
    }

    this.cachedActiveSessionId = sessionId;
    this.setActiveSessionIdFn?.(sessionId);
    this.logger.info?.(`[SessionManager] Active session switched to: ${sessionId}`);
    return true;
  }

  /**
   * Check if a session exists (either live or stored)
   * @param {string} sessionId
   * @returns {Promise<boolean>}
   */
  async sessionExists(sessionId) {
    if (!sessionId) return false;
    const live = this.sessions?.get(sessionId);
    if (live) return true;

    try {
      if (this.sessionController?.list) {
        const { items } = await this.sessionController.list({});
        return items?.some((s) => s.sessionId === sessionId || s.id === sessionId);
      }
    } catch {
      // fallback
    }

    return false;
  }

  /**
   * Find the most recently updated session
   * @returns {Promise<Object|null>}
   */
  async findLatestSession() {
    const list = await this.listSessions();
    if (list.length === 0) return null;
    return list[0];
  }

  /**
   * Resolve a human-readable title for a session
   * @param {string} sid - Session ID
   * @param {Object} [item] - Session summary item from sessionController
   * @param {Object} [live] - Live session object
   * @returns {string|null} - Return null if session is blank with no title
   */
  resolveSessionTitle(sid, item, live) {
    // 1. Direct title from item
    if (item?.title && item.title !== sid) return item.title;

    // 2. Direct title from projections (key is "title")
    const pTitle = item?.projections?.values?.title;
    if (typeof pTitle === 'string' && pTitle.trim() && pTitle !== sid) return pTitle.trim();
    if (pTitle?.val && typeof pTitle.val === 'string' && pTitle.val.trim() && pTitle.val !== sid) {
      return pTitle.val.trim();
    }

    // 3. Live session title or header
    if (live?.header?.title && live.header.title !== sid) return live.header.title;

    // 4. Try reading folded title from session_projcache
    try {
      const home = process.env.DSH_HOME || join(homedir(), '.dsh');
      const cachePath = join(home, 'storages', 'session_projcache', 'sessions', `${sid}.json`);
      if (existsSync(cachePath)) {
        const cache = JSON.parse(readFileSync(cachePath, 'utf8'));
        const titleVal = cache?.record?.rows?.title?.val;
        if (titleVal && typeof titleVal === 'string' && titleVal.trim() && titleVal !== sid) {
          return titleVal.trim();
        }
      }
    } catch {
      // ignore
    }

    // If blank/empty with no user-visible title, return null
    return null;
  }

  /**
   * Check if a session is a subagent session or seeded descendant
   * @param {string} sid - Session ID
   * @param {Object} [item] - Summary item
   * @returns {boolean}
   */
  isSubagentSession(sid, item) {
    if (item?.origin === 'subagent' || item?.parentSessionId || item?.isSeeded) {
      return true;
    }

    try {
      const home = process.env.DSH_HOME || join(homedir(), '.dsh');
      const cachePath = join(home, 'storages', 'session_projcache', 'sessions', `${sid}.json`);
      if (existsSync(cachePath)) {
        const cache = JSON.parse(readFileSync(cachePath, 'utf8'));
        if (cache?.record?.identity?.isSeeded || cache?.record?.identity?.origin === 'subagent' || cache?.record?.identity?.parentSession) {
          return true;
        }
      }
    } catch {
      // ignore
    }

    return false;
  }

  /**
   * List all sessions with detailed information
   * @returns {Promise<Array<Object>>}
   */
  async listSessions() {
    const sessions = [];

    // First try sessionController.list() which has all metadata and cold sessions
    if (this.sessionController?.list) {
      try {
        const result = await this.sessionController.list({});
        const items = result?.items || [];
        for (const item of items) {
          const sid = item.sessionId || item.id;
          if (this.isSubagentSession(sid, item)) {
            continue;
          }

          const live = this.sessions?.get(sid);
          const liveAgent = this.agents?.get(sid);

          const title = this.resolveSessionTitle(sid, item, live);
          const cwd = item.cwd || live?.header?.cwd || '';
          const preset =
            item.agentPreset ||
            item.projections?.values?.agentPreset ||
            live?.header?.agentPreset ||
            'standard';

          let permission = 'unknown';
          if (live && this.permissionPresets?.current) {
            try {
              permission = this.permissionPresets.current(live);
            } catch {
              // ignore
            }
          }

          const running = item.running ?? (liveAgent?.status === 'running');

          sessions.push({
            sessionId: sid,
            title: title || `新会话-${sid.slice(0, 8)}`,
            hasRealTitle: Boolean(title),
            cwd,
            agentPreset: preset,
            permission,
            running,
            blank: item.blank ?? !title,
            updatedAt: item.updatedAt || Date.now(),
          });
        }
      } catch (err) {
        this.logger.warn?.(`[SessionManager] sessionController.list() failed: ${err.message}`);
      }
    }

    // Fallback or augment with sessions.list()
    if (sessions.length === 0 && this.sessions?.list) {
      const liveList = this.sessions.list() || [];
      for (const live of liveList) {
        const sid = live.id;
        if (this.isSubagentSession(sid, live.header)) {
          continue;
        }

        const liveAgent = this.agents?.get(sid);
        let permission = 'unknown';
        if (this.permissionPresets?.current) {
          try {
            permission = this.permissionPresets.current(live);
          } catch {
            // ignore
          }
        }

        const title = this.resolveSessionTitle(sid, null, live);

        sessions.push({
          sessionId: sid,
          title: title || `新会话-${sid.slice(0, 8)}`,
          hasRealTitle: Boolean(title),
          cwd: live.header?.cwd || '',
          agentPreset: live.header?.agentPreset || 'standard',
          permission,
          running: liveAgent?.status === 'running',
          blank: !title,
          updatedAt: Date.now(),
        });
      }
    }

    // Sort by updatedAt descending
    sessions.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    return sessions;
  }

  /**
   * List all workspaces (both local and remote)
   * @returns {Promise<Array<Object>>}
   */
  async listWorkspaces() {
    const list = [];
    if (this.workspaceRegistry?.list) {
      try {
        const entities = this.workspaceRegistry.list();
        for (const ws of entities) {
          const isRemote =
            ws.path?.includes('remote-workspaces') ||
            ws.title?.includes(':~') ||
            ws.title?.includes('远程');
          list.push({
            id: ws.id,
            title: ws.title || basename(ws.path),
            path: ws.path,
            isRemote,
            sessionIds: Array.from(ws.sessionIds || []),
          });
        }
      } catch (err) {
        this.logger.warn?.(`[SessionManager] workspaceRegistry.list() failed: ${err.message}`);
      }
    }

    // Fallback if registry empty: read workspace.json directly
    if (list.length === 0) {
      try {
        const home = process.env.DSH_HOME || join(homedir(), '.dsh');
        const wsFile = join(home, 'storages', 'workspace.json');
        if (existsSync(wsFile)) {
          const data = JSON.parse(readFileSync(wsFile, 'utf8'));
          const order = data.global?.workspaceIds || [];
          const tables = data.tables?.workspaces || {};
          for (const id of order) {
            const row = tables[id];
            if (row) {
              const isRemote = row.path?.includes('remote-workspaces') || row.title?.includes(':~');
              list.push({
                id,
                title: row.title || basename(row.path),
                path: row.path,
                isRemote,
                sessionIds: Array.from(row.sessionIds || []),
              });
            }
          }
        }
      } catch {
        // ignore
      }
    }

    return list;
  }

  /**
   * List sessions grouped hierarchically by Workspace (matching DSH Sidebar)
   * @returns {Promise<{ groups: Array<{ workspace: Object, sessions: Array<Object> }>, allSessions: Array<Object> }>}
   */
  async listSessionsGroupedByWorkspace() {
    const allSessions = await this.listSessions();
    const workspaces = await this.listWorkspaces();
    const activeId = await this.getActiveSessionId();
    const archived = new Set(this.workspaceRegistry?.archivedSessionIds || []);

    const sessionMap = new Map(allSessions.map((s) => [s.sessionId, s]));
    const assignedSessionIds = new Set();
    const groups = [];
    const visibleSessions = [];
    let currentIndex = 1;

    // 1. Group by declared workspaces (matching Web UI workspace accounting)
    for (const ws of workspaces) {
      const wsSessions = [];
      const sessionIds = ws.sessionIds || [];

      for (const sid of sessionIds) {
        if (archived.has(sid)) continue;
        const s = sessionMap.get(sid);
        // Only include if session exists, is not a subagent, and is non-blank (unless currently active)
        if (s && (s.hasRealTitle || s.sessionId === activeId || !s.blank)) {
          const sessionItem = {
            ...s,
            index: currentIndex++,
          };
          wsSessions.push(sessionItem);
          visibleSessions.push(sessionItem);
          assignedSessionIds.add(sid);
        }
      }

      groups.push({
        workspace: ws,
        sessions: wsSessions,
      });
    }

    // 2. Loose sessions not matching any workspace (non-subagent, non-blank)
    const ungrouped = [];
    for (const s of allSessions) {
      if (!assignedSessionIds.has(s.sessionId) && !archived.has(s.sessionId)) {
        if (s.hasRealTitle || s.sessionId === activeId || !s.blank) {
          const sessionItem = {
            ...s,
            index: currentIndex++,
          };
          ungrouped.push(sessionItem);
          visibleSessions.push(sessionItem);
        }
      }
    }

    if (ungrouped.length > 0) {
      groups.push({
        workspace: {
          id: 'ungrouped',
          title: '其他会话 (未关联工作区)',
          path: '',
          isRemote: false,
        },
        sessions: ungrouped,
      });
    }

    return { groups, allSessions: visibleSessions };
  }

  /**
   * Browse a directory for new session creation
   * @param {string} dirPath - Directory to browse
   * @param {number} [page=1] - Page number (1-based)
   * @param {number} [pageSize=4] - Page size
   */
  async browseDirectory(dirPath, page = 1, pageSize = 4) {
    const target = resolve(dirPath || process.cwd());
    const stats = await stat(target);
    if (!stats.isDirectory()) {
      throw new Error(`路径不是目录: ${target}`);
    }

    const entries = await readdir(target, { withFileTypes: true });
    // Filter subdirectories only, exclude hidden dirs
    const subdirs = entries
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => e.name)
      .sort((a, b) => a.localeCompare(b));

    const totalPages = Math.max(1, Math.ceil(subdirs.length / pageSize));
    const safePage = Math.min(Math.max(1, page), totalPages);
    const offset = (safePage - 1) * pageSize;
    const pageSubdirs = subdirs.slice(offset, offset + pageSize);

    const parent = dirname(target);
    const canGoUp = parent !== target;

    return {
      currentPath: target,
      subdirs: pageSubdirs,
      allSubdirsCount: subdirs.length,
      page: safePage,
      totalPages,
      canGoUp,
      parentPath: canGoUp ? parent : null,
    };
  }

  /**
   * Create a subdirectory under parentPath
   * @param {string} parentPath
   * @param {string} name
   */
  async createDirectory(parentPath, name) {
    const cleanName = String(name || '').trim().replace(/[\\/:*?"<>|]/g, '');
    if (!cleanName) throw new Error('目录名称不合法');
    const newPath = join(parentPath, cleanName);
    await mkdir(newPath, { recursive: true });
    return newPath;
  }

  /**
   * Get detailed info for the current active session
   * @returns {Promise<Object|null>}
   */
  async getActiveSessionInfo() {
    const activeId = await this.getActiveSessionId();
    if (!activeId) return null;

    const all = await this.listSessions();
    const found = all.find((s) => s.sessionId === activeId);
    if (found) return found;

    const live = this.sessions?.get(activeId);
    if (live) {
      const liveAgent = this.agents?.get(activeId);
      let permission = 'unknown';
      if (this.permissionPresets?.current) {
        try {
          permission = this.permissionPresets.current(live);
        } catch {
          // ignore
        }
      }
      return {
        sessionId: activeId,
        title: this.resolveSessionTitle(activeId, null, live),
        cwd: live.header?.cwd || '',
        agentPreset: live.header?.agentPreset || 'standard',
        permission,
        running: liveAgent?.status === 'running',
        updatedAt: Date.now(),
      };
    }

    return { sessionId: activeId, title: this.resolveSessionTitle(activeId, null, null) };
  }

  /**
   * Create a new session
   * @param {Object} options
   * @param {string} [options.cwd] - Working directory path
   * @param {string} [options.preset] - Agent preset (standard, ptc, minimal, cordis, etc.)
   * @param {string} [options.sessionId] - Optional custom session ID
   * @param {string} [options.workspaceId] - Optional workspace ID to attach
   * @returns {Promise<Object>}
   */
  async createSession({ cwd, preset, sessionId, workspaceId } = {}) {
    const finalSessionId = sessionId || `session-${randomUUID()}`;
    const finalPreset = preset || 'standard';

    let resolvedCwd = cwd;
    if (!resolvedCwd && workspaceId) {
      const ws = this.workspaceRegistry?.get?.(workspaceId);
      if (ws) resolvedCwd = ws.path;
    }

    if (!resolvedCwd) {
      // Default to current active workspace or DSH default
      const workspaces = this.workspaceRegistry?.list?.() || [];
      if (workspaces.length > 0) {
        resolvedCwd = workspaces[0].path;
      } else {
        resolvedCwd = process.cwd();
      }
    }

    this.logger.info?.(`[SessionManager] Creating session: id=${finalSessionId}, cwd=${resolvedCwd}, preset=${finalPreset}`);

    if (this.sessionController?.create) {
      const result = await this.sessionController.create({
        sessionId: finalSessionId,
        cwd: resolvedCwd,
        agentPreset: finalPreset,
      });

      await this.setActiveSessionId(finalSessionId);
      return {
        sessionId: finalSessionId,
        cwd: resolvedCwd,
        agentPreset: result?.agentPreset || finalPreset,
      };
    }

    if (this.sessions?.create) {
      const session = this.sessions.create(finalSessionId, {
        cwd: resolvedCwd,
        agentPreset: finalPreset,
      });

      await this.setActiveSessionId(finalSessionId);
      return {
        sessionId: session.id,
        cwd: resolvedCwd,
        agentPreset: finalPreset,
      };
    }

    throw new Error('No session creation service available in DSH context.');
  }

  /**
   * Dynamically fetch all agent presets from DSH (built-in + user custom)
   * Never hardcoded.
   * @returns {Promise<Array<Object>>}
   */
  async listPresets() {
    const presets = [];

    if (this.agentPresets?.list) {
      try {
        const list = await this.agentPresets.list();
        for (const item of list) {
          presets.push({
            id: item.id,
            trust: item.trust, // 'system' (built-in) or 'user' (custom)
            name: item.name || item.id,
            description: item.description || (item.trust === 'system' ? '内置预设' : '用户自定义预设'),
            path: item.path,
          });
        }
      } catch (err) {
        this.logger.warn?.(`[SessionManager] agentPresets.list() failed: ${err.message}`);
      }
    }

    // Fallback if registry empty
    if (presets.length === 0) {
      return [
        { id: 'standard', trust: 'system', name: '标准模式 (Standard)', description: '完整编码 Agent，支持文件、Shell、检索、工作流等全量能力' },
        { id: 'ptc', trust: 'system', name: 'PTC模式 (PTC)', description: '完整编码 Agent，通过 TypeScript 程序组合多步操作' },
        { id: 'minimal', trust: 'system', name: '极简模式 (Minimal)', description: '轻量极简，仅持久 bash + str_replace_editor 双工具' },
        { id: 'cordis', trust: 'system', name: '创造模式 (Cordis)', description: '用于自定义预设与插件创作，具备运行时检查指导' },
      ];
    }

    return presets;
  }

  /**
   * Switch preset for the active session
   * @param {string} presetName
   * @returns {Promise<string>}
   */
  async switchPreset(presetName) {
    if (!presetName) throw new Error('Preset name is required.');
    const activeId = await this.getActiveSessionId();
    if (!activeId) throw new Error('No active session.');

    const liveAgent = this.agents?.get(activeId);
    if (!liveAgent) {
      throw new Error(`Session "${activeId}" agent is not currently active.`);
    }

    if (this.agentPresets?.select) {
      return await this.agentPresets.select(liveAgent, presetName);
    }

    throw new Error('agentPresets service is not available in DSH context.');
  }

  /**
   * List available permission presets in DSH
   * @returns {Array<Object>}
   */
  listPermissions() {
    const defaultDescriptions = {
      'read-only': '只读模式：只允许读取文件和环境，不允许写入或修改',
      'workspace-write': '工作区写入模式：允许读写工作区内文件与执行安全命令，越界触发审批',
      'danger-full-access': '全系统模式：允许操作整个系统，无需额外审批',
    };

    if (this.permissionPresets?.names) {
      const names = this.permissionPresets.names;
      return names.map((name) => {
        const spec = this.permissionPresets.resolve?.(name);
        return {
          id: name,
          name: spec?.name || name,
          description: spec?.description || defaultDescriptions[name] || name,
        };
      });
    }

    return [
      { id: 'read-only', name: '只读模式', description: defaultDescriptions['read-only'] },
      { id: 'workspace-write', name: '工作区写入', description: defaultDescriptions['workspace-write'] },
      { id: 'danger-full-access', name: '全系统模式', description: defaultDescriptions['danger-full-access'] },
    ];
  }

  /**
   * Switch permission preset for active session
   * @param {string} permissionMode - e.g. 'read-only', 'workspace-write', 'danger-full-access' or friendly names
   * @returns {string} The normalized preset name applied
   */
  switchPermission(permissionMode) {
    const activeId = this.cachedActiveSessionId;
    if (!activeId) throw new Error('No active session.');

    const live = this.sessions?.get(activeId);
    if (!live) {
      throw new Error(`Session "${activeId}" is not loaded in memory.`);
    }

    // Map friendly Chinese / English aliases
    const aliasMap = {
      readonly: 'read-only',
      'read-only': 'read-only',
      只读: 'read-only',
      只读模式: 'read-only',
      workspace: 'workspace-write',
      'workspace-write': 'workspace-write',
      工作区: 'workspace-write',
      工作区写入: 'workspace-write',
      danger: 'danger-full-access',
      'danger-full-access': 'danger-full-access',
      全系统: 'danger-full-access',
      全系统模式: 'danger-full-access',
      full: 'danger-full-access',
    };

    const targetMode = aliasMap[permissionMode?.toLowerCase()?.trim()] || permissionMode;

    if (!this.permissionPresets?.set) {
      throw new Error('permissionPresets service is not available in DSH context.');
    }

    this.permissionPresets.set(live, targetMode);
    return targetMode;
  }

  /**
   * Cancel active turn for current session
   * @returns {Promise<boolean>}
   */
  async cancelActiveTurn() {
    const activeId = await this.getActiveSessionId();
    if (!activeId) return false;

    if (this.sessionController?.cancel) {
      try {
        await this.sessionController.cancel({ sessionId: activeId });
        return true;
      } catch (err) {
        this.logger.warn?.(`[SessionManager] Cancel failed: ${err.message}`);
      }
    }

    const liveAgent = this.agents?.get(activeId);
    if (liveAgent?.cancel) {
      liveAgent.cancel();
      return true;
    }

    return false;
  }
}
