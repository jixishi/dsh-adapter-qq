import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildUsageMarkdown,
  buildUsageTypst,
  fetchUsagePricing,
  fetchUsageStats,
  hasUsageBillingPlugin,
  resolveWebOrigin,
} from '../lib/sync/usage.js';

function dayKey(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
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
          json: async () => ({ total: { cost: 1, calls: 2, input: 3, output: 4 } }),
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

    const markdown = buildUsageMarkdown(
      { byModel: { flash: { cost: 1, calls: 2, input: 10, output: 5 } }, total: { cost: 1 } },
      { modelNames: names }
    );
    assert.ok(markdown.includes('DeepSeek V4.1 Flash'));

    const typst = buildUsageTypst(
      { byModel: { flash: { cost: 1, calls: 2, input: 10, output: 5 } }, total: { cost: 1 } },
      { modelNames: names }
    );
    assert.ok(typst.includes('DeepSeek V4.1 Flash'));
  });

  it('builds today/month/total and top-model tables', () => {
    const today = dayKey();
    const markdown = buildUsageMarkdown(
      {
        pluginVersion: '1.8.0',
        budget: 100,
        total: { cost: 12.34, calls: 20, input: 12345, output: 6789 },
        byDay: {
          [today]: { cost: 1.23, calls: 4, input: 1000, output: 500 },
        },
        byModel: {
          'deepseek-v4': { cost: 9.5, calls: 12, input: 9000, output: 4000 },
        },
        bySite: {
          'direct:deepseek': { cost: 9.5, calls: 12 },
        },
      },
      new Date(`${today}T12:00:00`).getTime()
    );
    assert.ok(markdown.includes('**本月预算** ¥100.00'));
    assert.ok(markdown.includes('今日'));
    assert.ok(markdown.includes('deepseek-v4'));
    assert.ok(markdown.includes('DeepSeek'));
    assert.ok(markdown.includes('█'));
    assert.ok(markdown.includes('@kenz1117/dsh-ui-usage-billing v1.8.0'));
  });

  it('handles empty usage documents', () => {
    const markdown = buildUsageMarkdown({}, Date.now());
    assert.ok(markdown.includes('暂无模型用量数据'));
    assert.ok(markdown.includes('累计'));
  });

  it('builds a dedicated Typst card layout with budget and theme colors', () => {
    const body = buildUsageTypst(
      {
        budget: 100,
        total: { cost: 12, calls: 20, input: 1000, output: 500 },
        byModel: { 'deepseek-v4': { cost: 10, calls: 12, input: 900, output: 400 } },
        bySite: { 'direct:deepseek': { cost: 10, calls: 12 } },
        pluginVersion: '1.8.0',
      },
      { theme: 'dark', now: Date.now() }
    );
    assert.ok(body.includes('今日费用'));
    assert.ok(body.includes('模型用量'));
    assert.ok(body.includes('站点分布'));
    assert.ok(body.includes('本月预算'));
    assert.ok(body.includes('#1c222b'));
    assert.ok(body.includes('DeepSeek'));
    assert.ok(body.includes('\\@kenz1117')); // escaped for Typst references
  });
});
