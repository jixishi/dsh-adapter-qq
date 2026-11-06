import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Plugin update check.
 *
 * The settings tab needs to answer "am I current?" without asking the user to
 * visit npm. Browsers can call the registry directly, but the request then
 * depends on the page's CORS and proxy situation; the host already has network
 * access for the bot, so the check lives here and the tab just asks this route.
 *
 * Nothing is downloaded and nothing is installed — this only reads the registry's
 * `latest` tag and compares it with the version in package.json.
 */

const REGISTRY = 'https://registry.npmjs.org/';
const CACHE_TTL_MS = 10 * 60 * 1000;

/** Compare two semver-ish strings. Returns 1, 0 or -1. */
export function compareVersions(a, b) {
  const parse = (v) =>
    String(v ?? '')
      .replace(/^v/, '')
      .split('-')[0]
      .split('.')
      .map((part) => Number.parseInt(part, 10) || 0);
  const left = parse(a);
  const right = parse(b);
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const l = left[i] ?? 0;
    const r = right[i] ?? 0;
    if (l > r) return 1;
    if (l < r) return -1;
  }
  return 0;
}

/** Read this package's own version without depending on cwd. */
export function readLocalVersion() {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkgPath = join(here, '..', '..', 'package.json');
    if (!existsSync(pkgPath)) return '';
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
    return String(pkg.version ?? '');
  } catch {
    return '';
  }
}

/**
 * @param {Object} options
 * @param {string} [options.packageName]
 * @param {Function} [options.fetchImpl] - Injectable fetch for tests
 * @param {Function} [options.now]
 * @param {Object} [options.logger]
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void>}
 */
export function createUpdateRoute({
  packageName = 'dsh-adapter-qq',
  fetchImpl = null,
  now = () => Date.now(),
  logger = null,
} = {}) {
  /** @type {{ at: number, payload: Object }|null} */
  let cache = null;

  async function resolveLatest() {
    if (cache && now() - cache.at < CACHE_TTL_MS) return cache.payload;

    const doFetch = fetchImpl ?? globalThis.fetch;
    if (typeof doFetch !== 'function') {
      throw Object.assign(new Error('当前运行环境没有可用的 fetch'), { code: 'NO_FETCH' });
    }

    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), 8000) : null;
    try {
      const res = await doFetch(`${REGISTRY}${packageName}/latest`, {
        headers: { accept: 'application/json' },
        ...(controller ? { signal: controller.signal } : {}),
      });
      if (!res || res.ok !== true) {
        throw Object.assign(new Error(`registry 返回 ${res?.status ?? '未知状态'}`), {
          code: 'REGISTRY_STATUS',
        });
      }
      const body = await res.json();
      const payload = {
        latest: String(body?.version ?? ''),
        tarball: String(body?.dist?.tarball ?? ''),
        homepage: String(body?.homepage ?? ''),
      };
      cache = { at: now(), payload };
      return payload;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  return async function handle(req, res) {
    const send = (payload, status = 200) => {
      const body = JSON.stringify(payload);
      res.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': Buffer.byteLength(body),
        'cache-control': 'no-store',
      });
      res.end(body);
    };

    if (req.method !== 'GET' && req.method !== 'POST') {
      send({ ok: false, error: { code: 'METHOD', message: '只支持 GET' } }, 405);
      return;
    }

    const current = readLocalVersion();
    try {
      const info = await resolveLatest();
      const latest = info.latest;
      const hasUpdate = Boolean(current && latest && compareVersions(latest, current) > 0);
      send({
        ok: true,
        current,
        latest,
        hasUpdate,
        tarball: info.tarball,
        homepage: info.homepage,
        checkedAt: new Date(now()).toISOString(),
      });
    } catch (err) {
      // A failed check is not an error the tab should shout about: report what we
      // know and let the UI say "无法检查".
      logger?.warn?.(`[adapter-qq] 更新检查失败：${err?.message ?? err}`);
      send({
        ok: false,
        current,
        latest: '',
        hasUpdate: false,
        checkedAt: new Date(now()).toISOString(),
        error: { code: err?.code ?? 'FETCH_FAILED', message: err?.message ?? String(err) },
      });
    }
  };
}
