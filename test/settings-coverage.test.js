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

describe('settings tab is grouped into titled sections', () => {
  it('declares the expected sections in reading order', () => {
    const titles = [...CLIENT.matchAll(/React\.createElement\(Section, \{\s*\n\s*title: "([^"]+)"/g)].map(
      (m) => m[1],
    );
    assert.deepEqual(titles, ['连接与身份', '会话与工作区', '对话与投递', '图片与渲染', '通知与提醒', '高级']);
  });

  it('does not leave any row outside a section', () => {
    // A row appended before the first Section or after the footer would render
    // without a heading — the flat list this grouping replaced.
    const firstSection = CLIENT.indexOf('React.createElement(Section, {');
    const footer = CLIENT.indexOf('className: "dsh-qq-footer"');
    assert.ok(firstSection > 0 && footer > firstSection, 'anchors found');

    const head = CLIENT.slice(CLIENT.indexOf('const body = React.createElement('), firstSection);
    const tail = CLIENT.slice(CLIENT.lastIndexOf(']),'));
    assert.deepEqual([...head.matchAll(/updateField\("([A-Za-z]+)"/g)].map((m) => m[1]), []);
    assert.deepEqual(
      [...tail.matchAll(/updateField\("([A-Za-z]+)"/g)].map((m) => m[1]),
      [],
      'nothing may be appended after the last section',
    );
  });

  it('keeps the related rows together', () => {
    const sectionOf = (key) => {
      const idx = CLIENT.indexOf(`updateField("${key}"`);
      if (idx < 0) return null;
      const before = CLIENT.slice(0, idx);
      const sections = [...before.matchAll(/title: "([^"]+)",/g)];
      return sections.length ? sections[sections.length - 1][1] : null;
    };
    // Delivery belongs with the conversation options, not with rendering.
    assert.equal(sectionOf('busyDelivery'), '对话与投递');
    // The three notification switches belong together.
    assert.equal(sectionOf('notifyTurnAbnormal'), '通知与提醒');
    assert.equal(sectionOf('notifyRestartRecovery'), '通知与提醒');
    assert.equal(sectionOf('subscriptionSendMode'), '通知与提醒');
    // Rendering knobs share one section.
    assert.equal(sectionOf('renderTheme'), '图片与渲染');
    assert.equal(sectionOf('renderWidth'), '图片与渲染');
  });
});

describe('sections are bordered cards', () => {
  it('draws each section as a card', () => {
    const rule = /\.dsh-qq-section \{([\s\S]*?)\}/.exec(CLIENT);
    assert.ok(rule, '.dsh-qq-section rule exists');
    const body = rule[1];
    assert.match(body, /border: 1px solid/, 'the card has a visible border');
    assert.match(body, /border-radius:\s*\d+px/, 'the card is rounded');
    assert.match(body, /padding:\s*\d+px/, 'content is inset from the border');
  });

  it('does not also draw a divider under the title', () => {
    // The card border already separates sections; a second rule inside the card
    // would double up.
    const rule = /\.dsh-qq-section-head \{([\s\S]*?)\}/.exec(CLIENT);
    assert.ok(rule, '.dsh-qq-section-head rule exists');
    assert.doesNotMatch(rule[1], /border-bottom/);
  });

  it('keeps the section title as the card headline', () => {
    const rule = /\.dsh-qq-section-title \{([\s\S]*?)\}/.exec(CLIENT);
    assert.ok(rule);
    const size = /font-size:\s*(\d+)px/.exec(rule[1]);
    assert.ok(size && Number(size[1]) >= 14, `title should read as a headline, got ${size && size[1]}px`);
    assert.match(rule[1], /font-weight:\s*600/);
  });
});

describe('settings body spacing', () => {
  it('has no side margin, keeping only vertical breathing room', () => {
    const rule = /\.dsh-qq-body \{([\s\S]*?)\}/.exec(CLIENT);
    assert.ok(rule, '.dsh-qq-body rule exists');
    const body = rule[1];

    const margin = /margin:\s*([^;]+);/.exec(body);
    assert.ok(margin, 'the rule declares a margin');
    const value = margin[1].trim();
    // Any of "0", "0px", "0 0" means no horizontal side margin.
    assert.match(value, /^0(px)?( 0(px)?)?$/, `body must not inset sideways, got margin: ${value}`);

    // Vertical spacing is what should remain.
    const padding = /padding:\s*([^;]+);/.exec(body);
    assert.ok(padding, 'the rule declares padding');
    assert.match(padding[1].trim(), /\d+px 0 \d+px/, 'vertical padding kept, horizontal padding stays 0');
  });
});