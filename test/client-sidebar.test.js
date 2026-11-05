import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

/**
 * Contract test for the client half.
 *
 * The sidebar (left navigation) requires a PAIR of registrations that share one
 * id — `sidebar.panellist` (the row/icon/label) and `main` (the panel body, keyed
 * by that same id). Getting it wrong fails silently: the plugin loads, nothing
 * appears in the UI. That regression is exactly what these assertions pin.
 *
 * The real factory is executed against a fake ModuleLoader so the assertions run
 * on the shipped code, not on a reimplementation.
 */

const CLIENT_PATH = 'W:/dsh-plugins/dsh-adapter-qq/lib/client.js';

function makeElement(type, props, ...children) {
  return { $$element: true, type, props: props || {}, children: children.flat(Infinity) };
}

function loadClient() {
  const source = fs.readFileSync(CLIENT_PATH, 'utf8');

  const registrations = [];
  const injected = [];
  const slots = {
    register(options, component) {
      registrations.push({ options, component });
      return () => {};
    },
    inject(name, cb) {
      injected.push(name);
      return cb();
    },
    entries(name) {
      return registrations.filter((row) => row.options.name === name);
    },
    subscribe() {
      return () => {};
    },
    getVersion() {
      return registrations.length;
    },
  };

  const ctx = {
    slots,
    remote: { settings: {} },
    effect(fn) {
      const disposer = fn();
      return () => {
        if (typeof disposer === 'function') disposer();
      };
    },
    on() {
      return () => {};
    },
    inject(_names, cb) {
      if (typeof cb === 'function') cb({});
    },
  };

  let loaded = null;
  globalThis.window = {
    __ModuleLoader__: {
      load({ id, factory }) {
        loaded = { id, factory };
      },
    },
  };
  globalThis.document = {
    querySelector: () => null,
    createElement: () => ({ dataset: {}, setAttribute() {}, textContent: '', appendChild() {} }),
    head: { appendChild() {} },
  };

  const React = {
    createElement: makeElement,
    useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
    useEffect: () => {},
    useCallback: (fn) => fn,
    useMemo: (fn) => fn(),
    useRef: (value) => ({ current: value }),
    Fragment: 'Fragment',
  };

  const Module = { exports: {} };
  // eslint-disable-next-line no-new-func
  new Function('module', 'exports', 'globalThis', source)(Module, Module.exports, globalThis);
  const instance = loaded.factory((name) => (name === 'react' ? React : {}));
  return { instance, ctx, registrations, injected };
}

describe('client sidebar registration contract', () => {
  it('registers the left sidebar row and its main panel as a matching pair', () => {
    const { instance, ctx, registrations } = loadClient();
    instance.apply(ctx);

    const panellist = registrations.filter((row) => row.options.name === 'sidebar.panellist');
    const main = registrations.filter((row) => row.options.name === 'main');

    assert.equal(panellist.length, 1, 'exactly one sidebar.panellist row');
    assert.equal(main.length, 1, 'exactly one main panel');

    const entry = panellist[0].options;
    const body = main[0].options;

    assert.equal(typeof entry.id, 'string');
    assert.ok(entry.id.length > 0, 'panellist id is required');
    // The pairing rule: main is keyed by the SAME id, otherwise clicking the row
    // selects nothing and the panel never renders.
    assert.equal(body.key, entry.id, 'main.key must equal sidebar.panellist.id');
    assert.equal(entry.label, '订阅管理');
    assert.ok(Number.isFinite(entry.order), 'order keeps the row in a stable position');
  });

  it('still registers the QQ settings tab and no stale right-pane seats', () => {
    const { instance, ctx, registrations } = loadClient();
    instance.apply(ctx);

    const settings = registrations.filter((row) => row.options.name === 'settings.plugins.tab');
    assert.equal(settings.length, 1, 'settings tab must survive the sidebar additions');

    // The right-pane slots were tried and dropped in favour of the left sidebar;
    // a leftover registration would put the pane in a place the user cannot find.
    const stale = registrations.filter((row) => String(row.options.name).startsWith('sidebar.right'));
    assert.equal(stale.length, 0, `unexpected right-pane seats: ${stale.map((r) => r.options.name)}`);
  });

  it('does not hard-require an optional sidebar service', () => {
    const { instance } = loadClient();
    // A missing required service blocks apply() entirely, which would take the
    // settings tab down with it.
    assert.deepEqual(instance.inject, ['slots', 'remote', 'remote.settings']);
    assert.ok(!instance.inject.includes('sidebarRightTabs'));
  });

  it('renders a monochrome SVG icon that matches the built-in sidebar glyphs', () => {
    const { instance, ctx, registrations } = loadClient();
    instance.apply(ctx);
    const entry = registrations.find((row) => row.options.name === 'sidebar.panellist');
    const output = entry.component({});

    // The left column is a set of stroked line icons; an emoji would be the one
    // coloured glyph there and cannot follow the theme.
    assert.equal(output.type, 'svg');
    assert.equal(output.props.viewBox, '0 0 16 16');
    assert.equal(output.props.stroke, 'currentColor');
    assert.equal(output.props.fill, 'none');
    assert.ok(output.children.length > 0, 'the icon needs path data');
    // No emoji anywhere in the rendered tree.
    assert.ok(!/[\u{1F300}-\u{1FAFF}]/u.test(JSON.stringify(output)), 'emoji glyph in the sidebar icon');
  });

  it('honours the host-provided icon size and defaults to 16', () => {
    const { instance, ctx, registrations } = loadClient();
    instance.apply(ctx);
    const entry = registrations.find((row) => row.options.name === 'sidebar.panellist');
    assert.equal(entry.component({}).props.width, 16);
    assert.equal(entry.component({ size: 14 }).props.width, 14);
    assert.equal(entry.component({ size: 20 }).props.height, 20);
    // A junk size must not leak NaN into the SVG attributes.
    assert.equal(entry.component({ size: 'big' }).props.width, 16);
  });

  it('renders the main panel without throwing', () => {
    const { instance, ctx, registrations } = loadClient();
    instance.apply(ctx);
    const body = registrations.find((row) => row.options.name === 'main');
    const output = body.component({});
    assert.equal(output.$$element, true);
  });
});
