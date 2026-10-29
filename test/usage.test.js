import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildUsageMarkdown,
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
    assert.ok(markdown.includes('本月预算 ¥100.00'));
    assert.ok(markdown.includes('今日'));
    assert.ok(markdown.includes('deepseek-v4'));
    assert.ok(markdown.includes('direct:deepseek'));
    assert.ok(markdown.includes('@kenz1117/dsh-ui-usage-billing v1.8.0'));
  });

  it('handles empty usage documents', () => {
    const markdown = buildUsageMarkdown({}, Date.now());
    assert.ok(markdown.includes('暂无模型用量数据'));
    assert.ok(markdown.includes('累计'));
  });
});
