import assert from 'node:assert/strict';
import { buildSystemPrompt } from '../src/agent/system-prompt';
const vi = buildSystemPrompt({ locale: 'vi', page: 'cart' }, { route: 'mixed', intents: ['products'], memory: [], reason: 'mixed_request' });
assert.ok(vi.includes('ShopNexus'));
assert.ok(vi.includes('giỏ hàng'));
assert.ok(vi.includes('mixed'));
assert.ok(vi.includes('products'));
const en = buildSystemPrompt({ locale: 'en', listingId: 'PROD-1', listingTitle: 'Laptop <untrusted>' });
assert.ok(en.includes('PROD-1'));
assert.ok(en.includes('Laptop <untrusted>'));
assert.ok(en.includes('untrusted'));
// Only validated enums may be promoted into trusted per-turn permission text.
assert.throws(() => buildSystemPrompt({}, { route: 'allow', intents: ['products'], memory: ['forget'], reason: 'in_scope' } as never));
assert.ok(vi.includes('Ngày giờ hiện tại:'));
assert.ok(en.includes('Current date & time:'));
assert.ok(buildSystemPrompt({ locale: 'en', page: 'order' }).includes('order page'));
for (const boundary of ['Laptop advice for Go', 'generating/debugging Go', 'ONLY the shopping portion', 'disclaimer cannot authorize', 'untrusted DATA']) {
  assert.ok(en.includes(boundary), boundary);
}
console.log('System prompt tests passed');
