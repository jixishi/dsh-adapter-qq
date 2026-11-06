import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { compareVersions, createUpdateRoute, readLocalVersion } from '../lib/qq/update-route.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The settings tab asks `/dsh-adapter-qq/update-check` whether a newer version is
 * published. The host does the lookup so the browser never has to deal with CORS
 * or the machine's proxy configuration, and nothing is ever downloaded.
 */

function call(handler, { method = 'GET' } = {}) {
  return new Promise((resolve) => {
    const res = {
      statusCode: 0,
      headers: null,
      body: '',
      writeHead(code, headers) {
        this.statusCode = code;
        this.headers = headers;
      },
      end(chunk) {
        this.body = chunk ?? '';
        resolve({ status: this.statusCode, headers: this.headers, json: JSON.parse(this.body) });
      },
    };
    handler({ method }, res);
  });
}

const okFetch = (version) => async () => ({
  ok: true,
  status: 200,
  json: async () => ({ version, dist: { tarball: `https://example.test/dsh-adapter-qq-${version}.tgz` }, homepage: 'https://example.test' }),
});

describe('compareVersions', () => {
  it('orders by numeric segment', () => {
    assert.equal(compareVersions('0.2.5', '0.2.4'), 1);
    assert.equal(compareVersions('0.2.4', '0.2.5'), -1);
    assert.equal(compareVersions('0.2.4', '0.2.4'), 0);
    assert.equal(compareVersions('0.10.0', '0.9.9'), 1);
    assert.equal(compareVersions('1.0.0', '0.99.99'), 1);
  });

  it('ignores a leading v and any prerelease suffix', () => {
    assert.equal(compareVersions('v0.2.4', '0.2.4'), 0);
    assert.equal(compareVersions('0.2.4-beta.1', '0.2.4'), 0);
  });

  it('is junk-safe', () => {
    assert.equal(compareVersions('', ''), 0);
    assert.equal(typeof compareVersions(undefined, '1.0.0'), 'number');
  });
});

describe('readLocalVersion', () => {
  it('reads this package.json rather than depending on cwd', () => {
    const version = readLocalVersion();
    assert.match(version, /^\d+\.\d+\.\d+/);
  });
});

describe('update route', () => {
  it('reports an update when the registry is ahead', async () => {
    const handler = createUpdateRoute({ fetchImpl: okFetch('999.0.0'), now: () => 1_700_000_000_000 });
    const { status, json } = await call(handler);
    assert.equal(status, 200);
    assert.equal(json.ok, true);
    assert.equal(json.latest, '999.0.0');
    assert.equal(json.hasUpdate, true);
    assert.equal(json.current, readLocalVersion());
    assert.match(json.checkedAt, /^\d{4}-\d{2}-\d{2}T/);
  });

  it('reports up to date when the registry matches', async () => {
    const current = readLocalVersion();
    const handler = createUpdateRoute({ fetchImpl: okFetch(current) });
    const { json } = await call(handler);
    assert.equal(json.hasUpdate, false);
    assert.equal(json.latest, current);
  });

  it('never claims an update when the registry is older', async () => {
    const handler = createUpdateRoute({ fetchImpl: okFetch('0.0.1') });
    const { json } = await call(handler);
    assert.equal(json.hasUpdate, false);
  });

  it('degrades to a structured failure instead of throwing', async () => {
    const handler = createUpdateRoute({
      fetchImpl: async () => {
        throw new Error('network down');
      },
    });
    const { status, json } = await call(handler);
    assert.equal(status, 200, 'a failed check is not an HTTP error');
    assert.equal(json.ok, false);
    assert.equal(json.hasUpdate, false);
    assert.match(json.error.message, /network down/);
  });

  it('treats a non-2xx response as a failure', async () => {
    const handler = createUpdateRoute({ fetchImpl: async () => ({ ok: false, status: 503, json: async () => ({}) }) });
    const { json } = await call(handler);
    assert.equal(json.ok, false);
    assert.equal(json.error.code, 'REGISTRY_STATUS');
  });

  it('caches the lookup so repeated opens do not hammer the registry', async () => {
    let calls = 0;
    const handler = createUpdateRoute({
      fetchImpl: async () => {
        calls += 1;
        return { ok: true, status: 200, json: async () => ({ version: '9.9.9' }) };
      },
      now: () => 1_700_000_000_000,
    });
    await call(handler);
    await call(handler);
    await call(handler);
    assert.equal(calls, 1, 'one fetch serves the whole TTL');
  });

  it('rejects other methods', async () => {
    const handler = createUpdateRoute({ fetchImpl: okFetch('1.0.0') });
    const { status } = await call(handler, { method: 'PUT' });
    assert.equal(status, 405);
  });

  it('reports NO_FETCH when the runtime has no fetch', async () => {
    const handler = createUpdateRoute({ fetchImpl: null });
    const original = globalThis.fetch;
    try {
      globalThis.fetch = undefined;
      const { json } = await call(handler);
      assert.equal(json.ok, false);
      assert.equal(json.error.code, 'NO_FETCH');
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe('route registration', () => {
  // The handlers are exercised directly above and in the onboard/subscription
  // suites, but nothing checked that index.js actually registers them under the
  // paths the client calls — a rename there would break the UI silently.
  const INDEX = fs.readFileSync(join(REPO_ROOT, 'lib', 'index.js'), 'utf8');

  it('registers every path the client calls', () => {
    for (const path of ['/dsh-adapter-qq/api', '/dsh-adapter-qq/subscriptions', '/dsh-adapter-qq/update-check']) {
      assert.ok(INDEX.includes("path: '" + path + "'"), `${path} must be registered`);
    }
  });

  it('wires each path to its own factory', () => {
    assert.match(INDEX, /path: '\/dsh-adapter-qq\/api',\s*\n\s*handler: createOnboardRoute\(/);
    assert.match(INDEX, /path: '\/dsh-adapter-qq\/subscriptions',\s*\n\s*handler: createSubscriptionRoute\(/);
    assert.match(INDEX, /path: '\/dsh-adapter-qq\/update-check',\s*\n\s*handler: createUpdateRoute\(/);
  });
});