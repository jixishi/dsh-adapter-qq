import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  SESSION_EMOJIS,
  emojiForSlot,
  assignSessionEmojis,
  emojiSlotOf,
} from '../lib/ui/emoji.js';

describe('session emoji palette', () => {
  it('exposes 12 unique single-code-point emojis', () => {
    assert.equal(SESSION_EMOJIS.length, 12);
    assert.equal(new Set(SESSION_EMOJIS).size, 12);
    for (const emoji of SESSION_EMOJIS) {
      assert.equal(Array.from(emoji).length, 1, `${emoji} must stay one code point (label budget)`);
    }
  });

  it('maps 0-based slots and wraps out-of-range indexes', () => {
    assert.equal(emojiForSlot(0), '🍎');
    assert.equal(emojiForSlot(11), '🫐');
    assert.equal(emojiForSlot(12), '🍎');
    assert.equal(emojiForSlot(25), '🍊');
    assert.equal(emojiForSlot(-1), '🫐');
  });

  it('assigns one distinct emoji per page slot', () => {
    const page = assignSessionEmojis(6);
    assert.equal(page.length, 6);
    assert.deepEqual(page, SESSION_EMOJIS.slice(0, 6));
    assert.equal(new Set(page).size, 6);
  });

  it('handles empty and full-palette pages', () => {
    assert.deepEqual(assignSessionEmojis(0), []);
    assert.deepEqual(assignSessionEmojis(-2), []);
    const full = assignSessionEmojis(12);
    assert.equal(full.length, 12);
    assert.equal(new Set(full).size, 12);
    assert.deepEqual(assignSessionEmojis(12), SESSION_EMOJIS);
  });

  it('reverse-looks up palette emojis only', () => {
    assert.equal(emojiSlotOf('🍎'), 0);
    assert.equal(emojiSlotOf('🍑'), 7);
    assert.equal(emojiSlotOf('🫐'), 11);
    assert.equal(emojiSlotOf('⭐'), -1);
    assert.equal(emojiSlotOf(''), -1);
    assert.equal(emojiSlotOf(undefined), -1);
  });
});
