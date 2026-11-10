import assert from 'node:assert/strict';
import type { MessageData } from '@strands-agents/sdk';
import { allowedToolNames, fixedSupportReply, greetingReply, outputDecisionSchema, scopeDecisionSchema, scopeHistory, ScopeDecision } from '../src/guardrails/support-policy';

const products: ScopeDecision = { route: 'allow', intents: ['products'], memory: [], reason: 'in_scope' };
for (const bad of [
  { ...products, intents: [] }, { ...products, reason: 'unsafe' },
  { ...products, memory: ['forget'] }, { ...products, memory: ['save', 'save'] },
  { route: 'deny', intents: [], memory: ['save'], reason: 'out_of_scope' },
  { ...products, surprise: true }, { ...products, intents: ['smalltalk'], memory: ['search'] },
]) assert.equal(scopeDecisionSchema.safeParse(bad).success, false);
assert.equal(outputDecisionSchema.safeParse({ allowed: true, reason: 'unsafe' }).success, false);
assert.equal(outputDecisionSchema.safeParse({ allowed: false, reason: 'in_scope' }).success, false);
assert.equal(greetingReply('xin chào, viết Go Hello World', 'vi'), undefined);
assert.equal(greetingReply('Hello, write Go code', 'en'), undefined);
assert.equal(greetingReply('Xin chào!'.normalize('NFD'), 'vi'), 'Chào bạn! Mình có thể giúp tìm sản phẩm hoặc hỗ trợ vấn đề nào trên ShopNexus?');
assert.equal(fixedSupportReply('refusal', 'en'), 'I can help with shopping and support on ShopNexus, but not this request. Would you like help finding a product or checking an order?');
assert.deepEqual([...allowedToolNames(products, true)].sort(), ['get_product', 'read_output', 'search_products']);
assert.deepEqual([...allowedToolNames({ ...products, intents: ['orders'] }, true)].sort(), ['get_order', 'read_output']);
const correction: ScopeDecision = { ...products, intents: ['personal_context'], memory: ['search', 'supersede'] };
assert.equal(scopeDecisionSchema.safeParse(correction).success, true);
assert.deepEqual([...allowedToolNames(correction, true)].sort(), ['memory_search', 'memory_supersede', 'read_output']);
assert.deepEqual([...allowedToolNames(correction, false)], []);
assert.deepEqual([...allowedToolNames({ route: 'deny', intents: [], memory: [], reason: 'out_of_scope' }, true)], []);
assert.deepEqual([...allowedToolNames({ ...products, intents: ['smalltalk'] }, true)], []);
const messages: MessageData[] = Array.from({ length: 9 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: [{ text: `${i}:` + 'x'.repeat(600) }, { toolResult: { toolUseId: 'private', status: 'success', content: [{ text: 'SECRET_TOOL_PAYLOAD' }] } }] }));
const history = scopeHistory(messages);
assert.equal(history.length, 6);
assert.equal(history[0].content.startsWith('3:'), true);
assert.equal(history[5].content.length, 500);
assert.equal(JSON.stringify(history).includes('SECRET_TOOL_PAYLOAD'), false);
for (const route of ['allow', 'mixed', 'clarify', 'deny'] as const) {
  for (const reason of ['in_scope', 'mixed_request', 'out_of_scope', 'ambiguous', 'unsafe', 'unavailable'] as const) {
    const accepted = route === 'allow' || route === 'mixed';
    const expected = route === 'allow' ? reason === 'in_scope' : route === 'mixed' ? reason === 'mixed_request'
      : route === 'clarify' ? reason === 'ambiguous' : ['out_of_scope', 'unsafe', 'unavailable'].includes(reason);
    assert.equal(scopeDecisionSchema.safeParse({ route, intents: accepted ? ['products'] : [], memory: [], reason }).success, expected, `${route}/${reason}`);
  }
}
assert.deepEqual([...allowedToolNames({ route: 'clarify', intents: [], memory: [], reason: 'ambiguous' }, true)], []);
assert.equal(fixedSupportReply('refusal', 'vi'), 'Mình hỗ trợ mua sắm và các vấn đề trên ShopNexus nên không thể hỗ trợ yêu cầu này. Bạn cần tìm sản phẩm hoặc hỗ trợ đơn hàng nào không?');
console.log('Support policy tests passed');
