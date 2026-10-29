/**
 * Optional integration with @kenz1117/dsh-ui-usage-billing.
 *
 * The billing plugin aggregates usage from persisted session logs and exposes
 * it at GET /api/billing/usage-stats on the host web server. We only read that
 * loopback endpoint; nothing is written and no billing settings are changed.
 */

const PLUGIN_PATTERN = /dsh-ui-usage-billing$/;

/** Detect the billing plugin from the Loader tree or plugin inventory. */
export async function hasUsageBillingPlugin(ctx) {
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

/** @param {Object} webServer */
export function resolveWebOrigin(webServer) {
  try {
    const origin = webServer?.getOrigin?.();
    if (typeof origin === 'string' && origin) return origin.replace(/\/$/, '');
  } catch {
    // fall back to the port
  }
  if (Number.isFinite(Number(webServer?.port))) return `http://127.0.0.1:${webServer.port}`;
  return '';
}

/**
 * Fetch the billing usage document.
 * @param {Object} options
 * @param {import('@deepseek-ai/cordis').Context} options.ctx
 * @param {Function} [options.fetchImpl]
 * @param {number} [options.timeoutMs]
 * @returns {Promise<Object>}
 */
export async function fetchUsageStats({ ctx, fetchImpl = globalThis.fetch, timeoutMs = 8000 } = {}) {
  const webServer = ctx?.get?.('webServer');
  const origin = resolveWebOrigin(webServer);
  if (!origin) throw new Error('宿主 webServer 未就绪，无法访问用量接口');
  if (typeof fetchImpl !== 'function') throw new Error('当前环境没有 fetch');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs);
  let response;
  try {
    response = await fetchImpl(`${origin}/api/billing/usage-stats`, {
      method: 'GET',
      headers: { accept: 'application/json' },
      signal: controller.signal,
    });
  } catch (error) {
    throw new Error(controller.signal.aborted ? `用量接口超时（${timeoutMs}ms）` : `无法连接用量接口：${error.message}`);
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) throw new Error(`用量接口返回 HTTP ${response.status}`);
  const data = await response.json().catch(() => null);
  if (!data || typeof data !== 'object') throw new Error('用量接口返回了非 JSON 数据');
  return data;
}

/**
 * Fetch the billing catalog and map model keys (`flash`, `gemini-3.8-flash`…)
 * to their display names (`DeepSeek V4.1 Flash`…).
 * @param {Object} options
 * @param {import('@deepseek-ai/cordis').Context} options.ctx
 * @param {Function} [options.fetchImpl]
 * @param {number} [options.timeoutMs]
 * @returns {Promise<Map<string,string>>}
 */
export async function fetchUsagePricing({ ctx, fetchImpl = globalThis.fetch, timeoutMs = 8000 } = {}) {
  const webServer = ctx?.get?.('webServer');
  const origin = resolveWebOrigin(webServer);
  if (!origin) throw new Error('宿主 webServer 未就绪，无法访问计费目录');
  if (typeof fetchImpl !== 'function') throw new Error('当前环境没有 fetch');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs);
  let response;
  try {
    response = await fetchImpl(`${origin}/api/billing/pricing`, {
      method: 'GET',
      headers: { accept: 'application/json' },
      signal: controller.signal,
    });
  } catch (error) {
    throw new Error(controller.signal.aborted ? `计费目录超时（${timeoutMs}ms）` : `无法连接计费目录：${error.message}`);
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) throw new Error(`计费目录返回 HTTP ${response.status}`);
  const data = await response.json().catch(() => null);
  const catalog = Array.isArray(data?.catalog) ? data.catalog : [];
  const names = new Map();
  for (const entry of catalog) {
    if (entry && typeof entry.key === 'string' && typeof entry.name === 'string' && entry.name) {
      names.set(entry.key, entry.name);
    }
  }
  return names;
}

/**
 * Fetch the relay directory and map site origins / hosts to registered names.
 * `/api/billing/relay-quotas` exposes `{ route, origin, displayName }` rows; the
 * dashboard uses those names instead of the raw domains.
 * @param {Object} options
 * @param {import('@deepseek-ai/cordis').Context} options.ctx
 * @param {Function} [options.fetchImpl]
 * @param {number} [options.timeoutMs]
 * @returns {Promise<Map<string,string>>}
 */
export async function fetchRelayDirectory({ ctx, fetchImpl = globalThis.fetch, timeoutMs = 8000 } = {}) {
  const webServer = ctx?.get?.('webServer');
  const origin = resolveWebOrigin(webServer);
  if (!origin) throw new Error('宿主 webServer 未就绪，无法访问中转站目录');
  if (typeof fetchImpl !== 'function') throw new Error('当前环境没有 fetch');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs);
  let response;
  try {
    response = await fetchImpl(`${origin}/api/billing/relay-quotas`, {
      method: 'GET',
      headers: { accept: 'application/json' },
      signal: controller.signal,
    });
  } catch (error) {
    throw new Error(controller.signal.aborted ? `中转站目录超时（${timeoutMs}ms）` : `无法连接中转站目录：${error.message}`);
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) throw new Error(`中转站目录返回 HTTP ${response.status}`);
  const data = await response.json().catch(() => null);
  const names = new Map();
  for (const entry of Array.isArray(data?.quotas) ? data.quotas : []) {
    if (!entry || typeof entry.displayName !== 'string' || !entry.displayName) continue;
    if (typeof entry.origin === 'string' && entry.origin) {
      names.set(entry.origin.replace(/\/$/, ''), entry.displayName);
      try {
        names.set(new URL(entry.origin).host, entry.displayName);
      } catch {
        // keep the origin key only
      }
    }
  }
  return names;
}

function localDayKey(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function formatMoney(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return '¥0.00';
  return `¥${number.toFixed(number >= 1 ? 2 : 4)}`;
}

function formatTokens(value) {
  const number = Math.max(0, Number(value) || 0);
  if (number >= 1e9) return `${(number / 1e9).toFixed(2)}B`;
  if (number >= 1e6) return `${(number / 1e6).toFixed(2)}M`;
  if (number >= 1e4) return `${(number / 1e3).toFixed(1)}K`;
  return String(Math.round(number));
}

function maskHost(host) {
  const parts = String(host || '').replace(/^www\./i, '').split('.').filter(Boolean);
  if (parts.length >= 2) return `***.${parts.slice(-2).join('.')}`;
  return '***';
}

function displaySite(value, siteNames) {
  const raw = String(value || '');
  const direct = raw.startsWith('direct:') ? raw.slice(7) : '';
  const directLabels = {
    'deepseek-account': 'DeepSeek 账户',
    deepseek: 'DeepSeek',
    'ai-gateway': 'AI Gateway',
    'minimax-cn': 'MiniMax CN',
    workbuddy: 'WorkBuddy',
  };
  if (direct) return directLabels[direct] || direct.replace(/-/g, ' ');

  const url = raw.startsWith('site:') ? raw.slice(5) : raw;
  let host = url;
  try {
    host = new URL(url).host || url;
  } catch {
    host = url.replace(/^https?:\/\//, '').split('/')[0];
  }
  const registered = siteNames?.get?.(url.replace(/\/$/, '')) || siteNames?.get?.(host);
  if (registered) return registered;
  return maskHost(host);
}

function sumRows(rows) {
  return rows.reduce(
    (acc, row) => ({
      cost: acc.cost + (Number(row?.cost) || 0),
      calls: acc.calls + (Number(row?.calls) || 0),
      input: acc.input + (Number(row?.input) || 0),
      output: acc.output + (Number(row?.output) || 0),
      cacheHit: acc.cacheHit + (Number(row?.cacheHit) || 0),
      cacheMiss: acc.cacheMiss + (Number(row?.cacheMiss) || 0),
      reasoning: acc.reasoning + (Number(row?.reasoning) || 0),
    }),
    { cost: 0, calls: 0, input: 0, output: 0, cacheHit: 0, cacheMiss: 0, reasoning: 0 }
  );
}

function escapeCell(value) {
  return String(value ?? '')
    .replace(/\|/g, '\\|')
    .replace(/\n+/g, ' ')
    .trim();
}

function table(headers, rows) {
  return [
    `| ${headers.join(' | ')} |`,
    `| ${headers.map(() => '---').join(' | ')} |`,
    ...rows.map((row) => `| ${row.map(escapeCell).join(' | ')} |`),
  ].join('\n');
}

export const USAGE_RANGE_LABELS = {
  day: '今日',
  month: '本月',
  year: '本年',
  all: '累计',
};

/**
 * Parse `/usage <range>`; unknown/missing falls back to the current month.
 * @param {string} [input]
 * @returns {'day'|'month'|'year'|'all'}
 */
export function parseUsageRange(input) {
  const text = String(input ?? '').trim().toLowerCase();
  if (['day', 'today', '日', '今日', '今天'].includes(text)) return 'day';
  if (['year', '年', '本年', '今年'].includes(text)) return 'year';
  if (['all', '累计', '全部', '总'].includes(text)) return 'all';
  if (['month', '月', '本月', '这月'].includes(text)) return 'month';
  return 'month';
}

function dayKeysForRange(byDay, range, now) {
  const today = localDayKey(new Date(now));
  const monthKey = today.slice(0, 7);
  const yearKey = today.slice(0, 4);
  const keys = Object.keys(byDay || {}).sort();
  if (range === 'day') return keys.filter((day) => day === today);
  if (range === 'year') return keys.filter((day) => day.startsWith(yearKey));
  if (range === 'all') return keys;
  return keys.filter((day) => day.startsWith(monthKey));
}

function addCell(map, key, cell) {
  map.set(key, sumRows([map.get(key) || {}, cell || {}]));
}

/**
 * Aggregate the selected range from the per-day stats.
 * @param {Object} stats
 * @param {'day'|'month'|'year'|'all'} range
 * @param {number} [now]
 */
export function aggregateUsageRange(stats = {}, range = 'month', now = Date.now()) {
  const byDay = stats.byDay && typeof stats.byDay === 'object' ? stats.byDay : {};
  const keys = dayKeysForRange(byDay, range, now);
  const total = sumRows(keys.map((day) => byDay[day] || {}));
  const models = new Map();
  const sites = new Map();

  for (const day of keys) {
    const dayModels = stats.byDayModels?.[day];
    if (dayModels && typeof dayModels === 'object') {
      for (const [model, cell] of Object.entries(dayModels)) addCell(models, model, cell);
    }
    const daySites = stats.byDayModelsSite?.[day];
    if (daySites && typeof daySites === 'object') {
      for (const perModel of Object.values(daySites)) {
        if (!perModel || typeof perModel !== 'object') continue;
        for (const [site, cell] of Object.entries(perModel)) addCell(sites, site, cell);
      }
    }
  }

  // Older documents may omit the per-day breakdown; fall back to global maps.
  if (models.size === 0 && range === 'all' && stats.byModel) {
    for (const [model, cell] of Object.entries(stats.byModel)) addCell(models, model, cell);
  }
  if (sites.size === 0 && range === 'all' && stats.bySite) {
    for (const [site, cell] of Object.entries(stats.bySite)) addCell(sites, site, cell);
  }

  const modelRows = [...models]
    .map(([model, cell]) => ({ model, ...cell }))
    .sort((a, b) => b.cost - a.cost)
    .slice(0, 6);
  const siteRows = [...sites]
    .map(([site, cell]) => ({ site, ...cell }))
    .sort((a, b) => b.cost - a.cost)
    .slice(0, 5);

  let peak = null;
  for (const day of keys) {
    const cell = byDay[day] || {};
    if (!peak || Number(cell.cost) > Number(peak.cost)) peak = { day, ...sumRows([cell]) };
  }

  return {
    range,
    label: USAGE_RANGE_LABELS[range] || USAGE_RANGE_LABELS.month,
    keys,
    total,
    models: modelRows,
    sites: siteRows,
    peak,
    activeDays: keys.filter((day) => Number(byDay[day]?.calls) > 0).length,
  };
}

/** Last N local dates with their byDay cells, oldest first. */
export function heatmapDays(stats = {}, now = Date.now(), count = 30) {
  const byDay = stats.byDay && typeof stats.byDay === 'object' ? stats.byDay : {};
  const base = new Date(now);
  const days = [];
  for (let offset = count - 1; offset >= 0; offset -= 1) {
    const date = new Date(base.getFullYear(), base.getMonth(), base.getDate() - offset);
    const key = localDayKey(date);
    days.push({ key, ...sumRows([byDay[key] || {}]) });
  }
  return days;
}

/**
 * Build the Markdown rendered for `/usage`.
 * @param {Object} stats
 * @param {number} [now]
 * @returns {string}
 */
export function buildUsageMarkdown(stats = {}, options = {}) {
  const opts = options && typeof options === 'object' ? options : { now: options };
  const now = Number.isFinite(Number(opts.now)) ? Number(opts.now) : Date.now();
  const range = opts.range || 'month';
  const modelNames = opts.modelNames;
  const siteNames = opts.siteNames;
  const modelLabel = (key) => modelNames?.get?.(key) || key;
  const agg = aggregateUsageRange(stats, range, now);
  const { total } = agg;
  const label = USAGE_RANGE_LABELS[range] || USAGE_RANGE_LABELS.month;

  const share = (cost) => (total.cost > 0 ? Math.min(100, Math.round((Number(cost) / total.cost) * 100)) : 0);
  const bar = (percent, width = 8) => {
    const filled = Math.max(0, Math.min(width, Math.round((percent / 100) * width)));
    return `${'█'.repeat(filled)}${'░'.repeat(width - filled)}`;
  };
  const cacheTotal = total.cacheHit + total.cacheMiss;
  const cacheRate = cacheTotal > 0 ? ((total.cacheHit / cacheTotal) * 100).toFixed(1) : '0.0';
  const avgCost = total.calls > 0 ? total.cost / total.calls : 0;
  const ioRatio = total.output > 0 ? (total.input / total.output).toFixed(2) : '-';
  const reasoningRate =
    total.input + total.output > 0 ? ((total.reasoning / (total.input + total.output)) * 100).toFixed(1) : '0.0';

  const monthKey = localDayKey(new Date(now)).slice(0, 7);
  const month = sumRows(
    Object.entries(stats.byDay && typeof stats.byDay === 'object' ? stats.byDay : {})
      .filter(([day]) => String(day).startsWith(monthKey))
      .map(([, cell]) => cell)
  );
  const siteTotal = agg.sites.reduce((sum, row) => sum + row.cost, 0);
  const siteShare = (cost) => (siteTotal > 0 ? Math.round((Number(cost) / siteTotal) * 100) : 0);
  const heat = heatmapDays(stats, now)
    .map((day) => (day.cost > 0 ? '▓' : '·'))
    .join('');

  const lines = [
    `## 💰 费用概览 · ${label}`,
    `> **${label}费用** ${formatMoney(total.cost)} · ${total.calls} 次 · ${formatTokens(
      total.input + total.output
    )} tokens`,
    `> 缓存命中率 **${cacheRate}%** · 平均成本 **${formatMoney(avgCost)}** · 输入/输出比 **${ioRatio}**`,
    `> 活跃 ${agg.activeDays} 天 · 峰值 ${
      agg.peak ? `${agg.peak.day.slice(5)}（${formatMoney(agg.peak.cost)}）` : '-'
    }`,
    '',
    `最近 30 天：${heat}（左旧右新）`,
    '',
  ];

  const budget = Number(stats.budget);
  if (Number.isFinite(budget) && budget > 0) {
    const used = Math.min(100, (month.cost / budget) * 100);
    lines.push(
      `**本月预算** ${formatMoney(budget)} · 已用 ${used.toFixed(1)}% · 剩余 ${formatMoney(
        Math.max(0, budget - month.cost)
      )}`,
      `${bar(used, 16)}`,
      ''
    );
  }

  lines.push(
    '## 🧠 模型用量',
    agg.models.length
      ? table(
          ['模型', '费用', '占比', '调用', 'Tokens'],
          agg.models.map((row) => [
            modelLabel(row.model),
            formatMoney(row.cost),
            `${bar(share(row.cost))} ${share(row.cost)}%`,
            String(row.calls),
            `${formatTokens(row.input)} / ${formatTokens(row.output)}`,
          ])
        )
      : '暂无模型用量数据。'
  );

  if (agg.sites.length > 0) {
    lines.push(
      '',
      '## 🌐 站点分布',
      table(
        ['站点', '费用', '占比', '调用'],
        agg.sites.map((row) => [
          displaySite(row.site, siteNames),
          formatMoney(row.cost),
          `${bar(siteShare(row.cost))} ${siteShare(row.cost)}%`,
          String(row.calls),
        ])
      )
    );
  }

  lines.push(
    '',
    `数据来源：@kenz1117/dsh-ui-usage-billing${stats.pluginVersion ? ` v${stats.pluginVersion}` : ''}`,
    `生成时间：${new Date(now).toLocaleString('zh-CN', { hour12: false })}`
  );
  return lines.join('\n');
}

/** Escape plain text placed inside a Typst content block. */
function typstEscape(value) {
  return String(value ?? '').replace(/[\\)#$[\]*_`<>@~]/g, (char) => `\\${char}`);
}

const TYPST_PALETTES = {
  light: {
    text: '#1c1d21',
    muted: '#667085',
    accent: '#2f6feb',
    card: '#f4f7fd',
    border: '#e6eaf2',
    barBg: '#e8edf6',
    rowAlt: '#fafbfe',
  },
  dark: {
    text: '#e8eaed',
    muted: '#a0a6b2',
    accent: '#79a6ff',
    card: '#1c222b',
    border: '#2c313a',
    barBg: '#2b323d',
    rowAlt: '#181d25',
  },
};

/**
 * Dedicated Typst layout for `/usage` (rounded stat cards, budget progress,
 * share bars and zebra tables) — separate from the generic Markdown renderer.
 * @param {Object} stats
 * @param {{now?:number, theme?:'light'|'dark'}} [options]
 * @returns {string} Typst markup (body only)
 */
export function buildUsageTypst(
  stats = {},
  { now = Date.now(), theme = 'light', modelNames, siteNames, range = 'month' } = {}
) {
  const c = TYPST_PALETTES[theme === 'dark' ? 'dark' : 'light'];
  const modelLabel = (key) => modelNames?.get?.(key) || key;
  const agg = aggregateUsageRange(stats, range, now);
  const { total } = agg;
  const label = USAGE_RANGE_LABELS[range] || USAGE_RANGE_LABELS.month;

  const cacheTotal = total.cacheHit + total.cacheMiss;
  const cacheRate = cacheTotal > 0 ? ((total.cacheHit / cacheTotal) * 100).toFixed(1) : '0.0';
  const avgCost = total.calls > 0 ? total.cost / total.calls : 0;
  const ioRatio = total.output > 0 ? (total.input / total.output).toFixed(2) : '-';
  const reasoningRate =
    total.input + total.output > 0 ? ((total.reasoning / (total.input + total.output)) * 100).toFixed(1) : '0.0';

  const monthKey = localDayKey(new Date(now)).slice(0, 7);
  const month = sumRows(
    Object.entries(stats.byDay && typeof stats.byDay === 'object' ? stats.byDay : {})
      .filter(([day]) => String(day).startsWith(monthKey))
      .map(([, cell]) => cell)
  );
  const budget = Number(stats.budget);

  const card = (title, value, sub) =>
    `block(width: 100%, fill: rgb("${c.card}"), radius: 9pt, inset: (x: 11pt, y: 10pt))[
  #text(size: 9pt, fill: rgb("${c.muted}"))[${title}]
  #v(3pt)
  #text(size: 18pt, weight: "bold", fill: rgb("${c.text}"))[${value}]
  #v(2pt)
  #text(size: 8pt, fill: rgb("${c.muted}"))[${sub}]
]`;
  const shareCell = (percent) =>
    `#box(width: 52pt, height: 5pt, radius: 2.5pt, fill: rgb("${c.barBg}"), clip: true)[#rect(width: ${percent}%, height: 5pt, fill: rgb("${c.accent}"))] #h(4pt) #text(size: 9pt, fill: rgb("${c.muted}"))[${percent}%]`;

  const costShare = (cost) =>
    total.cost > 0 ? Math.min(100, Math.round((Number(cost) / total.cost) * 100)) : 0;
  const siteTotal = agg.sites.reduce((sum, row) => sum + row.cost, 0);
  const siteShare = (cost) => (siteTotal > 0 ? Math.round((Number(cost) / siteTotal) * 100) : 0);

  const row1 = [
    card(`${label}费用`, formatMoney(total.cost), `${total.calls} 次调用`),
    card('调用次数', String(total.calls), `${agg.activeDays} 天活跃`),
    card('Token 总量', formatTokens(total.input + total.output), `${formatTokens(total.input)} 输入 / ${formatTokens(total.output)} 输出`),
    card('平均成本', formatMoney(avgCost), '每次调用'),
  ].join(',\n  ');
  const row2 = [
    card('缓存命中率', `${cacheRate}%`, `${formatTokens(total.cacheHit)} 命中 / ${formatTokens(total.cacheMiss)} 未命中`),
    card('输入/输出比', ioRatio, '总输入 / 总输出'),
    card('思考占比', `${reasoningRate}%`, `${formatTokens(total.reasoning)} reasoning tokens`),
    card(
      '峰值日',
      agg.peak ? agg.peak.day.slice(5) : '-',
      agg.peak ? formatMoney(agg.peak.cost) : '暂无数据'
    ),
  ].join(',\n  ');

  const heatColors =
    theme === 'dark'
      ? ['#20262f', '#2a3a58', '#3f63a8', '#79a6ff']
      : ['#f2f5fb', '#dbe6ff', '#9db9ff', '#3f78e8'];
  const heatTextColors =
    theme === 'dark'
      ? ['#8b93a1', '#c7d2e6', '#e8eaed', '#0b0e14']
      : ['#667085', '#3f5f9e', '#1f2d3d', '#ffffff'];
  const days = heatmapDays(stats, now, 30);
  const maxCost = Math.max(1, ...days.map((day) => Number(day.cost) || 0));
  const levelOf = (day) => {
    const cost = Number(day.cost) || 0;
    if (cost <= 0) return 0;
    return Math.min(3, 1 + Math.floor((cost / maxCost) * 3));
  };
  const startWeekday = (new Date(`${days[0].key}T00:00:00`).getDay() + 6) % 7;
  const heatCells = [];
  for (const name of ['一', '二', '三', '四', '五', '六', '日']) {
    heatCells.push(`[#text(size: 8pt, fill: rgb("${c.muted}"))[${name}]]`);
  }
  for (let i = 0; i < startWeekday; i += 1) heatCells.push('[]');
  for (const day of days) {
    const level = levelOf(day);
    heatCells.push(
      `[#block(width: 100%, height: 30pt, radius: 4pt, fill: rgb("${heatColors[level]}"), inset: 4pt)[#text(size: 7pt, fill: rgb("${heatTextColors[level]}"))[${day.key.slice(5).replace('-', '/')}] #v(1pt) #text(size: 7pt, fill: rgb("${heatTextColors[level]}"))[${day.cost > 0 ? formatMoney(day.cost) : ''}]]]`
    );
  }
  while (heatCells.length % 7 !== 0) heatCells.push('[]');
  const weekColumns = Array.from({ length: 7 }, () => '1fr').join(', ');
  const legendCells = [
    `[#text(size: 8pt, fill: rgb("${c.muted}"))[少]]`,
    ...heatColors.map(
      (color) => `[#box(width: 12pt, height: 8pt, radius: 2pt, fill: rgb("${color}"))]`
    ),
    `[#text(size: 8pt, fill: rgb("${c.muted}"))[多]]`,
  ].join(', ');

  const modelRows = agg.models
    .map(
      (row) =>
        `[${typstEscape(modelLabel(row.model))}], [${formatMoney(row.cost)}], [${shareCell(
          costShare(row.cost)
        )}], [${row.calls}], [${formatTokens(row.input)} / ${formatTokens(row.output)}]`
    )
    .join(',\n  ');
  const siteRows = agg.sites
    .map(
      (row) =>
        `[${typstEscape(displaySite(row.site, siteNames))}], [${formatMoney(row.cost)}], [${shareCell(
          siteShare(row.cost)
        )}], [${row.calls}]`
    )
    .join(',\n  ');

  const budgetBlock =
    Number.isFinite(budget) && budget > 0
      ? (() => {
          const used = Math.min(100, (month.cost / budget) * 100);
          return `\n#v(10pt)
#block(width: 100%, fill: rgb("${c.card}"), radius: 9pt, inset: (x: 14pt, y: 12pt))[
  #grid(columns: (1fr, auto),
    [#text(size: 10pt, fill: rgb("${c.muted}"))[本月预算 ${formatMoney(budget)}]],
    [#text(size: 9pt, fill: rgb("${c.muted}"))[剩余 ${formatMoney(Math.max(0, budget - month.cost))}]]
  )
  #v(4pt)
  #text(size: 11pt, weight: "bold", fill: rgb("${c.text}"))[已用 ${used.toFixed(1)}%]
  #v(6pt)
  #box(width: 100%, height: 7pt, radius: 3.5pt, fill: rgb("${c.barBg}"), clip: true)[
    #rect(width: ${used.toFixed(1)}%, height: 7pt, fill: rgb("${c.accent}"))
  ]
]`;
        })()
      : '';

  const dataNote = `#v(10pt)
#text(size: 9pt, fill: rgb("${c.muted}"))[数据来源：\\@kenz1117/dsh-ui-usage-billing${
    stats.pluginVersion ? ` v${stats.pluginVersion}` : ''
  } · ${new Date(now).toLocaleString('zh-CN', { hour12: false })}]`;

  return `#grid(columns: (1fr, 1fr, 1fr, 1fr), gutter: 9pt,
  ${row1}
)
#v(9pt)
#grid(columns: (1fr, 1fr, 1fr, 1fr), gutter: 9pt,
  ${row2}
)
${budgetBlock}
#v(12pt)
#block(below: 4pt)[#text(size: 15pt, weight: "bold", fill: rgb("${c.accent}"))[用量热力图]]
#text(size: 9pt, fill: rgb("${c.muted}"))[最近 30 天 · 合计 ${formatMoney(
    days.reduce((sum, day) => sum + (Number(day.cost) || 0), 0)
  )} · 活跃 ${days.filter((day) => day.calls > 0).length} 天]
#v(6pt)
#grid(columns: (${weekColumns}), gutter: 4pt,
  ${heatCells.join(',\n  ')}
)
#v(4pt)
#grid(columns: (auto, auto, auto, auto, auto, auto, auto), gutter: 4pt,
  ${legendCells}
)
#v(14pt)
#block(below: 7pt)[#text(size: 15pt, weight: "bold", fill: rgb("${c.accent}"))[模型用量]]
#table(
  columns: (1.5fr, 0.7fr, 1.05fr, 0.55fr, 1.05fr),
  inset: (x: 8pt, y: 7pt),
  align: (left, right, left, right, right),
  stroke: none,
  fill: (col, row) => if row == 0 { rgb("${c.card}") } else if calc.odd(row) { rgb("${c.rowAlt}") } else { none },
  table.header(
    [*模型*], [*费用*], [*占比*], [*调用*], [*Tokens*]
  ),
  ${modelRows || '[暂无模型用量数据。], [], [], [], []'}
)
${agg.sites.length > 0 ? `#v(12pt)
#block(below: 7pt)[#text(size: 15pt, weight: "bold", fill: rgb("${c.accent}"))[站点分布]]
#table(
  columns: (1.7fr, 0.7fr, 1.05fr, 0.55fr),
  inset: (x: 8pt, y: 7pt),
  align: (left, right, left, right),
  stroke: none,
  fill: (col, row) => if row == 0 { rgb("${c.card}") } else if calc.odd(row) { rgb("${c.rowAlt}") } else { none },
  table.header(
    [*站点*], [*费用*], [*占比*], [*调用*]
  ),
  ${siteRows}
)` : ''}
${dataNote}`;
}
