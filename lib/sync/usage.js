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
export function buildUsageMarkdown(stats = {}, now = Date.now()) {
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

  const lines = [
    `## 费用概览${stats.budget ? `（本月预算 ${formatMoney(stats.budget)}）` : ''}`,
    table(
      ['范围', '估算费用', '调用', '输入', '输出'],
      [
        ['今日', formatMoney(today.cost), String(today.calls), `${formatTokens(today.input)} tokens`, `${formatTokens(today.output)} tokens`],
        ['本月', formatMoney(month.cost), String(month.calls), `${formatTokens(month.input)} tokens`, `${formatTokens(month.output)} tokens`],
        ['累计', formatMoney(total.cost), String(total.calls), `${formatTokens(total.input)} tokens`, `${formatTokens(total.output)} tokens`],
      ]
    ),
    '',
    '## 模型用量 Top',
    byModel.length
      ? table(
          ['模型', '费用', '调用', '输入', '输出'],
          byModel.map((row) => [
            row.model,
            formatMoney(row.cost),
            String(row.calls),
            formatTokens(row.input),
            formatTokens(row.output),
          ])
        )
      : '暂无模型用量数据。',
  ];

  if (bySite.length > 0) {
    lines.push(
      '',
      '## 站点用量 Top',
      table(
        ['站点', '费用', '调用'],
        bySite.map((row) => [row.site, formatMoney(row.cost), String(row.calls)])
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
