import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  QQ_MESSAGE_SOFT_LIMIT,
  SUBSCRIPTION_SEND_MODES,
  buildSubscriptionDigest,
  normalizeSubscriptionSendMode,
  shouldSendDigestAsImage,
} from '../lib/sync/subscriptions.js';
import { MessageBridge } from '../lib/sync/message-bridge.js';

/**
 * Delivery form for subscription digests.
 *
 * Constraint: QQ truncates/rejects a single markdown message beyond ~4000 chars.
 * So an over-long digest must be delivered as an image — and since the image has
 * no character budget, it carries the full content rather than the compact
 * preview text.
 */

const at = Date.now();
const make = (n, size = 100) =>
  Array.from({ length: n }, (_, i) => ({
    text: `第${i + 1}条：${'详细内容'.repeat(size)}`,
    at: at + i * 1000,
    kind: 'assistant',
  }));

describe('subscription delivery form', () => {
  it('defaults to text and accepts only the documented modes', () => {
    assert.deepEqual([...SUBSCRIPTION_SEND_MODES], ['text', 'auto', 'image']);
    assert.equal(normalizeSubscriptionSendMode(undefined), 'text');
    assert.equal(normalizeSubscriptionSendMode(''), 'text');
    assert.equal(normalizeSubscriptionSendMode('bogus'), 'text');
    assert.equal(normalizeSubscriptionSendMode('IMAGE'), 'image');
  });

  it('sends text while the digest fits in one message', () => {
    const digest = buildSubscriptionDigest({ title: 't', sessionId: 's', messages: make(3) });
    const decision = shouldSendDigestAsImage({ mode: 'text', length: digest.markdown.length });
    assert.equal(decision.useImage, false);
    assert.equal(decision.reason, '');
  });

  it('switches to an image once the digest exceeds the budget', () => {
    const digest = buildSubscriptionDigest({ title: 't', sessionId: 's', messages: make(30) });
    assert.ok(digest.markdown.length > QQ_MESSAGE_SOFT_LIMIT, `len=${digest.markdown.length}`);
    const decision = shouldSendDigestAsImage({ mode: 'text', length: digest.markdown.length });
    assert.equal(decision.useImage, true);
    assert.equal(decision.reason, 'too-long');
  });

  it('honours image (always) and auto (only when long)', () => {
    assert.equal(shouldSendDigestAsImage({ mode: 'image', length: 10 }).reason, 'always');
    assert.equal(shouldSendDigestAsImage({ mode: 'image', length: 99999 }).useImage, true);
    assert.equal(shouldSendDigestAsImage({ mode: 'auto', length: 10 }).useImage, false);
    assert.equal(shouldSendDigestAsImage({ mode: 'auto', length: 99999 }).useImage, true);
  });

  it('treats the budget as a strict upper bound', () => {
    assert.equal(shouldSendDigestAsImage({ mode: 'text', length: QQ_MESSAGE_SOFT_LIMIT }).useImage, false);
    assert.equal(shouldSendDigestAsImage({ mode: 'text', length: QQ_MESSAGE_SOFT_LIMIT + 1 }).useImage, true);
  });
});

describe('digest content is never silently dropped', () => {
  it('represents every buffered message', () => {
    const messages = make(12, 2);
    const digest = buildSubscriptionDigest({ title: 't', sessionId: 's', messages });
    assert.equal(digest.count, 12);
    // There is deliberately no "5 previews" cap: sizing is handled by choosing the
    // delivery form, not by discarding messages.
    assert.ok(!digest.markdown.includes('省略'), 'nothing may be elided');
    for (let i = 1; i <= 12; i += 1) {
      assert.ok(digest.markdown.includes(`第${i}条`), `missing 第${i}条`);
    }
  });

  it('full mode widens each message preview', () => {
    const messages = [{ text: 'X'.repeat(3000), at, kind: 'assistant' }];
    const compact = buildSubscriptionDigest({ title: 't', sessionId: 's', messages });
    const full = buildSubscriptionDigest({ title: 't', sessionId: 's', messages, full: true });
    assert.ok(full.markdown.length > compact.markdown.length, 'full mode must carry more text');
    assert.ok(full.markdown.length > 1500, `full preview too short: ${full.markdown.length}`);
  });
});

describe('image height budget', () => {
  const bridge = Object.create(MessageBridge.prototype);

  it('keeps a small digest intact', () => {
    const digest = buildSubscriptionDigest({ title: 't', sessionId: 's', messages: make(3), full: true });
    const fitted = bridge.fitDigestForImage(digest.markdown, { count: 3, width: 900 });
    assert.equal(fitted.text, digest.markdown);
    assert.equal(fitted.notice, '');
  });

  it('trims a huge digest and says so', () => {
    const digest = buildSubscriptionDigest({ title: 't', sessionId: 's', messages: make(40), full: true });
    const fitted = bridge.fitDigestForImage(digest.markdown, { count: 40, width: 900 });
    assert.ok(fitted.text.length < digest.markdown.length, 'must trim');
    assert.ok(fitted.notice.length > 0, 'must explain the truncation');
    // The notice names the total so the reader knows what they are missing.
    assert.match(fitted.notice, /40/);
    // Never trims everything away.
    assert.ok(fitted.text.length > 400, `kept too little: ${fitted.text.length}`);
  });

  it('is junk-safe', () => {
    const fitted = bridge.fitDigestForImage('', { count: 0, width: 900 });
    assert.equal(fitted.text, '');
    assert.equal(fitted.notice, '');
  });
});
