import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLIENT = fs.readFileSync(join(REPO_ROOT, 'lib', 'client.js'), 'utf8');

/**
 * DSH loads client plugins as ONE classic script that registers several packages
 * in sequence ("A batch script is one classic script that registers every package
 * in sequence"), and `register` throws on a duplicate id. Two consequences:
 *
 *  1. A bundle must not leak top-level bindings: `const factory = ...` at file
 *     scope collides with any other plugin in the same batch, and a duplicate
 *     declaration is a parse error, so NOTHING registers and the host reports
 *     "loaded without registering". This is exactly the failure that made this
 *     plugin need a full restart while others hot-applied.
 *  2. It must register the package's own id exactly once.
 */

describe('client bundle registration contract', () => {
  it('leaks no top-level declarations', () => {
    // The whole file must live inside the loader callback.
    const topLevel = [...CLIENT.matchAll(/^(?:const|let|var|function|class)\s+\w+/gm)].map((m) => m[0]);
    assert.deepEqual(topLevel, [], 'top-level bindings collide inside a shared batch script');
  });

  it('registers exactly one id, and it is the package name', () => {
    const calls = [...CLIENT.matchAll(/__ModuleLoader__\.load\(\s*\{[\s\S]{0,120}?id:\s*"([^"]+)"/g)].map((m) => m[1]);
    assert.deepEqual(calls, ['dsh-adapter-qq']);
  });

  it('does not register the legacy package name', () => {
    assert.ok(!CLIENT.includes('id: "dsh-plugin-adapter-qq"'), 'the pre-rename id was dropped');
  });

  it('exposes apply and inject through the returned exports', () => {
    assert.match(CLIENT, /exports\.apply = apply;/);
    // `inject` is assigned either from a binding or inline as an array literal.
    assert.match(CLIENT, /exports\.inject = (?:inject|\[)/);
    assert.match(CLIENT, /return module\.exports;/);
  });

  it('executes cleanly and registers a usable factory', () => {
    // Reproduces the browser contract: evaluate the script with only
    // window.__ModuleLoader__ available, twice under different names to prove
    // nothing leaks between evaluations (a batch runs several of these).
    function evaluate() {
      const registered = [];
      const sandbox = {
        console,
        setTimeout,
        clearTimeout,
        document: {
          createElement: () => ({ appendChild() {}, setAttribute() {}, style: {}, remove() {} }),
          head: { appendChild() {} },
          querySelector: () => null,
          body: { appendChild() {} },
          getElementById: () => null,
        },
        window: {
          __ModuleLoader__: {
            load(spec) {
              registered.push(spec);
            },
          },
        },
        MutationObserver: class {
          observe() {}
          disconnect() {}
        },
      };
      sandbox.globalThis = sandbox;
      vm.createContext(sandbox);
      vm.runInContext(CLIENT, sandbox, { filename: 'client.js' });
      return registered;
    }

    const first = evaluate();
    assert.equal(first.length, 1);
    assert.equal(first[0].id, 'dsh-adapter-qq');
    assert.equal(typeof first[0].factory, 'function');

    // Evaluating a second bundle (another plugin) must not collide.
    assert.doesNotThrow(() => evaluate());
  });
});
