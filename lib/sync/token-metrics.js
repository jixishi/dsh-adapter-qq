/**
 * Optional integration with `dsh-token-metrics` (hugoyee75-cmyk/dsh-token-metrics).
 *
 * That plugin records every model call from DSH session logs and exposes an
 * aggregated snapshot at `GET /api/dsh-token-metrics/summary`. We only read
 * that loopback endpoint (plus the optional `/version` for the version badge);
 * nothing is written and no settings are touched.
 *
 * Shape of the snapshot we rely on (verified against dsh-token-metrics 0.3.7,
 * `buildSnapshot()` in index.js):
 *
 *   totals: { all, today, week }          counters (+ cacheHitRate)
 *   byDay: { 'YYYY-MM-DD': counters }     local-time day buckets
 *   byDayModel: { day: { 'provider/model': counters } }
 *   byDayModelName: { day: { modelName: counters } }
 *   byProject: { cwd: counters }
 *   byOrigin: { main|subagent|workflow: counters }
 *   byModelName: { modelName: counters }
 *   cost: { totalUsd, byDay, byModel, byModelName, unpriced, fx: { usdCny } }
 *   performance: { total: { ttftMs, tps, samples }, byModel }
 *   config.budget: { dailyUsd, monthlyUsd, warnPercent, groups }
 *   balance: { sites: [{ label, lastBalance: { usd, currency, quotas }, error }] }
 *
 * counters = { calls, inputTokens, outputTokens, cacheReadTokens,
 *              cacheWriteTokens, reasoningTokens, totalTokens, cacheHitRate? }
 *
 * Cache-hit semantics match the billing plugin's convention used elsewhere in
 * this adapter (hit / (hit + miss)) so both sources render consistently.
 */

const PLUGIN_PATTERN = /dsh-token-metrics$/;
const API_PREFIX = '/api/dsh-token-metrics';

/**
 * Detect `dsh-token-metrics` from the Loader tree or the plugin inventory.
 * @param {Object} ctx
 * @returns {Promise<boolean>}
 */
export async function hasTokenMetricsPlugin(ctx) {
  const matches = (name) => typeof name === 'string' && PLUGIN_PATTERN.test(name);
  const visited = new Set();

  const walk = (entries) => {
    for (const entry of entries || []) {
      if (!entry || visited.has(entry)) continue;
      visited.add(entry);
      const name = entry.options?.name || entry.moduleName;
      if (matches(name) && entry.disabled !== true) return true;
      if (walk(entry.children)) return true;
    }
    return false;
  };

  try {
    const loader = ctx?.get?.('loader');
    if (loader?.entries && walk(loader.entries())) return true;
  } catch {
    // fall through
  }

  try {
    const inventory = ctx?.get?.('pluginInventory');
    if (!inventory?.list) return false;
    const snapshot = await inventory.list();
    const rows = [
      ...(snapshot?.entries || []),
      ...(snapshot?.agentPresets || []).flatMap((preset) => preset.rows || []),
    ];
    return rows.some((row) => matches(row?.moduleName) && row.enabled !== false && row.fiberPhase !== 'failed');
  } catch {
    return false;
  }
}

/** Shared loopback origin resolver (webServer.getOrigin() -> port -> ''). */
function originOf(ctx) {
  const webServer = ctx?.get?.('webServer');
  try {
    const origin = webServer?.getOrigin?.();
    if (typeof origin === 'string' && origin) return origin.replace(/\/$/, '');
  } catch {
    // fall back to the port below
  }
  if (Number.isFinite(Number(webServer?.port))) return `http://127.0.0.1:${webServer.port}`;
  return '';
}

/**
 * GET a JSON document from the token-metrics loopback API.
 * @param {Object} options
 * @param {Object} options.ctx
 * @param {string} options.path e.g. '/summary'
 * @param {Function} [options.fetchImpl]
 * @param {number} [options.timeoutMs]
 * @returns {Promise<Object>}
 */
async function fetchTokenMetricsJson({ ctx, path, fetchImpl = globalThis.fetch, timeoutMs = 8000 } = {}) {
  const origin = originOf(ctx);
  if (!origin) throw new Error('宿主 webServer 未就绪，无法访问 Token 用量接口');
  if (typeof fetchImpl !== 'function') throw new Error('当前环境没有 fetch');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs);
  let response;
  try {
    response = await fetchImpl(`${origin}${API_PREFIX}${path}`, {
      method: 'GET',
      headers: { accept: 'application/json' },
      signal: controller.signal,
    });
  } catch (error) {
    throw new Error(
      controller.signal.aborted
        ? `Token 用量接口超时（${timeoutMs}ms）`
        : `无法连接 Token 用量接口：${error.message}`
    );
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) throw new Error(`Token 用量接口返回 HTTP ${response.status}`);
  const data = await response.json().catch(() => null);
  if (!data || typeof data !== 'object') throw new Error('Token 用量接口返回了非 JSON 数据');
  return data;
}

/** GET /api/dsh-token-metrics/summary */
export async function fetchTokenMetricsSummary(options = {}) {
  return fetchTokenMetricsJson({ ...options, path: '/summary' });
}

/**
 * GET /api/dsh-token-metrics/version — best effort, only used for the badge.
 * @returns {Promise<string|undefined>}
 */
export async function fetchTokenMetricsVersion(options = {}) {
  try {
    const data = await fetchTokenMetricsJson({ ...options, path: '/version' });
    return typeof data?.version === 'string' ? data.version : undefined;
  } catch {
    return undefined;
  }
}

const EMPTY_CELL = () => ({
  cost: 0,
  calls: 0,
  input: 0,
  output: 0,
  cacheHit: 0,
  cacheMiss: 0,
  reasoning: 0,
});

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

/**
 * Map one token-metrics counter bundle to the internal cell used by the
 * billing plugin renderer (`cost` is added later, from the cost document).
 * @param {Object} counters
 * @returns {ReturnType<typeof EMPTY_CELL>}
 */
export function countersToCell(counters = {}) {
  const input = finiteNumber(counters.inputTokens);
  const cacheRead = finiteNumber(counters.cacheReadTokens);
  // Same convention as the billing plugin: hit = cacheRead, miss = fresh input.
  // cacheWrite is deliberately excluded from the denominator.
  return {
    cost: 0,
    calls: finiteNumber(counters.calls),
    input,
    output: finiteNumber(counters.outputTokens),
    cacheHit: cacheRead,
    cacheMiss: input,
    reasoning: finiteNumber(counters.reasoningTokens),
  };
}

function addCellInto(target, source) {
  for (const key of Object.keys(target)) target[key] += finiteNumber(source?.[key]);
  return target;
}

/**
 * Convert a token-metrics snapshot into the document shape consumed by
 * `aggregateUsageRange` / `buildUsageMarkdown` / `buildUsageTypst`.
 *
 * Token-metrics reports money in USD (with `cost.fx.usdCny`); the renderers
 * work in CNY, so every cost is multiplied by the snapshot's exchange rate.
 *
 * @param {Object} summary raw snapshot from /summary
 * @param {{version?:string}} [extra]
 * @returns {Object} stats document in the billing-plugin shape
 */
export function normalizeTokenMetrics(summary = {}, extra = {}) {
  const fx = finiteNumber(summary?.cost?.fx?.usdCny) || 7.2;
  const dayCost = summary?.cost?.byDay && typeof summary.cost.byDay === 'object' ? summary.cost.byDay : {};
  const byDayModelCost = summary?.cost?.byModel && typeof summary.cost.byModel === 'object' ? summary.cost.byModel : {};

  const byDay = {};
  const byDayModels = {};
  const byDayModelsSite = {};
  const byModel = {};
  const bySite = {};

  const rawByDay = summary?.byDay && typeof summary.byDay === 'object' ? summary.byDay : {};
  const rawDayModel = summary?.byDayModel && typeof summary.byDayModel === 'object' ? summary.byDayModel : {};
  const rawDayModelName =
    summary?.byDayModelName && typeof summary.byDayModelName === 'object' ? summary.byDayModelName : {};

  for (const workingDay of Object.keys(rawByDay).sort()) {
    const dayCell = countersToCell(rawByDay[workingDay]);
    // Costs are only available per day as a single total; spread by share so a
    // day without cost data stays at zero instead of inventing money.
    dayCell.cost = finiteNumber(dayCost[workingDay]) * fx;
    byDay[workingDay] = dayCell;

    const perModelName = rawDayModelName[workingDay] || {};
    const nameShareTotal = Object.values(perModelName).reduce(
      (sum, counters) => sum + finiteNumber(counters?.totalTokens),
      0
    );
    const dayModels = {};
    for (const [modelName, counters] of Object.entries(perModelName)) {
      const cell = countersToCell(counters);
      // Attribute the day's cost to each model by its token share. token-metrics
      // already computes per-model-per-day cost internally but does not expose
      // it in the snapshot; token share is the closest honest split.
      if (nameShareTotal > 0) {
        cell.cost = (finiteNumber(counters?.totalTokens) / nameShareTotal) * dayCell.cost;
      }
      dayModels[modelName] = cell;
    }
    byDayModels[workingDay] = dayModels;

    // Site dimension. dsh-token-metrics has no per-site breakdown, but `byModel`
    // keys are `provider/model`, and the provider *is* the upstream route the
    // call was billed through — so it is the honest stand-in for "site".
    // The renderer expects `{ day: { model: { site: cell } } }`.
    const perProviderModel = rawDayModel[workingDay] || {};
    const daySites = {};
    for (const [key, counters] of Object.entries(perProviderModel)) {
      const slash = key.indexOf('/');
      const providerName = slash === -1 ? 'unknown' : key.slice(0, slash);
      const modelName = slash === -1 ? key : key.slice(slash + 1);
      const cell = countersToCell(counters);
      if (nameShareTotal > 0) {
        cell.cost = (finiteNumber(counters?.totalTokens) / nameShareTotal) * dayCell.cost;
      }
      daySites[modelName] ??= {};
      daySites[modelName][providerName] ??= EMPTY_CELL();
      addCellInto(daySites[modelName][providerName], cell);
    }
    byDayModelsSite[workingDay] = daySites;
  }

  // Global per-model totals (with the total cost attached, so the "all" range
  // does not need the per-day split).
  const totalUsd = finiteNumber(summary?.cost?.totalUsd) * fx;
  const modelNameCost = summary?.cost?.byModelName && typeof summary.cost.byModelName === 'object'
    ? summary.cost.byModelName
    : {};
  const allTokens = Object.values(summary?.byModelName || {}).reduce(
    (sum, counters) => sum + finiteNumber(counters?.totalTokens),
    0
  );
  for (const [modelName, counters] of Object.entries(summary?.byModelName || {})) {
    const cell = countersToCell(counters);
    if (allTokens > 0) cell.cost = (finiteNumber(counters?.totalTokens) / allTokens) * totalUsd;
    byModel[modelName] = cell;
  }

  const providerCells = {};
  for (const [key, counters] of Object.entries(summary?.byModel || {})) {
    const slash = key.indexOf('/');
    const providerName = slash === -1 ? 'unknown' : key.slice(0, slash);
    providerCells[providerName] ??= EMPTY_CELL();
    const cell = countersToCell(counters);
    if (allTokens > 0) cell.cost = (finiteNumber(counters?.totalTokens) / allTokens) * totalUsd;
    addCellInto(providerCells[providerName], cell);
  }
  for (const [key, cells] of Object.entries(byDayModelsSite)) {
    void key;
    for (const [providerName, cell] of Object.entries(cells)) {
      bySite[providerName] ??= EMPTY_CELL();
      addCellInto(bySite[providerName], cell);
    }
  }
  if (Object.keys(bySite).length === 0) Object.assign(bySite, providerCells);

  const total = countersToCell(summary?.totals?.all);
  total.cost = totalUsd;

  const monthKey = localDayKey(new Date()).slice(0, 7);
  const monthCost = Object.entries(byDay)
    .filter(([day]) => day.startsWith(monthKey))
    .reduce((sum, [, cell]) => sum + cell.cost, 0);

  const budget = budgetDocument(summary?.config?.budget, { monthCost, fx });

  return {
    pluginVersion: extra.version,
    source: 'dsh-token-metrics',
    byDay,
    byDayModels,
    byDayModelsSite,
    byModel,
    bySite,
    total,
    budget: budget.monthlyBudgetCny,
    performance: normalizePerformance(summary?.performance),
    projects: Object.fromEntries(
      Object.entries(summary?.byProject || {}).map(([cwd, counters]) => [cwd, countersToCell(counters)])
    ),
    origins: Object.fromEntries(
      Object.entries(summary?.byOrigin || {}).map(([origin, counters]) => [origin, countersToCell(counters)])
    ),
    balance: normalizeBalance(summary?.balance),
    unpriced: Array.isArray(summary?.cost?.unpriced) ? summary.cost.unpriced : [],
    fx,
    currency: 'CNY',
    raw: summary,
    dailyBudgetCny: budget.dailyBudgetCny,
    budgetGroups: budget.groups,
  };
}

function localDayKey(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * Convert token-metrics budget (USD) into the CNY budget the renderer shows.
 * @returns {{monthlyBudgetCny:number, dailyBudgetCny:number, groups:Array}}
 */
export function budgetDocument(budget = {}, { monthCost = 0, fx = 7.2 } = {}) {
  void monthCost;
  const rate = Number.isFinite(Number(fx)) && Number(fx) > 0 ? Number(fx) : 7.2;
  const monthlyUsd = finiteNumber(budget?.monthlyUsd);
  const dailyUsd = finiteNumber(budget?.dailyUsd);
  const groups = Array.isArray(budget?.groups)
    ? budget.groups
        .map((group) => ({
          name: String(group?.name ?? group?.label ?? ''),
          models: Array.isArray(group?.models) ? group.models.map(String) : [],
          monthlyUsd: finiteNumber(group?.monthlyUsd),
          dailyUsd: finiteNumber(group?.dailyUsd),
        }))
        .filter((group) => group.monthlyUsd > 0 || group.dailyUsd > 0)
    : [];
  return {
    monthlyBudgetCny: monthlyUsd > 0 ? monthlyUsd * rate : 0,
    dailyBudgetCny: dailyUsd > 0 ? dailyUsd * rate : 0,
    groups,
  };
}

/** Normalise `performance` ({ttftMs, tps, samples}) tolerating nulls. */
export function normalizePerformance(performance = {}) {
  const summarize = (entry) => ({
    ttftMs: Number.isFinite(Number(entry?.ttftMs)) ? Number(entry.ttftMs) : null,
    tps: Number.isFinite(Number(entry?.tps)) ? Number(entry.tps) : null,
    samples: finiteNumber(entry?.samples),
  });
  const byModel = {};
  for (const [key, entry] of Object.entries(performance?.byModel || {})) {
    byModel[key] = summarize(entry);
  }
  return { total: summarize(performance?.total), byModel };
}

/**
 * Normalise the balance/quota book. Keeps only display fields — the source
 * document never contains keys, and we drop anything unexpected.
 * @returns {{sites:Array<{id,label,kind,currency,usd,usedUsd,limitUsd,quotas,error,checkedAt}>}}
 */
export function normalizeBalance(balance = {}) {
  const sites = Array.isArray(balance?.sites) ? balance.sites : [];
  return {
    sites: sites.map((site) => {
      const last = site?.lastBalance || null;
      const quotas = Array.isArray(last?.quotas)
        ? last.quotas.map((quota) => ({
            label: String(quota?.label ?? ''),
            used: finiteNumber(quota?.used),
            limit: finiteNumber(quota?.limit),
            unit: quota?.unit,
            resetsAt: finiteNumber(quota?.resetsAt),
          }))
        : [];
      return {
        id: String(site?.id ?? ''),
        label: String(site?.label ?? site?.id ?? ''),
        kind: String(site?.kind ?? ''),
        currency: String(last?.currency ?? 'USD'),
        usd: Number.isFinite(Number(last?.usd)) ? Number(last.usd) : null,
        usedUsd: Number.isFinite(Number(last?.usedUsd)) ? Number(last.usedUsd) : null,
        limitUsd: Number.isFinite(Number(last?.limitUsd)) ? Number(last.limitUsd) : null,
        quotas,
        error: String(site?.error ?? ''),
        checkedAt: finiteNumber(site?.lastCheckedAt),
        noPlan: site?.noPlan === true,
      };
    }),
  };
}

/**
 * Pick the usage source: token-metrics first, then the billing plugin.
 * The two are mutually exclusive by preference, not by requirement — if both
 * are installed token-metrics wins because it also knows cost, TTFT and budget.
 *
 * @param {Object} ctx
 * @param {{hasBilling?: () => Promise<boolean>, hasTokenMetrics?: () => Promise<boolean>}} [detectors]
 * @returns {Promise<'token-metrics'|'usage-billing'|null>}
 */
export async function detectUsageSource(ctx, detectors = {}) {
  const hasTokenMetrics = detectors.hasTokenMetrics || (() => hasTokenMetricsPlugin(ctx));
  const hasBilling = detectors.hasBilling;
  try {
    if (await hasTokenMetrics()) return 'token-metrics';
  } catch {
    // keep probing
  }
  if (typeof hasBilling === 'function') {
    try {
      if (await hasBilling()) return 'usage-billing';
    } catch {
      // no source
    }
  }
  return null;
}
