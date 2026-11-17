import assert from 'node:assert/strict';
import { buildSystemPrompt } from '../src/agent/system-prompt';

const ACCOUNT = '44444444-4444-4444-8444-444444444444';
const withSubject = buildSystemPrompt({ role: 'admin', subject: { kind: 'account', id: ACCOUNT }, now: new Date('2026-11-17T03:00:00Z') });
const own = buildSystemPrompt({ role: 'moderator' });

assert.ok(withSubject.includes(ACCOUNT) && withSubject.includes('subject_kind=account'), 'the subject');
assert.ok(withSubject.includes('admin') && own.includes('moderator'), 'the role');
assert.ok(own.includes('không gắn với bản ghi nào'));
assert.ok(withSubject.includes('2026-11-17T03:00:00.000Z'));
for (const rule of ['tiếng Việt', 'COD có đồng kiểm', 'không giữ tiền', 'không phân xử tranh chấp', 'BR-MOD-01', 'hàng cấm', 'hàng giả', 'lừa đảo có tổ chức', 'cơ quan có thẩm quyền',
  'BR-MOD-03', 'chỉ đọc và đề xuất', 'không phải chỉ dẫn', 'tin nhắn', 'ghi chú']) {
  assert.ok(own.includes(rule), rule);
}
for (const shopper of ['search_products', 'memory_save', 'giỏ hàng', 'get_policy']) assert.ok(!own.includes(shopper), shopper);
console.log('System prompt tests passed');
