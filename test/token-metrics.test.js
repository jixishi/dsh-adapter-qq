import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  budgetDocument,
  countersToCell,
  detectUsageSource,
  fetchTokenMetricsSummary,
  fetchTokenMetricsVersion,
  hasTokenMetricsPlugin,
  normalizeBalance,
  normalizePerformance,
  normalizeTokenMetrics,
} from '../lib/sync/token-metrics.js';
import { aggregateUsageRange, buildUsageMarkdown, buildUsageTypst } from '../lib/sync/usage.js';

function dayKey(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

const counters = (calls, input, output, cacheRead) => ({
  calls,
  inputTokens: input,
  outputTokens: output,
  cacheReadTokens: cacheRead,
  cacheWriteTokens: 0,
  reasoningTokens: 20,
  totalTokens: input + output + cacheRead,
});

function sampleSummary(now = Date.now()) {
  const today = dayKey(new Date(now));
  const yesterday = dayKey(new Date(now - 86400000));
  return {
    generatedAt: now,
    totals: { all: counters(1456, 100000, 50000, 900000) },
    byDay: { [yesterday]: counters(3, 400, 200, 3000), [today]: counters(8, 1000, 500, 9000) },
    byDayModel: {
      [today]: {
        'workbuddy/flash': counters(6, 800, 400, 7000),
        'deepseek/deepseek-v4-pro': counters(2, 200, 100, 2000),
      },
    },
    byDayModelName: {
      [today]: { flash: counters(6, 800, 400, 7000), 'deepseek-v4-pro': counters(2, 200, 100, 2000) },
    },
    byModelName: {
      flash: counters(1450, 99000, 49500, 890000),
      'deepseek-v4-pro': counters(6, 1000, 500, 10000),
    },
    byModel: {
      'workbuddy/flash': counters(1450, 99000, 49500, 890000),
      'deepseek/deepseek-v4-pro': counters(6, 1000, 500, 10000),
    },
    byProject: {
      'W:/dsh-plugins/dsh-adapter-qq': counters(1400, 90000, 45000, 800000),
      'W:/dev/USB': counters(56, 10000, 5000, 100000),
    },
    byOrigin: { main: counters(1400, 90000, 45000, 800000), subagent: counters(56, 10000, 5000, 100000) },
    cost: {
      totalUsd: 8.5,
      byDay: { [yesterday]: 0.02, [today]: 0.12 },
      byModelName: { flash: { usd: 8, priced: true } },
      fx: { usdCny: 7.2 },
      unpriced: [{ model: 'qfmodel', tokens: 1234 }],
    },
    performance: { total: { ttftMs: 812, tps: 44.2, samples: 1456 }, byModel: {} },
    config: { budget: { dailyUsd: 3, monthlyUsd: 50, warnPercent: 80, groups: [] } },
    balance: {
      sites: [
        { id: 'k', label: 'Kimi', kind: 'kimi', lastBalance: { usd: 12, currency: 'USD', quotas: [] }, error: '' },
        {
          id: 'g',
          label: 'GLM',
          kind: 'glm',
          lastBalance: { usd: null, currency: 'USD', quotas: [{ label: '5h', used: 20, limit: 100 }] },
          error: '',
        },
        { id: 'x', label: 'Broken', kind: 'newapi', lastBalance: null, error: 'HTTP 401' },
      ],
    },
  };
}

describe('dsh-token-metrics integration', () => {
  it('detects the plugin from the Loader tree and the inventory', async () => {
    const loaderCtx = {
      get: (name) =>
        name === 'loader'
          ? {
              entries: () => [
                {
                  options: { name: 'cordis:group', group: true },
                  children: [{ options: { name: 'dsh-token-metrics' }, disabled: false }],
                },
              ],
            }
          : undefined,
    };
    assert.equal(await hasTokenMetricsPlugin(loaderCtx), true);

    const inventoryCtx = {
      get: (name) =>
        name === 'pluginInventory'
          ? { list: async () => ({ entries: [{ moduleName: 'dsh-token-metrics', enabled: true, fiberPhase: 'active' }] }) }
          : undefined,
    };
    assert.equal(await hasTokenMetricsPlugin(inventoryCtx), true);

    // Disabled / failed entries must not count.
    const failedCtx = {
      get: (name) =>
        name === 'pluginInventory'
          ? { list: async () => ({ entries: [{ moduleName: 'dsh-token-metrics', enabled: true, fiberPhase: 'failed' }] }) }
          : undefined,
    };
    assert.equal(await hasTokenMetricsPlugin(failedCtx), false);
    assert.equal(await hasTokenMetricsPlugin({ get: () => undefined }), false);
  });

  it('reads the loopback summary and version endpoints', async () => {
    const seen = [];
    const fetchImpl = async (url) => {
      seen.push(url);
      if (url.endsWith('/summary')) {
        return { ok: true, status: 200, json: async () => ({ totals: { all: counters(1, 10, 5, 0) } }) };
      }
      return { ok: true, status: 200, json: async () => ({ version: '0.3.7' }) };
    };
    const ctx = { get: (name) => (name === 'webServer' ? { getOrigin: () => 'http://127.0.0.1:53414/' } : undefined) };

    const summary = await fetchTokenMetricsSummary({ ctx, fetchImpl });
    assert.equal(summary.totals.all.calls, 1);
    assert.equal(await fetchTokenMetricsVersion({ ctx, fetchImpl }), '0.3.7');
    assert.ok(seen.every((url) => url.startsWith('http://127.0.0.1:53414/api/dsh-token-metrics/')));

    // Missing webServer must fail with an explanatory message, not a TypeError.
    await assert.rejects(() => fetchTokenMetricsSummary({ ctx: { get: () => undefined }, fetchImpl }), /webServer/);

    // A version endpoint failure is not fatal (the badge is cosmetic).
    const failingVersion = async () => ({ ok: false, status: 500, json: async () => ({}) });
    assert.equal(await fetchTokenMetricsVersion({ ctx, fetchImpl: failingVersion }), undefined);
  });

  it('maps counters to cells with the hit/(hit+miss) convention', () => {
    const cell = countersToCell({ calls: 2, inputTokens: 100, outputTokens: 10, cacheReadTokens: 900 });
    assert.equal(cell.calls, 2);
    assert.equal(cell.input, 100);
    assert.equal(cell.output, 10);
    assert.equal(cell.cacheHit, 900);
    assert.equal(cell.cacheMiss, 100);
    // Tolerates junk without producing NaN.
    const junk = countersToCell({ calls: 'x', inputTokens: null });
    assert.equal(junk.calls, 0);
    assert.equal(junk.input, 0);
  });

  it('converts USD cost to CNY with the snapshot exchange rate', () => {
    const stats = normalizeTokenMetrics(sampleSummary(), { version: '0.3.7' });
    assert.equal(stats.source, 'dsh-token-metrics');
    assert.equal(stats.pluginVersion, '0.3.7');
    assert.equal(stats.fx, 7.2);
    assert.equal(stats.total.cost, 8.5 * 7.2);
    assert.equal(stats.currency, 'CNY');
  });

  it('builds the provider (site) facet as day -> model -> site', () => {
    const stats = normalizeTokenMetrics(sampleSummary());
    const today = dayKey();
    const daySites = stats.byDayModelsSite[today];
    assert.equal(daySites.flash.workbuddy.calls, 6);
    assert.equal(daySites['deepseek-v4-pro'].deepseek.calls, 2);

    const sites = aggregateUsageRange(stats, 'all').sites;
    const names = sites.map((row) => row.site).sort();
    assert.deepEqual(names, ['deepseek', 'workbuddy']);
    // Costs must survive the aggregation, not collapse to zero.
    assert.ok(sites.every((row) => row.cost > 0));
  });

  it('maps budgets from USD to CNY and keeps daily/monthly apart', () => {
    const budget = budgetDocument({ dailyUsd: 3, monthlyUsd: 50, groups: [] }, { fx: 7.2 });
    assert.equal(budget.monthlyBudgetCny, 360);
    assert.equal(budget.dailyBudgetCny, 21.6);

    const stats = normalizeTokenMetrics(sampleSummary());
    assert.equal(stats.budget, 360);
    assert.equal(stats.dailyBudgetCny, 21.6);
    // Zero budget stays zero so the renderer hides the block.
    assert.equal(budgetDocument({ monthlyUsd: 0 }, { fx: 7.2 }).monthlyBudgetCny, 0);
  });

  it('normalises performance and balance without leaking secrets', () => {
    const perf = normalizePerformance({ total: { ttftMs: 812, tps: 44.2, samples: 10 } });
    assert.equal(perf.total.ttftMs, 812);
    assert.equal(perf.total.tps, 44.2);
    // A missing dimension must be null, not a fake zero.
    assert.equal(normalizePerformance({}).total.ttftMs, null);

    const balance = normalizeBalance(sampleSummary().balance);
    assert.equal(balance.sites.length, 3);
    assert.equal(balance.sites[0].usd, 12);
    assert.equal(balance.sites[1].quotas.length, 1);
    assert.equal(balance.sites[2].error, 'HTTP 401');
    const serialized = JSON.stringify(balance);
    assert.ok(!serialized.includes('apiKey'));
    assert.ok(!serialized.includes('sk-'));
  });

  it('renders latency, project, origin and balance sections', () => {
    const stats = normalizeTokenMetrics(sampleSummary(), { version: '0.3.7' });
    const markdown = buildUsageMarkdown(stats, { range: 'month' });
    assert.ok(markdown.includes('性能指标'));
    assert.ok(markdown.includes('812ms'));
    assert.ok(markdown.includes('44.2 t/s'));
    assert.ok(markdown.includes('项目分布'));
    assert.ok(markdown.includes('来源分布'));
    assert.ok(markdown.includes('供应商余额'));
    assert.ok(markdown.includes('dsh-token-metrics v0.3.7'));
    assert.ok(markdown.includes('未匹配到价格'));

    const typst = buildUsageTypst(stats, { range: 'month', theme: 'dark' });
    for (const needle of ['平均首字延迟', '项目分布', '来源分布', '供应商余额', '未匹配到价格', '日预算']) {
      assert.ok(typst.includes(needle), `typst body must contain ${needle}`);
    }
    // Dollar signs inside content blocks open Typst math and break the compile.
    assert.ok(!/[^\\]\$/.test(typst), 'every $ inside Typst content must be escaped');
  });

  it('does not mask bare provider identifiers as hostnames', () => {
    const stats = normalizeTokenMetrics(sampleSummary());
    const typst = buildUsageTypst(stats, { range: 'all' });
    assert.ok(typst.includes('WorkBuddy') || typst.includes('workbuddy'));
    assert.ok(!typst.includes('***'), 'provider ids must not be masked');
  });

  it('prefers token-metrics over usage-billing and falls back', async () => {
    assert.equal(
      await detectUsageSource({}, { hasTokenMetrics: async () => true, hasBilling: async () => true }),
      'token-metrics'
    );
    assert.equal(
      await detectUsageSource({}, { hasTokenMetrics: async () => false, hasBilling: async () => true }),
      'usage-billing'
    );
    assert.equal(
      await detectUsageSource({}, { hasTokenMetrics: async () => false, hasBilling: async () => false }),
      null
    );
    // A throwing detector must not break the fallback chain.
    assert.equal(
      await detectUsageSource(
        {},
        {
          hasTokenMetrics: async () => {
            throw new Error('boom');
          },
          hasBilling: async () => true,
        }
      ),
      'usage-billing'
    );
  });

  it('uses the lifetime totals for the "all" range', () => {
    const stats = normalizeTokenMetrics(sampleSummary());
    const all = aggregateUsageRange(stats, 'all');
    // byDay only lists two days, but totals.all reports the lifetime calls.
    assert.equal(all.total.calls, 1456);
  });
});
