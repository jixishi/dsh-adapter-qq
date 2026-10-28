import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AdminInventory } from '../lib/sync/inventory.js';

const ORIGIN = 'http://127.0.0.1:51372';
const API_URL = `${ORIGIN}/dsh-mcp-manager/api`;
const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_ENV = {
  DSH_WEB_ORIGIN: process.env.DSH_WEB_ORIGIN,
  DSH_MCP_MANAGER_TOKEN: process.env.DSH_MCP_MANAGER_TOKEN,
};

beforeEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  delete process.env.DSH_WEB_ORIGIN;
  delete process.env.DSH_MCP_MANAGER_TOKEN;
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

/**
 * Build a fake Cordis context with only the requested services.
 * @param {{ webServer?: Object, webApp?: Object, skills?: Object, tools?: Object }} services
 */
function makeCtx({ webServer, webApp, skills, tools } = {}) {
  const registry = new Map();
  if (webServer !== undefined) registry.set('webServer', webServer);
  if (webApp !== undefined) registry.set('webApp', webApp);
  if (skills !== undefined) registry.set('skills', skills);
  if (tools !== undefined) registry.set('tools', tools);
  return { get: (id) => registry.get(id) };
}

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => (String(name).toLowerCase() === 'content-type' ? 'application/json' : null) },
    async json() {
      return body;
    },
    async text() {
      return JSON.stringify(body);
    },
  };
}

function textResponse(body, status) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => 'text/plain' },
    async json() {
      throw new SyntaxError('not json');
    },
    async text() {
      return body;
    },
  };
}

/**
 * Replace global fetch with a capturing stub. The handler gets the parsed
 * request payload plus the recorded calls array.
 */
function stubFetch(handler) {
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    const call = {
      url: String(url),
      options,
      headers: options.headers || {},
      body: options.body ? JSON.parse(options.body) : undefined,
    };
    calls.push(call);
    return handler(call, calls);
  };
  return calls;
}

function scriptedFetch(routes) {
  return stubFetch((call) => {
    const route = routes[call.body?.op];
    if (typeof route === 'function') return route(call);
    if (route === undefined) return jsonResponse({ ok: false, error: `unknown op: ${call.body?.op}` });
    return jsonResponse(route);
  });
}

const fakeSkills = (skills) => ({
  async snapshot() {
    return { skills, complete: true };
  },
});

const fakeTools = (schemas) => ({
  schemas() {
    return schemas;
  },
});

describe('AdminInventory API transport', () => {
  it('posts JSON operations to the mcp-manager endpoint derived from webServer', async () => {
    const calls = scriptedFetch({
      'skill-list': {
        ok: true,
        skills: [
          {
            name: 'alpha',
            description: 'A skill',
            invocation: { modelInvocable: true, userInvocable: true },
            source: 'bundled',
            provider: 'core',
          },
        ],
        complete: true,
        agents: 1,
      },
    });
    const inventory = new AdminInventory({
      ctx: makeCtx({ webServer: { getOrigin: () => ORIGIN } }),
      getConfig: () => ({ mcpManagerToken: '' }),
    });

    const result = await inventory.listSkills();

    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, API_URL);
    assert.equal(calls[0].options.method, 'POST');
    assert.equal(calls[0].headers['content-type'], 'application/json');
    assert.equal(calls[0].headers['x-dsh-plugin'], 'dsh-mcp-manager');
    assert.equal(calls[0].headers['x-dsh-token'], undefined);
    assert.deepEqual(calls[0].body, { op: 'skill-list', args: {} });
    assert.equal(result.available, true);
    assert.equal(result.source, 'mcp-manager');
    assert.equal(result.skills.length, 1);
    assert.equal(result.skills[0].name, 'alpha');
    assert.equal(result.skills[0].disabled, false);
    assert.equal(result.skills[0].userLevel, false);
  });

  it('sends x-dsh-token when a token is configured', async () => {
    const calls = scriptedFetch({
      'skill-list': { ok: true, skills: [] },
    });
    const inventory = new AdminInventory({
      ctx: makeCtx({ webServer: { getOrigin: () => ORIGIN } }),
      getConfig: () => ({ mcpManagerToken: 'secret-token' }),
    });

    await inventory.listSkills();

    assert.equal(calls[0].headers['x-dsh-token'], 'secret-token');
  });

  it('reads the token from DSH_MCP_MANAGER_TOKEN when config is empty', async () => {
    process.env.DSH_MCP_MANAGER_TOKEN = 'env-token';
    const calls = scriptedFetch({
      'skill-list': { ok: true, skills: [] },
    });
    const inventory = new AdminInventory({
      ctx: makeCtx({ webServer: { getOrigin: () => ORIGIN } }),
      getConfig: () => ({}),
    });

    await inventory.listSkills();

    assert.equal(calls[0].headers['x-dsh-token'], 'env-token');
  });

  it('derives userLevel from user-level skill sources', async () => {
    scriptedFetch({
      'skill-list': {
        ok: true,
        skills: [
          { name: 'personal', description: '', invocation: {}, source: 'user-dsh', provider: 'core' },
          { name: 'bundled', description: '', invocation: {}, source: 'bundled', provider: 'core' },
        ],
      },
    });
    const inventory = new AdminInventory({
      ctx: makeCtx({ webServer: { getOrigin: () => ORIGIN } }),
      getConfig: () => ({}),
    });

    const result = await inventory.listSkills();

    assert.equal(result.skills.find((row) => row.name === 'personal').userLevel, true);
    assert.equal(result.skills.find((row) => row.name === 'bundled').userLevel, false);
  });

  it('falls back to webApp.getAdvertisedUrl and strips a trailing slash', async () => {
    const calls = scriptedFetch({
      'skill-list': { ok: true, skills: [] },
    });
    const inventory = new AdminInventory({
      ctx: makeCtx({ webApp: { getAdvertisedUrl: () => `${ORIGIN}/` } }),
      getConfig: () => ({}),
    });

    await inventory.listSkills();

    assert.equal(calls[0].url, API_URL);
  });

  it('falls back to DSH_WEB_ORIGIN when no web service is available', async () => {
    process.env.DSH_WEB_ORIGIN = ORIGIN;
    const calls = scriptedFetch({
      'skill-list': { ok: true, skills: [] },
    });
    const inventory = new AdminInventory({ ctx: makeCtx(), getConfig: () => ({}) });

    await inventory.listSkills();

    assert.equal(calls[0].url, API_URL);
  });
});

describe('AdminInventory skills', () => {
  it('degrades to the core skills snapshot when the API is missing and caches the failure', async () => {
    const calls = stubFetch(() => textResponse('not found', 404));
    const skills = fakeSkills([
      {
        name: 'core-skill',
        description: 'from core',
        invocation: { modelInvocable: true, userInvocable: false },
        source: 'bundled',
        provider: 'core',
      },
    ]);
    const inventory = new AdminInventory({
      ctx: makeCtx({ webServer: { getOrigin: () => ORIGIN }, skills }),
      getConfig: () => ({}),
    });

    const first = await inventory.listSkills({ cwd: '/work' });
    assert.equal(first.available, true);
    assert.equal(first.source, 'core');
    assert.equal(first.skills.length, 1);
    assert.equal(first.skills[0].disabled, false);
    assert.equal(first.skills[0].invocation.userInvocable, false);
    assert.match(first.note, /只读/);

    const second = await inventory.listSkills();
    assert.equal(second.source, 'core');
    assert.equal(calls.length, 1, 'unavailability should be cached for 15s');
  });

  it('passes the cwd to the core skills snapshot', async () => {
    stubFetch(() => textResponse('nope', 503));
    const seen = [];
    const skills = {
      async snapshot(options) {
        seen.push(options);
        return { skills: [] };
      },
    };
    const inventory = new AdminInventory({
      ctx: makeCtx({ webServer: { getOrigin: () => ORIGIN }, skills }),
      getConfig: () => ({}),
    });

    await inventory.listSkills({ cwd: '/tmp/project' });

    assert.deepEqual(seen[0], { cwd: '/tmp/project' });
  });

  it('reports available:false when the API and the core skills service are both missing', async () => {
    const calls = stubFetch(() => textResponse('not found', 404));
    const inventory = new AdminInventory({
      ctx: makeCtx({ webServer: { getOrigin: () => ORIGIN } }),
      getConfig: () => ({}),
    });

    const result = await inventory.listSkills();

    assert.equal(result.available, false);
    assert.equal(result.source, 'core');
    assert.deepEqual(result.skills, []);
    assert.match(result.note, /只读/);
    assert.equal(calls.length, 1);
  });

  it('does not call fetch at all when no origin can be resolved', async () => {
    const calls = stubFetch(() => jsonResponse({ ok: true, skills: [] }));
    const inventory = new AdminInventory({
      ctx: makeCtx({ skills: fakeSkills([]) }),
      getConfig: () => ({}),
    });

    const result = await inventory.listSkills();

    assert.equal(calls.length, 0);
    assert.equal(result.source, 'core');
    assert.equal(result.available, true);
  });

  it('treats a non-JSON response as unavailable and falls back', async () => {
    stubFetch(() => textResponse('<html>gateway error</html>', 200));
    const inventory = new AdminInventory({
      ctx: makeCtx({ webServer: { getOrigin: () => ORIGIN }, skills: fakeSkills([]) }),
      getConfig: () => ({}),
    });

    const result = await inventory.listSkills();

    assert.equal(result.source, 'core');
    assert.match(result.note, /只读/);
  });

  it('times out after the 2.5s deadline and caches the failure', async () => {
    let calls = 0;
    globalThis.fetch = (url, options = {}) => {
      calls += 1;
      return new Promise((resolve, reject) => {
        const signal = options.signal;
        const fail = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        if (!signal) return;
        if (signal.aborted) return fail();
        signal.addEventListener('abort', fail, { once: true });
      });
    };
    const inventory = new AdminInventory({
      ctx: makeCtx({ webServer: { getOrigin: () => ORIGIN }, skills: fakeSkills([]) }),
      getConfig: () => ({}),
    });

    const started = Date.now();
    const first = await inventory.listSkills();
    const elapsed = Date.now() - started;
    assert.equal(first.source, 'core');
    assert.ok(elapsed >= 2300, `expected the first call to wait for the timeout, got ${elapsed}ms`);

    const secondStarted = Date.now();
    const second = await inventory.listSkills();
    assert.equal(second.source, 'core');
    assert.ok(Date.now() - secondStarted < 200, 'cached unavailability should answer immediately');
    assert.equal(calls, 1);
  });

  it('invalidate() clears the negative cache so the next call retries', async () => {
    let healthy = false;
    const calls = stubFetch(() =>
      healthy
        ? jsonResponse({ ok: true, skills: [{ name: 'alpha', description: '', invocation: {}, source: 'bundled', provider: 'core' }] })
        : textResponse('not found', 404),
    );
    const inventory = new AdminInventory({
      ctx: makeCtx({ webServer: { getOrigin: () => ORIGIN }, skills: fakeSkills([]) }),
      getConfig: () => ({}),
    });

    const first = await inventory.listSkills();
    assert.equal(first.source, 'core');

    healthy = true;
    inventory.invalidate();

    const second = await inventory.listSkills();
    assert.equal(second.source, 'mcp-manager');
    assert.equal(second.skills[0].name, 'alpha');
    assert.equal(calls.length, 2);
  });

  it('toggleSkill posts the toggle operation and reports success', async () => {
    const calls = scriptedFetch({
      'skill-toggle': { ok: true },
    });
    const inventory = new AdminInventory({
      ctx: makeCtx({ webServer: { getOrigin: () => ORIGIN } }),
      getConfig: () => ({}),
    });

    const result = await inventory.toggleSkill('alpha', false);

    assert.deepEqual(result, { ok: true });
    assert.deepEqual(calls[0].body, { op: 'skill-toggle', args: { name: 'alpha', enabled: false } });
  });

  it('toggleSkill surfaces API errors', async () => {
    scriptedFetch({ 'skill-toggle': { ok: false, error: 'skill not found: alpha' } });
    const inventory = new AdminInventory({
      ctx: makeCtx({ webServer: { getOrigin: () => ORIGIN } }),
      getConfig: () => ({}),
    });

    const result = await inventory.toggleSkill('alpha', false);

    assert.deepEqual(result, { ok: false, error: 'skill not found: alpha' });
  });

  it('toggleSkill reports 未安装 when the management API is unavailable', async () => {
    stubFetch(() => textResponse('not found', 404));
    const skills = fakeSkills([
      { name: 'alpha', description: '', invocation: {}, source: 'bundled', provider: 'core' },
    ]);
    const inventory = new AdminInventory({
      ctx: makeCtx({ webServer: { getOrigin: () => ORIGIN }, skills }),
      getConfig: () => ({}),
    });

    const installed = await inventory.toggleSkill('alpha', false);
    assert.equal(installed.ok, false);
    assert.match(installed.error, /未安装/);

    const missing = await inventory.toggleSkill('does-not-exist', true);
    assert.equal(missing.ok, false);
    assert.match(missing.error, /未安装/);
  });

  it('toggleSkill validates its arguments', async () => {
    const inventory = new AdminInventory({ ctx: makeCtx(), getConfig: () => ({}) });

    assert.equal((await inventory.toggleSkill('', true)).ok, false);
    assert.equal((await inventory.toggleSkill('alpha', 'yes')).ok, false);
  });
});

describe('AdminInventory MCP', () => {
  const listBody = {
    ok: true,
    rows: [
      {
        id: 'mcp-github',
        serverName: 'github',
        transport: 'stdio',
        level: 'profile',
        disabled: false,
        readOnly: false,
        live: { enabled: true, phase: 'active', entryId: 'x:github' },
        toolCount: 3,
      },
      {
        id: 'mcp-home',
        serverName: 'home-server',
        transport: 'streamable-http',
        level: 'home',
        disabled: true,
        readOnly: true,
        readOnlyReason: 'home',
        live: null,
        toolCount: 0,
      },
    ],
    paths: {},
    errors: [],
  };

  it('maps mcp-manager rows into the unified server shape', async () => {
    scriptedFetch({ 'mcpm-list': listBody });
    const inventory = new AdminInventory({
      ctx: makeCtx({ webServer: { getOrigin: () => ORIGIN } }),
      getConfig: () => ({}),
    });

    const result = await inventory.listMcpServers();

    assert.equal(result.available, true);
    assert.equal(result.source, 'mcp-manager');
    assert.equal(result.servers.length, 2);

    const [github, home] = result.servers;
    assert.equal(github.id, 'mcp-github');
    assert.equal(github.serverName, 'github');
    assert.equal(github.transport, 'stdio');
    assert.equal(github.level, 'profile');
    assert.equal(github.disabled, false);
    assert.equal(github.readOnly, false);
    assert.equal(github.enabled, true);
    assert.equal(github.phase, 'active');
    assert.equal(github.toolCount, 3);

    assert.equal(home.enabled, false);
    assert.equal(home.readOnly, true);
    assert.equal(home.phase, undefined);
    assert.equal(home.readOnlyReason, 'home');
  });

  it('aggregates tool schemas per MCP server when the API is unavailable', async () => {
    stubFetch(() => textResponse('not found', 404));
    const tools = fakeTools([
      { name: 'mcp__github__list_repos', description: 'List repos' },
      { name: 'mcp__github__get_issue', description: 'Get issue' },
      { name: 'mcp__files__read', description: 'Read file' },
      { name: 'qq_send_file', description: 'not an mcp tool' },
      { name: 'mcp__bad name__x', description: 'invalid server name' },
    ]);
    const inventory = new AdminInventory({
      ctx: makeCtx({ webServer: { getOrigin: () => ORIGIN }, tools }),
      getConfig: () => ({}),
    });

    const result = await inventory.listMcpServers();

    assert.equal(result.available, true);
    assert.equal(result.source, 'tools');
    assert.equal(result.servers.length, 2);
    const github = result.servers.find((row) => row.serverName === 'github');
    assert.equal(github.enabled, true);
    assert.equal(github.readOnly, true);
    assert.equal(github.toolCount, 2);
    assert.equal(result.servers.find((row) => row.serverName === 'files').toolCount, 1);
    assert.match(result.note, /只读/);
  });

  it('reports available:false when neither the API nor the tools registry is usable', async () => {
    stubFetch(() => textResponse('not found', 404));
    const inventory = new AdminInventory({
      ctx: makeCtx({ webServer: { getOrigin: () => ORIGIN } }),
      getConfig: () => ({}),
    });

    const result = await inventory.listMcpServers();

    assert.equal(result.available, false);
    assert.equal(result.source, 'tools');
    assert.deepEqual(result.servers, []);
  });

  it('lists MCP tools through the API and falls back to the tool registry', async () => {
    scriptedFetch({
      'mcpm-tools': {
        ok: true,
        tools: [{ name: 'list_repos', description: 'List repos', parameters: [] }],
      },
    });
    const apiInventory = new AdminInventory({
      ctx: makeCtx({ webServer: { getOrigin: () => ORIGIN } }),
      getConfig: () => ({}),
    });

    const viaApi = await apiInventory.mcpTools('github');
    assert.deepEqual(viaApi, [{ name: 'list_repos', description: 'List repos' }]);

    stubFetch(() => textResponse('not found', 404));
    const fallbackInventory = new AdminInventory({
      ctx: makeCtx({
        webServer: { getOrigin: () => ORIGIN },
        tools: fakeTools([{ name: 'mcp__github__list_repos', description: 'List repos' }]),
      }),
      getConfig: () => ({}),
    });

    const viaTools = await fallbackInventory.mcpTools('github');
    assert.deepEqual(viaTools, [{ name: 'list_repos', description: 'List repos' }]);
    assert.deepEqual(await fallbackInventory.mcpTools(''), []);
  });

  it('setMcpEnabled posts the operation and forwards warnings', async () => {
    const calls = scriptedFetch({
      'mcpm-set-enabled': { ok: true, warning: 'restart required' },
    });
    const inventory = new AdminInventory({
      ctx: makeCtx({ webServer: { getOrigin: () => ORIGIN } }),
      getConfig: () => ({}),
    });

    const result = await inventory.setMcpEnabled('mcp-github', false);

    assert.deepEqual(result, { ok: true, warning: 'restart required' });
    assert.deepEqual(calls[0].body, { op: 'mcpm-set-enabled', args: { id: 'mcp-github', enabled: false } });
  });

  it('setMcpEnabled reports API refusals instead of throwing', async () => {
    scriptedFetch({ 'mcpm-set-enabled': { ok: false, error: 'this server is not managed in the current profile' } });
    const inventory = new AdminInventory({
      ctx: makeCtx({ webServer: { getOrigin: () => ORIGIN } }),
      getConfig: () => ({}),
    });

    const result = await inventory.setMcpEnabled('mcp-home', true);

    assert.equal(result.ok, false);
    assert.match(result.error, /not managed/);
  });

  it('setMcpEnabled reports a read-only error when the plugin is missing', async () => {
    stubFetch(() => textResponse('not found', 404));
    const inventory = new AdminInventory({
      ctx: makeCtx({ webServer: { getOrigin: () => ORIGIN } }),
      getConfig: () => ({}),
    });

    const result = await inventory.setMcpEnabled('mcp-github', true);

    assert.equal(result.ok, false);
    assert.match(result.error, /只读/);
  });

  it('restartMcp posts the restart operation', async () => {
    const calls = scriptedFetch({ 'mcpm-restart': { ok: true } });
    const inventory = new AdminInventory({
      ctx: makeCtx({ webServer: { getOrigin: () => ORIGIN } }),
      getConfig: () => ({}),
    });

    const result = await inventory.restartMcp('mcp-github');

    assert.deepEqual(result, { ok: true });
    assert.deepEqual(calls[0].body, { op: 'mcpm-restart', args: { id: 'mcp-github' } });
  });

  it('restartMcp reports errors without throwing', async () => {
    scriptedFetch({ 'mcpm-restart': { ok: false, error: 'plugin manager rejected the restart' } });
    const inventory = new AdminInventory({
      ctx: makeCtx({ webServer: { getOrigin: () => ORIGIN } }),
      getConfig: () => ({}),
    });

    const result = await inventory.restartMcp('mcp-github');

    assert.deepEqual(result, { ok: false, error: 'plugin manager rejected the restart' });
  });

  it('validates MCP mutation arguments', async () => {
    const inventory = new AdminInventory({ ctx: makeCtx(), getConfig: () => ({}) });

    assert.equal((await inventory.setMcpEnabled('', true)).ok, false);
    assert.equal((await inventory.setMcpEnabled('mcp-github', 'on')).ok, false);
    assert.equal((await inventory.restartMcp('  ')).ok, false);
  });
});
