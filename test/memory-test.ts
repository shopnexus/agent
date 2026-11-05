import assert from 'node:assert/strict';
import { extractUserFacts } from '../src/memory/fact-extractor';
import { ConversationContextService } from '../src/memory/conversation-context.service';
import type { MessageData } from '@strands-agents/sdk';

const named = extractUserFacts('Tôi tên là Toan');
assert.deepEqual(named, [{ category: 'profile', factKey: 'profile.name', content: 'name: Toan', importance: 3 }]);
assert.equal(extractUserFacts('My name is Toan')[0]?.content, 'name: Toan');
assert.equal(extractUserFacts('Tên bạn tôi là Toan').length, 0, 'does not extract facts about another person');
assert.equal(extractUserFacts('Tôi tên là Toan, số điện thoại 0912345678').length, 0, 'rejects PII-bearing messages');
assert.equal(extractUserFacts('Tôi thích giá rẻ').length, 0, 'rejects transient/business-topic candidates');
assert.equal(extractUserFacts('Giả sử tôi tên là Toan').length, 0, 'rejects hypothetical statements');

const context = new ConversationContextService();
const turns = [
  { turnIndex: 0, messages: [{ role: 'user', content: [{ text: 'old' }] }, { role: 'assistant', content: [{ text: 'old answer' }] }] },
  { turnIndex: 1, messages: [
    { role: 'user', content: [{ text: 'Find this item' }, { image: { source: { type: 'bytes', bytes: new Uint8Array([1]) }, format: 'png' } }] },
    { role: 'assistant', content: [{ toolUse: { name: 'search_products', toolUseId: 'tool-1', input: { query: 'item' } } }] },
    { role: 'user', content: [{ toolResult: { toolUseId: 'tool-1', status: 'success', content: [{ text: 'Found item' }] } }] },
    { role: 'assistant', content: [{ reasoning: { text: 'internal reasoning' } }, { text: 'Here is the result' }] },
  ] },
] as unknown as Array<{ turnIndex: number; messages: MessageData[] }>;
const restored = context.build(turns, 4);
assert.equal(restored.length, 4, 'keeps the newest complete turn within the window');
assert.equal(restored[0].role, 'user');
assert.ok(restored[0].content.some((block) => 'text' in block && block.text.includes('Attachment omitted')));
assert.ok(restored[1].content.some((block) => 'toolUse' in block));
assert.ok(restored[2].content.some((block) => 'toolResult' in block));
assert.ok(!restored[3].content.some((block) => 'reasoning' in block));
assert.equal(context.build(turns, 3).length, 0, 'does not split a turn when its tool exchange exceeds the window');

console.log('Memory tests passed');
