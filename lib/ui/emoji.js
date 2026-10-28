/**
 * Session emoji palette for the QQ action boards.
 * Each fruit emoji identifies one session slot on the current page.
 * All entries are single Unicode code points, so they count as 1 character
 * against QQ's 10-character button label limit.
 */

export const SESSION_EMOJIS = ['🍎', '🍊', '🍋', '🍇', '🍉', '🍓', '🥝', '🍑', '🍍', '🥭', '🍒', '🫐'];

const PALETTE_SIZE = SESSION_EMOJIS.length;

/**
 * Map a 0-based slot index to an emoji; out-of-range indexes wrap around.
 * @param {number} slotIndex
 * @returns {string}
 */
export function emojiForSlot(slotIndex) {
  const n = Number(slotIndex);
  if (!Number.isFinite(n)) return SESSION_EMOJIS[0];
  const normalized = ((Math.trunc(n) % PALETTE_SIZE) + PALETTE_SIZE) % PALETTE_SIZE;
  return SESSION_EMOJIS[normalized];
}

/**
 * Return the emoji for every slot on a page (length = count).
 * Consecutive slots never repeat while count <= palette size.
 * @param {number} count
 * @returns {string[]}
 */
export function assignSessionEmojis(count) {
  const total = Math.max(0, Math.trunc(Number(count) || 0));
  return Array.from({ length: total }, (_, slot) => emojiForSlot(slot));
}

/**
 * Reverse lookup: palette emoji -> 0-based slot, or -1 when not in the palette.
 * @param {string} token
 * @returns {number}
 */
export function emojiSlotOf(token) {
  if (typeof token !== 'string') return -1;
  return SESSION_EMOJIS.indexOf(token);
}
