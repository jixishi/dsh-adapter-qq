import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Config, DEFAULT_CONFIG, SETTINGS_NAMESPACE, unwrapVolatileConfig } from '../lib/config.js';

describe('QQ adapter Config schema', () => {
  it('marks every field volatile so the DSH Settings tab can save it', () => {
    const dict = Config.dict ?? {};
    assert.ok(Object.keys(dict).length > 0);
    for (const [key, field] of Object.entries(dict)) {
      assert.equal(field?.meta?.volatile, true, `field "${key}" must be .volatile()`);
    }
  });

  it('covers exactly the DEFAULT_CONFIG keys', () => {
    assert.deepEqual(Object.keys(Config.dict).sort(), Object.keys(DEFAULT_CONFIG).sort());
    assert.equal(SETTINGS_NAMESPACE, 'adapter-qq');
  });

  it('defaults image captions off and path display to the last folder', () => {
    assert.equal(DEFAULT_CONFIG.sendOverviewCaption, false);
    assert.equal(DEFAULT_CONFIG.sessionPathDisplay, 'tail');
    assert.equal(DEFAULT_CONFIG.autoSendAttachments, true);
    assert.equal(Config({}).sendOverviewCaption.get(), false);
    assert.equal(Config({}).sessionPathDisplay.get(), 'tail');
  });

  it('enables sandbox mode by default, and still allows turning it off', () => {
    // Before the bot is published it can only reach testers, so sandbox must be
    // the out-of-the-box state or the first connection silently fails.
    assert.equal(DEFAULT_CONFIG.sandbox, true);
    assert.equal(Config({}).sandbox.get(), true);
    // An explicit choice — or an existing profile that saved false — still wins.
    assert.equal(Config({ sandbox: false }).sandbox.get(), false);
  });

  it('unwraps live volatile refs into plain values', () => {
    const plain = unwrapVolatileConfig({
      appId: { get: () => '102882069' },
      enabled: true,
      clientSecret: { get: () => 'secret' },
      allowFrom: { get: () => ['*'] },
      missing: null,
    });
    assert.deepEqual(plain, {
      appId: '102882069',
      enabled: true,
      clientSecret: 'secret',
      allowFrom: ['*'],
      missing: null,
    });
    assert.deepEqual(unwrapVolatileConfig(null), {});
  });
});
