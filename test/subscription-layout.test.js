import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/** Repository root, resolved from this test file so the suite runs on any host. */
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Layout contract for the subscription pane.
 *
 * The pane lives in the central `main` slot, whose height comes from the window.
 * A fixed height there clips content that the user then cannot reach at all —
 * this happened once (height:100% + overflow:hidden on the host, hard 190px on
 * the candidate list), so the rules are pinned here.
 *
 * Headless browsers are unavailable in this environment (Edge/Chrome abort with
 * mojo platform_channel 0x5), so these assertions read the shipped stylesheet
 * and the real component source instead of measuring pixels.
 */

const SOURCE = fs.readFileSync(join(REPO_ROOT, 'lib', 'client.js'), 'utf8');
const CSS = SOURCE.match(/const subscriptionCss = `([\s\S]*?)`;/)[1];

function ruleOf(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = CSS.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`, 'm'));
  return match ? match[1] : '';
}

describe('subscription pane layout adapts to the viewport', () => {
  it('has no fixed pixel or vh height in the pane rules', () => {
    for (const selector of ['.dsh-sub-root', '.dsh-sub-list', '.dsh-sub-add', '.dsh-sub-add-list']) {
      const body = ruleOf(selector);
      assert.ok(body, `${selector} must exist`);
      assert.ok(!/\bheight:\s*\d+(px|vh)/.test(body), `${selector} must not pin a fixed height: ${body}`);
    }
  });

  it('fills the host pane while allowing its own scrolling', () => {
    const root = ruleOf('.dsh-sub-root');
    assert.match(root, /flex:\s*1 1 auto/, 'root should grow with the pane');
    assert.match(root, /max-height:\s*100%/, 'root must not exceed its parent');
    assert.match(root, /overflow-y:\s*auto/, 'root needs a scroll container on short screens');
  });

  it('lets the subscription list take the leftover height', () => {
    const list = ruleOf('.dsh-sub-list');
    assert.match(list, /flex:\s*1 1 auto/);
    assert.match(list, /overflow-y:\s*auto/);
    assert.match(list, /min-height:\s*0/, 'min-height:0 is required for flex children to shrink');
  });

  it('scales the candidate list with the viewport instead of a hard cap', () => {
    const cand = ruleOf('.dsh-sub-add-list');
    const clamp = cand.match(/max-height:\s*clamp\(\s*(\d+)px\s*,\s*(\d+)vh\s*,\s*(\d+)px\s*\)/);
    assert.ok(clamp, `expected a viewport-relative clamp, got: ${cand}`);
    const [, minPx, vh, maxPx] = clamp.map(Number);

    assert.ok(minPx <= 160, 'the lower bound must stay small enough for short windows');
    assert.ok(maxPx > 190, 'the upper bound must beat the old hard-coded 190px');

    // A 32vh cap must never eat a short screen, and must grow on a tall one.
    const atShort = Math.max(minPx, Math.min(maxPx, (vh / 100) * 480));
    const atTall = Math.max(minPx, Math.min(maxPx, (vh / 100) * 1232));
    assert.ok(atShort <= 340, `too tall for a 480px viewport: ${atShort}`);
    assert.ok(atTall > 190, `no growth on a tall viewport: ${atTall}`);
  });

  it('hosts the pane in a flexible, scrollable container', () => {
    const start = SOURCE.indexOf('function SubscriptionMainPanel');
    assert.ok(start > 0, 'SubscriptionMainPanel must exist');
    const body = SOURCE.slice(start, start + 900);

    assert.match(body, /flex:\s*"1 1 auto"/);
    assert.ok(!/height:\s*"100%"/.test(body), 'a fixed height:100% clips when the pane has no definite height');
    assert.match(body, /overflowY:\s*"auto"/, 'clipped content must remain reachable');
    assert.ok(!/overflow:\s*"hidden"/.test(body), 'overflow:hidden made clipped content unreachable');
  });

  it('keeps every moved value inside the panel box (padding + border-box)', () => {
    const start = SOURCE.indexOf('function SubscriptionMainPanel');
    const body = SOURCE.slice(start, start + 900);
    assert.match(body, /boxSizing:\s*"border-box"/, 'padding must not add to the measured height');
  });
});
