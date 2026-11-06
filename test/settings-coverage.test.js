import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLIENT = fs.readFileSync(join(REPO_ROOT, 'lib', 'client.js'), 'utf8');
const CONFIG = fs.readFileSync(join(REPO_ROOT, 'lib', 'config.js'), 'utf8');

/**
 * The settings tab is a hand-written field list (`updateField("key")` calls), not
 * a schema-driven form. A new config key is therefore invisible to users until a
 * row is added — which is exactly what happened to busyDelivery,
 * notifyTurnAbnormal and notifyRestartRecovery. This test makes that omission a
 * failing test instead of a silent gap.
 */

/** Keys that are internal or written by other code paths, never edited by hand. */
const INTERNAL = new Set(['token', 'activeSessionId', 'allowFrom']);

const schemaKeys = [...CONFIG.matchAll(/^ {2}([A-Za-z][A-Za-z0-9]*): z\b/gm)].map((m) => m[1]);
const renderedKeys = new Set(
  [...CLIENT.matchAll(/updateField\("([A-Za-z][A-Za-z0-9]*)"\s*,/g)].map((m) => m[1]),
);

describe('settings tab covers every editable config key', () => {
  it('finds a plausible field list in both files', () => {
    assert.ok(schemaKeys.length > 10, `schema keys parsed: ${schemaKeys.length}`);
    assert.ok(renderedKeys.size > 10, `rendered keys parsed: ${renderedKeys.size}`);
  });

  it('has a UI row for each key', () => {
    const missing = schemaKeys.filter((key) => !INTERNAL.has(key) && !renderedKeys.has(key));
    assert.deepEqual(missing, [], `config keys without a settings row: ${missing.join(', ')}`);
  });

  it('does not render a row for a key the schema does not declare', () => {
    const known = new Set(schemaKeys);
    const orphans = [...renderedKeys].filter((key) => !known.has(key));
    assert.deepEqual(orphans, [], `settings rows without a config key: ${orphans.join(', ')}`);
  });

  it('exposes the three recently added keys', () => {
    for (const key of ['busyDelivery', 'notifyTurnAbnormal', 'notifyRestartRecovery']) {
      assert.ok(renderedKeys.has(key), `${key} must have a settings row`);
    }
  });
});
