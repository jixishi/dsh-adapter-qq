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

function displaySite(value) {
  const raw = String(value || '');
  const direct = raw.startsWith('direct:') ? raw.slice(7) : '';
  const directLabels = {
    'deepseek-account': 'DeepSeek 账户',
    deepseek: 'DeepSeek',
    'ai-gateway': 'AI Gateway',
    'minimax-cn': 'MiniMax CN',
  };
  if (direct) return directLabels[direct] || direct.replace(/-/g, ' ');

  const url = raw.startsWith('site:') ? raw.slice(5) : raw;
  let host = url;
  try {
    host = new URL(url).host || url;
  } catch {
    host = url.replace(/^https?:\/\//, '').split('/')[0];
  }
  return host.length > 38 ? `${host.slice(0, 37)}…` : host;
}

function sumRows(rows) {
  return rows.reduce(
    (acc, row) => ({
      cost: acc.cost + (Number(row?.cost) || 0),
      calls: acc.calls + (Number(row?.calls) || 0),
      input: acc.input + (Number(row?.input) || 0),
      output: acc.output + (Number(row?.output) || 0),
    }),
    { cost: 0, calls: 0, input: 0, output: 0 }
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

/**
 * Build the Markdown rendered for `/usage`.
 * @param {Object} stats
 * @param {number} [now]
 * @returns {string}
 */
export function buildUsageMarkdown(stats = {}, nowOrOptions = Date.now()) {
  const options = nowOrOptions && typeof nowOrOptions === 'object' ? nowOrOptions : { now: nowOrOptions };
  const now = Number.isFinite(Number(options.now)) ? Number(options.now) : Date.now();
  const modelNames = options.modelNames;
  const modelLabel = (key) => modelNames?.get?.(key) || key;
  const todayKey = localDayKey(new Date(now));
  const monthKey = todayKey.slice(0, 7);
  const byDay = stats.byDay && typeof stats.byDay === 'object' ? stats.byDay : {};
  const today = sumRows([byDay[todayKey] || {}]);
  const month = sumRows(
    Object.entries(byDay)
      .filter(([day]) => String(day).startsWith(monthKey))
      .map(([, cell]) => cell)
  );
  const total = {
    cost: Number(stats.total?.cost) || 0,
    calls: Number(stats.total?.calls) || 0,
    input: Number(stats.total?.input) || 0,
    output: Number(stats.total?.output) || 0,
  };

  const byModel = Object.entries(stats.byModel && typeof stats.byModel === 'object' ? stats.byModel : {})
    .map(([model, cell]) => ({ model, ...sumRows([cell]) }))
    .sort((a, b) => b.cost - a.cost)
    .slice(0, 6);

  const bySite = Object.entries(stats.bySite && typeof stats.bySite === 'object' ? stats.bySite : {})
    .map(([site, cell]) => ({ site, ...sumRows([cell]) }))
    .sort((a, b) => b.cost - a.cost)
    .slice(0, 5);

  const totalCost = total.cost > 0 ? total.cost : byModel.reduce((sum, row) => sum + row.cost, 0);
  const share = (cost) => (totalCost > 0 ? Math.min(100, Math.round((Number(cost) / totalCost) * 100)) : 0);
  const bar = (percent, width = 8) => {
    const filled = Math.max(0, Math.min(width, Math.round((percent / 100) * width)));
    return `${'█'.repeat(filled)}${'░'.repeat(width - filled)}`;
  };
  const siteTotal = bySite.reduce((sum, row) => sum + row.cost, 0);
  const siteShare = (cost) => (siteTotal > 0 ? Math.round((Number(cost) / siteTotal) * 100) : 0);

  const lines = [
    '## 💰 费用概览',
    `> 💰 **今日**  ${formatMoney(today.cost)}  ·  ${today.calls} 次  ·  ${formatTokens(
      today.input + today.output
    )} tokens`,
    `> 📅 **本月**  ${formatMoney(month.cost)}  ·  ${month.calls} 次  ·  ${formatTokens(
      month.input + month.output
    )} tokens`,
    `> 📈 **累计**  ${formatMoney(total.cost)}  ·  ${total.calls} 次  ·  ${formatTokens(
      total.input + total.output
    )} tokens`,
  ];

  const budget = Number(stats.budget);
  if (Number.isFinite(budget) && budget > 0) {
    const used = Math.min(100, (month.cost / budget) * 100);
    lines.push(
      '',
      `**本月预算** ${formatMoney(budget)} · 已用 ${used.toFixed(1)}% · 剩余 ${formatMoney(
        Math.max(0, budget - month.cost)
      )}`,
      `${bar(used, 16)}`,
      ''
    );
  } else {
    lines.push('');
  }

  lines.push(
    '## 🧠 模型用量',
    byModel.length
      ? table(
          ['模型', '费用', '占比', '调用', 'Tokens'],
          byModel.map((row) => [
            modelLabel(row.model),
            formatMoney(row.cost),
            `${bar(share(row.cost))} ${share(row.cost)}%`,
            String(row.calls),
            `${formatTokens(row.input)} / ${formatTokens(row.output)}`,
          ])
        )
      : '暂无模型用量数据。'
  );

  if (bySite.length > 0) {
    lines.push(
      '',
      '## 🌐 站点分布',
      table(
        ['站点', '费用', '占比', '调用'],
        bySite.map((row) => [
          displaySite(row.site),
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
export function buildUsageTypst(stats = {}, { now = Date.now(), theme = 'light', modelNames } = {}) {
  const c = TYPST_PALETTES[theme === 'dark' ? 'dark' : 'light'];
  const modelLabel = (key) => modelNames?.get?.(key) || key;
  const todayKey = localDayKey(new Date(now));
  const monthKey = todayKey.slice(0, 7);
  const byDay = stats.byDay && typeof stats.byDay === 'object' ? stats.byDay : {};
  const today = sumRows([byDay[todayKey] || {}]);
  const month = sumRows(
    Object.entries(byDay)
      .filter(([day]) => String(day).startsWith(monthKey))
      .map(([, cell]) => cell)
  );
  const total = {
    cost: Number(stats.total?.cost) || 0,
    calls: Number(stats.total?.calls) || 0,
    input: Number(stats.total?.input) || 0,
    output: Number(stats.total?.output) || 0,
  };
  const byModel = Object.entries(stats.byModel && typeof stats.byModel === 'object' ? stats.byModel : {})
    .map(([model, cell]) => ({ model, ...sumRows([cell]) }))
    .sort((a, b) => b.cost - a.cost)
    .slice(0, 6);
  const bySite = Object.entries(stats.bySite && typeof stats.bySite === 'object' ? stats.bySite : {})
    .map(([site, cell]) => ({ site, ...sumRows([cell]) }))
    .sort((a, b) => b.cost - a.cost)
    .slice(0, 5);
  const totalCost = total.cost > 0 ? total.cost : byModel.reduce((sum, row) => sum + row.cost, 0);
  const share = (cost) => (totalCost > 0 ? Math.min(100, Math.round((Number(cost) / totalCost) * 100)) : 0);
  const siteTotal = bySite.reduce((sum, row) => sum + row.cost, 0);
  const siteShare = (cost) => (siteTotal > 0 ? Math.round((Number(cost) / siteTotal) * 100) : 0);

  const card = (label, value, sub) =>
    `block(width: 100%, fill: rgb("${c.card}"), radius: 9pt, inset: (x: 12pt, y: 11pt))[
  #text(size: 10pt, fill: rgb("${c.muted}"))[${label}]
  #v(3pt)
  #text(size: 21pt, weight: "bold", fill: rgb("${c.text}"))[${value}]
  #v(3pt)
  #text(size: 9pt, fill: rgb("${c.muted}"))[${sub}]
]`;
  const shareCell = (percent) =>
    `#box(width: 52pt, height: 5pt, radius: 2.5pt, fill: rgb("${c.barBg}"), clip: true)[#rect(width: ${percent}%, height: 5pt, fill: rgb("${c.accent}"))] #h(4pt) #text(size: 9pt, fill: rgb("${c.muted}"))[${percent}%]`;

  const cards = [
    card('今日费用', formatMoney(today.cost), `${today.calls} 次 · ${formatTokens(today.input + today.output)} tokens`),
    card('本月费用', formatMoney(month.cost), `${month.calls} 次 · ${formatTokens(month.input + month.output)} tokens`),
    card('累计费用', formatMoney(total.cost), `${total.calls} 次 · ${formatTokens(total.input + total.output)} tokens`),
  ].join(',\n  ');

  const modelRows = byModel
    .map(
      (row) =>
        `[${typstEscape(modelLabel(row.model))}], [${formatMoney(row.cost)}], [${shareCell(
          share(row.cost)
        )}], [${row.calls}], [${formatTokens(row.input)} / ${formatTokens(row.output)}]`
    )
    .join(',\n  ');

  const siteRows = bySite
    .map(
      (row) =>
        `[${typstEscape(displaySite(row.site))}], [${formatMoney(row.cost)}], [${shareCell(
          siteShare(row.cost)
        )}], [${row.calls}]`
    )
    .join(',\n  ');

  const budget = Number(stats.budget);
  const budgetBlock =
    Number.isFinite(budget) && budget > 0
      ? (() => {
          const used = Math.min(100, (month.cost / budget) * 100);
          return `\n#v(9pt)
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

  return `#grid(columns: (1fr, 1fr, 1fr), gutter: 9pt,
  ${cards}
)
${budgetBlock}
#v(12pt)
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
${bySite.length > 0 ? `#v(12pt)
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
