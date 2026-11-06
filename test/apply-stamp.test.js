import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

/**
 * The activation stamp.
 *
 * A reload replaces the running plugin without restarting the process, so
 * `ctx.logger` output cannot answer "is the code on disk the code that is
 * running?". `apply()` therefore writes `applied.json`; its timestamp is the
 * evidence used when verifying a reload.
 *
 * The behaviour is pinned by reading the source: `apply()` needs a full Host
 * context to execute, and what matters here is that the stamp is written on
 * every activation, from the plugin's own data dir, and never fatally.
 */

const INDEX = fs.readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8');

describe('activation stamp', () => {
  it('writes applied.json from the plugin data directory', () => {
    assert.match(INDEX, /writeFileSync\(\s*join\(subscriptionDataDir\(\), 'applied\.json'\)/);
  });

  it('records when, which process and which version', () => {
    const write = /writeFileSync\(([\s\S]*?),\s*'utf8'\s*\)/.exec(INDEX);
    assert.ok(write, 'the stamp write exists');
    assert.match(write[1], /at: new Date\(\)\.toISOString\(\)/);
    assert.match(write[1], /pid: process\.pid/);
    assert.match(write[1], /version: readLocalVersion\(\)/);
    assert.match(INDEX, /import \{ createUpdateRoute, readLocalVersion \} from '\.\/qq\/update-route\.js'/);
  });

  it('never lets a read-only data dir stop the adapter', () => {
    const start = INDEX.indexOf('// Stamp every activation');
    const end = INDEX.indexOf('const rawConfig', start);
    assert.ok(start > 0 && end > start, 'the stamp block exists');
    const block = INDEX.slice(start, end);
    assert.match(block, /try \{/);
    assert.match(block, /catch \{/);
    assert.match(block, /must never stop the adapter/);
  });

  it('stamps before the gateway starts', () => {
    const stampAt = INDEX.indexOf('applied.json');
    const gatewayAt = INDEX.indexOf('new QQGatewayClient');
    assert.ok(stampAt > 0 && gatewayAt > 0);
    assert.ok(stampAt < gatewayAt, 'the stamp lands during activation, before any connection');
  });
});
