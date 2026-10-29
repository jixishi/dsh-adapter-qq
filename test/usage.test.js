import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  aggregateUsageRange,
  buildUsageMarkdown,
  buildUsageTypst,
  fetchRelayDirectory,
  fetchUsagePricing,
  fetchUsageStats,
  hasUsageBillingPlugin,
  heatmapDays,
  parseUsageRange,
  resolveWebOrigin,
} from '../lib/sync/usage.js';

function dayKey(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function sampleStats(now = Date.now()) {
  const today = dayKey(new Date(now));
  const yesterday = dayKey(new Date(now - 86400000));
  const cell = (cost, calls) => ({ cost, calls, input: 1000, output: 500, cacheHit: 900, cacheMiss: 100 });
  return {
    pluginVersion: '1.8.0',
    budget: 100,
    byDay: { [yesterday]: cell(2, 2), [today]: cell(10, 8) },
    byDayModels: {
      [yesterday]: { flash: cell(2, 2) },
      [today]: {
        flash: cell(6, 5),
        'gemini-3.8-flash': cell(4, 3),
      },
    },
    byDayModelsSite: {
      [today]: {
        flash: {
          'site:https://cli-proxy-api-latest-88hq.onrender.com': cell(6, 5),
        },
        'gemini-3.8-flash': {
          'direct:workbuddy': cell(4, 3),
        },
      },
    },
    total: { cost: 12, calls: 10, input: 2000, output: 1000, cacheHit: 1800, cacheMiss: 200 },
  };
}

describe('usage billing integration', () => {
  it('detects the billing plugin from the Loader tree', async () => {
    const ctx = {
      get: (name) =>
        name === 'loader'
          ? {
              entries: () => [
                {
                  options: { name: 'cordis:group', group: true },
                  children: [{ options: { name: '@kenz1117/dsh-ui-usage-billing' }, disabled: false }],
                },
              ],
            }
          : undefined,
    };
    assert.equal(await hasUsageBillingPlugin(ctx), true);
    assert.equal(await hasUsageBillingPlugin({ get: () => undefined }), false);
  });

  it('detects the billing plugin from the plugin inventory', async () => {
    const ctx = {
      get: (name) =>
        name === 'pluginInventory'
          ? { list: async () => ({ entries: [{ moduleName: '@kenz1117/dsh-ui-usage-billing', enabled: true, fiberPhase: 'active' }] }) }
          : undefined,
    };
    assert.equal(await hasUsageBillingPlugin(ctx), true);
  });

  it('resolves the host origin for the loopback API', () => {
    assert.equal(resolveWebOrigin({ getOrigin: () => 'http://127.0.0.1:3000/' }), 'http://127.0.0.1:3000');
    assert.equal(resolveWebOrigin({ port: 5555 }), 'http://127.0.0.1:5555');
    assert.equal(resolveWebOrigin({}), '');
  });

  it('fetches usage stats from /api/billing/usage-stats', async () => {
    let requested = '';
    const stats = await fetchUsageStats({
      ctx: { get: (name) => (name === 'webServer' ? { getOrigin: () => 'http://127.0.0.1:4321' } : undefined) },
      fetchImpl: async (url) => {
        requested = String(url);
        return {
          ok: true,
          status: 200,
          json: async () => ({ total: { cost: 1, calls: 2, input: 3, output: 4 }, byDay: {} }),
        };
      },
    });
    assert.equal(requested, 'http://127.0.0.1:4321/api/billing/usage-stats');
    assert.equal(stats.total.calls, 2);
  });

  it('reports HTTP failures', async () => {
    await assert.rejects(
      fetchUsageStats({
        ctx: { get: () => ({ getOrigin: () => 'http://127.0.0.1:1' }) },
        fetchImpl: async () => ({ ok: false, status: 503 }),
      }),
      /HTTP 503/
    );
  });

  it('maps model keys to pricing catalog display names', async () => {
    let requested = '';
    const names = await fetchUsagePricing({
      ctx: { get: () => ({ getOrigin: () => 'http://127.0.0.1:4321' }) },
      fetchImpl: async (url) => {
        requested = String(url);
        return {
          ok: true,
          status: 200,
          json: async () => ({
            catalog: [
              { key: 'flash', name: 'DeepSeek V4.1 Flash' },
              { key: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash' },
            ],
          }),
        };
      },
    });
    assert.equal(requested, 'http://127.0.0.1:4321/api/billing/pricing');
    assert.equal(names.get('flash'), 'DeepSeek V4.1 Flash');

    const now = Date.now();
    const markdown = buildUsageMarkdown(sampleStats(now), { modelNames: names, range: 'month', now });
    assert.ok(markdown.includes('DeepSeek V4.1 Flash'));

    const typst = buildUsageTypst(sampleStats(now), { modelNames: names, range: 'month', now });
    assert.ok(typst.includes('DeepSeek V4.1 Flash'));
  });

  it('maps relay origins to registered names and masks unknown hosts', async () => {
    const names = await fetchRelayDirectory({
      ctx: { get: () => ({ getOrigin: () => 'http://127.0.0.1:4321' }) },
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          quotas: [
            { origin: 'https://cli-proxy-api-latest-88hq.onrender.com', displayName: 'CLI Proxy API' },
          ],
        }),
      }),
    });
    const now = Date.now();
    const stats = {
      byDay: { [dayKey(new Date(now))]: { cost: 1, calls: 1, input: 1, output: 1 } },
      byDayModelsSite: {
        [dayKey(new Date(now))]: {
          flash: {
            'site:https://cli-proxy-api-latest-88hq.onrender.com': { cost: 1, calls: 1 },
            'site:https://unknown.example.org': { cost: 0, calls: 1 },
          },
        },
      },
    };
    const markdown = buildUsageMarkdown(stats, { range: 'month', now, siteNames: names });
    assert.ok(markdown.includes('CLI Proxy API'));
    assert.ok(!markdown.includes('cli-proxy-api-latest'));
    assert.ok(markdown.includes('***.example.org'));
  });

  it('parses day/month/year/all ranges and aggregates per-day stats', () => {
    assert.equal(parseUsageRange('日'), 'day');
    assert.equal(parseUsageRange('today'), 'day');
    assert.equal(parseUsageRange('月'), 'month');
    assert.equal(parseUsageRange('年'), 'year');
    assert.equal(parseUsageRange('全部'), 'all');
    assert.equal(parseUsageRange(''), 'month');

    const now = Date.now();
    const stats = sampleStats(now);
    const day = aggregateUsageRange(stats, 'day', now);
    assert.equal(day.total.cost, 10);
    assert.equal(day.models.length, 2);
    assert.equal(day.activeDays, 1);
    assert.equal(day.peak.day, dayKey(new Date(now)));

    const month = aggregateUsageRange(stats, 'month', now);
    assert.equal(month.total.cost, 12);
    assert.equal(month.activeDays, 2);

    const year = aggregateUsageRange(stats, 'year', now);
    assert.equal(year.total.cost, 12);
  });

  it('builds a 30-day heatmap series with zero-filled days', () => {
    const now = Date.now();
    const days = heatmapDays(sampleStats(now), now, 30);
    assert.equal(days.length, 30);
    assert.equal(days[29].key, dayKey(new Date(now)));
    assert.equal(days[29].cost, 10);
    assert.equal(days[0].cost, 0);
  });

  it('builds the range markdown summary', () => {
    const now = Date.now();
    const markdown = buildUsageMarkdown(sampleStats(now), { range: 'month', now });
    assert.ok(markdown.includes('费用概览 · 本月'));
    assert.ok(markdown.includes('**本月费用**'));
    assert.ok(markdown.includes('缓存命中率'));
    assert.ok(markdown.includes('**本月预算** ¥100.00'));
    assert.ok(markdown.includes('最近 30 天'));
  });

  it('handles empty usage documents', () => {
    const markdown = buildUsageMarkdown({}, { range: 'month' });
    assert.ok(markdown.includes('暂无模型用量数据'));
    assert.ok(markdown.includes('费用概览'));
  });

  it('builds a dedicated Typst card with stats, heatmap and theme colors', () => {
    const now = Date.now();
    const body = buildUsageTypst(sampleStats(now), { theme: 'dark', now, range: 'day' });
    assert.ok(body.includes('今日费用'));
    assert.ok(body.includes('缓存命中率'));
    assert.ok(body.includes('用量热力图'));
    assert.ok(body.includes('最近 30 天'));
    assert.ok(body.includes('模型用量'));
    assert.ok(body.includes('站点分布'));
    assert.ok(body.includes('本月预算'));
    assert.ok(body.includes('#1c222b'));
    assert.ok(body.includes('\\@kenz1117'));
  });
});
