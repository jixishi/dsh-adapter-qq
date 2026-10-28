/**
 * Admin inventory for skills and MCP servers.
 *
 * The optional `@xxxyz/dsh-mcp-manager` plugin exposes a same-origin HTTP API
 * that owns enable/disable state for skills and MCP servers. This client talks
 * to that API when it is reachable and degrades to the core DSH services
 * (`skills`, `tools`) for read-only listings otherwise. No method ever throws
 * into the bridge: failures are reported as `{ ok: false, error }` or
 * `{ available: false, … }` results.
 */

const API_PATH = '/dsh-mcp-manager/api';
const API_TIMEOUT_MS = 2500;
const AVAILABILITY_TTL_MS = 15000;
const PLUGIN_GATE_HEADER = 'dsh-mcp-manager';
const MCP_TOOL_PREFIX = /^mcp__([A-Za-z0-9_-]+)__/;
const MCP_MANAGER_MISSING_NOTE = '未安装或无法连接 dsh-mcp-manager 插件，当前为只读模式';

/**
 * Normalize a skill row coming from either the mcp-manager API or the core
 * skills snapshot into the shape the QQ UI consumes.
 * @param {Object} row
 * @returns {Object}
 */
function normalizeSkill(row) {
  const skill = row && typeof row === 'object' ? row : {};
  const invocation = skill.invocation && typeof skill.invocation === 'object' ? skill.invocation : {};
  const normalized = {
    name: String(skill.name ?? ''),
    description: String(skill.description ?? ''),
    invocation: {
      modelInvocable: invocation.modelInvocable !== false,
      userInvocable: invocation.userInvocable !== false,
    },
    source: String(skill.source ?? ''),
    provider: String(skill.provider ?? ''),
    disabled: skill.disabled === true,
    userLevel:
      skill.userLevel === true || skill.source === 'user-dsh' || skill.source === 'user-agents',
  };
  if (skill.whenToUse) normalized.whenToUse = String(skill.whenToUse);
  if (skill.path) normalized.path = String(skill.path);
  return normalized;
}

/**
 * Normalize one `mcpm-list` row into the flat shape used by the UI.
 * @param {Object} row
 * @returns {Object}
 */
function normalizeMcpRow(row) {
  const source = row && typeof row === 'object' ? row : {};
  const id = String(source.id ?? source.serverName ?? '');
  const live = source.live && typeof source.live === 'object' ? source.live : null;
  const level = String(source.level ?? 'profile');
  const readOnly = source.readOnly === true || level === 'home' || level === 'loader';
  const normalized = {
    id,
    serverName: String(source.serverName || id),
    transport: String(source.transport ?? ''),
    level,
    disabled: source.disabled === true,
    readOnly,
    enabled: live ? live.enabled !== false : source.disabled !== true,
    toolCount: Number.isFinite(source.toolCount) ? source.toolCount : 0,
  };
  if (live && live.phase) normalized.phase = String(live.phase);
  if (source.readOnlyReason) normalized.readOnlyReason = String(source.readOnlyReason);
  return normalized;
}

/**
 * Read the error message off anything that was thrown.
 * @param {unknown} error
 * @returns {string}
 */
function errorMessage(error) {
  if (error && typeof error === 'object' && typeof error.message === 'string') return error.message;
  return String(error ?? 'unknown error');
}

export class AdminInventory {
  /**
   * @param {Object} options
   * @param {Object} options.ctx - Cordis host context
   * @param {Function} [options.getConfig] - Returns the resolved adapter config
   * @param {Object} [options.logger]
   */
  constructor({ ctx, getConfig, logger = console } = {}) {
    this.ctx = ctx;
    this.getConfig = typeof getConfig === 'function' ? getConfig : () => ({});
    this.logger = logger || console;
    /** @type {{ available: boolean|null, checkedAt: number, error: string }} */
    this.apiState = { available: null, checkedAt: 0, error: '' };
  }

  /**
   * Resolve a host service, tolerating both the `ctx.get(id)` accessor form and
   * plain property access.
   * @param {string} id
   * @returns {any}
   */
  service(id) {
    const ctx = this.ctx;
    if (!ctx) return undefined;
    try {
      if (typeof ctx.get === 'function') return ctx.get(id);
      return ctx[id];
    } catch {
      return undefined;
    }
  }

  /**
   * @returns {Object}
   */
  config() {
    try {
      const value = this.getConfig();
      return value && typeof value === 'object' ? value : {};
    } catch {
      return {};
    }
  }

  /**
   * Resolve the local Web origin used by the mcp-manager API.
   * @returns {string}
   */
  resolveOrigin() {
    const webServer = this.service('webServer');
    try {
      if (webServer && typeof webServer.getOrigin === 'function') {
        const origin = webServer.getOrigin();
        if (origin) return String(origin).replace(/\/+$/, '');
      }
    } catch {
      /* headless / not ready yet */
    }
    const webApp = this.service('webApp');
    try {
      if (webApp && typeof webApp.getAdvertisedUrl === 'function') {
        const url = webApp.getAdvertisedUrl();
        if (url) return String(url).replace(/\/+$/, '');
      }
    } catch {
      /* headless / not ready yet */
    }
    const envOrigin = process.env.DSH_WEB_ORIGIN;
    if (envOrigin) return String(envOrigin).trim().replace(/\/+$/, '');
    return '';
  }

  /**
   * @returns {string}
   */
  resolveToken() {
    const configured = this.config().mcpManagerToken;
    if (typeof configured === 'string' && configured) return configured;
    const fromEnv = process.env.DSH_MCP_MANAGER_TOKEN;
    return typeof fromEnv === 'string' ? fromEnv : '';
  }

  /**
   * Record that the management API is currently unusable. Repeated failures are
   * cached for AVAILABILITY_TTL_MS so UI refreshes do not hammer a dead port.
   * @param {string} message
   */
  markUnavailable(message) {
    const wasAvailable = this.apiState.available === true;
    this.apiState = { available: false, checkedAt: Date.now(), error: message };
    if (wasAvailable) this.logger.warn?.(`[AdminInventory] ${message}`);
  }

  markAvailable() {
    this.apiState = { available: true, checkedAt: Date.now(), error: '' };
  }

  /** Drop the cached API availability (the /skills and /mcp refresh buttons use this). */
  invalidate() {
    this.apiState = { available: null, checkedAt: 0, error: '' };
  }

  /**
   * Whether the API was proven unavailable recently.
   * @returns {boolean}
   */
  isCoolingDown() {
    return (
      this.apiState.available === false &&
      Date.now() - this.apiState.checkedAt < AVAILABILITY_TTL_MS
    );
  }

  /**
   * POST one operation to the mcp-manager API.
   * @param {string} op
   * @param {Object} [args]
   * @returns {Promise<{ ok: boolean, unavailable: boolean, body?: Object, error?: string }>}
   */
  async callApi(op, args = {}) {
    const origin = this.resolveOrigin();
    if (!origin) {
      return {
        ok: false,
        unavailable: true,
        error: '未找到 DSH Web 服务地址，dsh-mcp-manager 不可用',
      };
    }
    if (this.isCoolingDown()) {
      return { ok: false, unavailable: true, error: this.apiState.error };
    }

    const token = this.resolveToken();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), API_TIMEOUT_MS);
    try {
      const response = await fetch(`${origin}${API_PATH}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-dsh-plugin': PLUGIN_GATE_HEADER,
          ...(token ? { 'x-dsh-token': token } : {}),
        },
        body: JSON.stringify({ op, args: args ?? {} }),
        signal: controller.signal,
      });

      if (!response || !response.ok) {
        const status = response && typeof response.status === 'number' ? response.status : 'unknown';
        const message = `dsh-mcp-manager 接口不可用（HTTP ${status}）`;
        this.markUnavailable(message);
        return { ok: false, unavailable: true, error: message };
      }

      let body;
      try {
        body = await response.json();
      } catch {
        const message = 'dsh-mcp-manager 返回了非 JSON 响应';
        this.markUnavailable(message);
        return { ok: false, unavailable: true, error: message };
      }
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        const message = 'dsh-mcp-manager 响应格式异常';
        this.markUnavailable(message);
        return { ok: false, unavailable: true, error: message };
      }

      this.markAvailable();
      return {
        ok: body.ok !== false,
        unavailable: false,
        ...(body.ok === false ? { error: String(body.error || '操作失败') } : {}),
        body,
      };
    } catch (error) {
      const aborted = controller.signal.aborted || error?.name === 'AbortError';
      const message = aborted
        ? `dsh-mcp-manager 接口响应超时（${API_TIMEOUT_MS}ms）`
        : `dsh-mcp-manager 接口请求失败：${errorMessage(error)}`;
      this.markUnavailable(message);
      return { ok: false, unavailable: true, error: message };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Read the core skills snapshot, tolerating a missing or failing service.
   * @param {string} [cwd]
   * @returns {Promise<{ skills: Array<Object> } | null>}
   */
  async coreSkillsSnapshot(cwd) {
    const service = this.service('skills');
    if (!service || typeof service.snapshot !== 'function') return null;
    try {
      const result = await service.snapshot(cwd ? { cwd } : {});
      if (!result || !Array.isArray(result.skills)) return null;
      return { skills: result.skills.map((row) => normalizeSkill({ ...row, disabled: false })) };
    } catch (error) {
      this.logger.warn?.(`[AdminInventory] skills.snapshot() failed: ${errorMessage(error)}`);
      return null;
    }
  }

  /**
   * Skills overview. Prefers the mcp-manager API (which carries enable state)
   * and falls back to the core read-only snapshot.
   * @param {{ cwd?: string }} [options]
   * @returns {Promise<{ available: boolean, source: 'mcp-manager'|'core', skills: Array<Object>, note?: string }>}
   */
  async listSkills({ cwd } = {}) {
    const result = await this.callApi('skill-list');
    if (result.ok && Array.isArray(result.body?.skills)) {
      return {
        available: true,
        source: 'mcp-manager',
        skills: result.body.skills.map(normalizeSkill),
      };
    }

    const apiProblem = result.ok
      ? 'dsh-mcp-manager 未返回技能列表'
      : result.unavailable
        ? MCP_MANAGER_MISSING_NOTE
        : `dsh-mcp-manager 读取技能失败：${result.error || 'unknown error'}`;

    const snapshot = await this.coreSkillsSnapshot(cwd);
    if (!snapshot) {
      return {
        available: false,
        source: 'core',
        skills: [],
        note: `${apiProblem}；核心技能服务也不可用`,
      };
    }
    return {
      available: true,
      source: 'core',
      skills: snapshot.skills,
      note: `${apiProblem}；技能列表来自核心服务，无法启停`,
    };
  }

  /**
   * Enable or disable one skill.
   * @param {string} name
   * @param {boolean} enabled
   * @returns {Promise<{ ok: boolean, error?: string, warning?: string }>}
   */
  async toggleSkill(name, enabled) {
    const skillName = String(name ?? '').trim();
    if (!skillName) return { ok: false, error: '技能名称不能为空' };
    if (typeof enabled !== 'boolean') return { ok: false, error: 'enabled 必须是布尔值' };

    const result = await this.callApi('skill-toggle', { name: skillName, enabled });
    if (result.unavailable) {
      const snapshot = await this.coreSkillsSnapshot();
      const installed = snapshot?.skills.some((row) => row.name === skillName) === true;
      if (!installed) {
        return { ok: false, error: `技能 "${skillName}" 未安装，无法启停` };
      }
      return {
        ok: false,
        error: `未安装或无法连接 dsh-mcp-manager 插件，无法启停技能 "${skillName}"（只读）`,
      };
    }
    if (!result.ok) {
      return { ok: false, error: result.error || `技能 "${skillName}" 启停失败` };
    }
    const warning = result.body?.warning;
    this.invalidate();
    return { ok: true, ...(warning ? { warning: String(warning) } : {}) };
  }

  /**
   * Group MCP tool schemas by server name from the core tool registry.
   * @returns {Map<string, Array<{ name: string, description: string }>> | null} null when the tools service is missing
   */
  mcpToolGroups() {
    const service = this.service('tools');
    if (!service || typeof service.schemas !== 'function') return null;
    let schemas;
    try {
      schemas = service.schemas();
    } catch (error) {
      this.logger.warn?.(`[AdminInventory] tools.schemas() failed: ${errorMessage(error)}`);
      return null;
    }
    if (!Array.isArray(schemas)) return null;

    const groups = new Map();
    for (const schema of schemas) {
      const fullName = String(schema?.name || '');
      const match = fullName.match(MCP_TOOL_PREFIX);
      if (!match) continue;
      const serverName = match[1];
      const prefix = `mcp__${serverName}__`;
      if (!groups.has(serverName)) groups.set(serverName, []);
      groups.get(serverName).push({
        name: fullName.slice(prefix.length),
        description: typeof schema?.description === 'string' ? schema.description : '',
      });
    }
    return groups;
  }

  /**
   * MCP servers overview.
   * @returns {Promise<{ available: boolean, source: 'mcp-manager'|'tools', servers: Array<Object>, note?: string }>}
   */
  async listMcpServers() {
    const result = await this.callApi('mcpm-list');
    if (result.ok && Array.isArray(result.body?.rows)) {
      return {
        available: true,
        source: 'mcp-manager',
        servers: result.body.rows.map(normalizeMcpRow),
      };
    }

    const apiProblem = result.ok
      ? 'dsh-mcp-manager 未返回 MCP 服务列表'
      : result.unavailable
        ? MCP_MANAGER_MISSING_NOTE
        : `dsh-mcp-manager 读取 MCP 服务失败：${result.error || 'unknown error'}`;

    const groups = this.mcpToolGroups();
    if (!groups) {
      return { available: false, source: 'tools', servers: [], note: `${apiProblem}；核心工具服务也不可用` };
    }

    const servers = [...groups.entries()]
      .map(([serverName, tools]) => ({
        id: serverName,
        serverName,
        transport: '',
        level: 'tools',
        disabled: false,
        readOnly: true,
        enabled: true,
        toolCount: tools.length,
      }))
      .sort((a, b) => (a.serverName < b.serverName ? -1 : a.serverName > b.serverName ? 1 : 0));

    return {
      available: true,
      source: 'tools',
      servers,
      note: `${apiProblem}；MCP 服务列表按已注册工具聚合，无法启停或重启`,
    };
  }

  /**
   * List the tools exposed by one MCP server.
   * @param {string} serverName
   * @returns {Promise<Array<{ name: string, description: string }>>}
   */
  async mcpTools(serverName) {
    const name = String(serverName ?? '').trim();
    if (!name) return [];

    const result = await this.callApi('mcpm-tools', { serverName: name });
    if (result.ok && Array.isArray(result.body?.tools)) {
      return result.body.tools.map((row) => ({
        name: String(row?.name ?? ''),
        description: typeof row?.description === 'string' ? row.description : '',
      }));
    }

    const groups = this.mcpToolGroups();
    return groups?.get(name) ? groups.get(name).map((tool) => ({ ...tool })) : [];
  }

  /**
   * Enable or disable one MCP server.
   * @param {string} id
   * @param {boolean} enabled
   * @returns {Promise<{ ok: boolean, error?: string, warning?: string }>}
   */
  async setMcpEnabled(id, enabled) {
    const entryId = String(id ?? '').trim();
    if (!entryId) return { ok: false, error: 'MCP 服务 ID 不能为空' };
    if (typeof enabled !== 'boolean') return { ok: false, error: 'enabled 必须是布尔值' };

    const result = await this.callApi('mcpm-set-enabled', { id: entryId, enabled });
    if (result.unavailable) {
      return { ok: false, error: `未安装或无法连接 dsh-mcp-manager 插件，无法修改 MCP 服务 "${entryId}"（只读）` };
    }
    if (!result.ok) {
      return { ok: false, error: result.error || `MCP 服务 "${entryId}" 启停失败` };
    }
    const warning = result.body?.warning;
    this.invalidate();
    return { ok: true, ...(warning ? { warning: String(warning) } : {}) };
  }

  /**
   * Restart one MCP server.
   * @param {string} id
   * @returns {Promise<{ ok: boolean, error?: string, warning?: string }>}
   */
  async restartMcp(id) {
    const entryId = String(id ?? '').trim();
    if (!entryId) return { ok: false, error: 'MCP 服务 ID 不能为空' };

    const result = await this.callApi('mcpm-restart', { id: entryId });
    if (result.unavailable) {
      return { ok: false, error: `未安装或无法连接 dsh-mcp-manager 插件，无法重启 MCP 服务 "${entryId}"（只读）` };
    }
    if (!result.ok) {
      return { ok: false, error: result.error || `MCP 服务 "${entryId}" 重启失败` };
    }
    const warning = result.body?.warning;
    this.invalidate();
    return { ok: true, ...(warning ? { warning: String(warning) } : {}) };
  }
}
