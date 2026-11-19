/** Offline: prior turns from the request as SDK history — pairs, inputs, answers, notes, the window and the budget. */
import assert from 'node:assert/strict';
import { ConversationContextService } from '../src/memory/conversation-context.service';
import type { HistoryTurn } from '../src/run/run-request';

const context = new ConversationContextService();
const turn = (question: string, extra: Partial<HistoryTurn> = {}): HistoryTurn => ({ status: 'SUCCEEDED', question, entries: [], answer: `answer ${question}`, ...extra });

// Oldest first in, oldest first out; the newest turns are kept when the window is short.
assert.deepEqual(context.build([turn('old'), turn('new')], 2), [{ role: 'user', content: [{ text: 'new' }] }, { role: 'assistant', content: [{ text: 'answer new' }] }]);
assert.equal(context.build([turn('new')], 1).length, 0, 'a turn goes whole or not at all');
assert.equal(context.build([turn('x'.repeat(2000))], 40, 1000).length, 0, 'the character budget');

const full = turn('question', { entries: [
  { kind: 'tool', tool_use_id: 'a', name: 'ticket_get', input: { ticket_id: 'T-1' }, status: 'success', content: [{ text: 'evidence' }, { json: { n: 1 } }, { image: 'never' }] },
  { kind: 'tool', tool_use_id: 'b', name: 'order_get', input: {}, status: 'error', content: [] },
  { kind: 'input', text: 'Only last week' },
  { kind: 'tool', tool_use_id: 'dup', name: 'x', status: 'success', content: [] },
  { kind: 'tool', tool_use_id: 'dup', name: 'x', status: 'success', content: [] },
  { kind: 'tool', tool_use_id: 'y'.repeat(100), name: 'account_get', status: 'success', content: [{ text: 'z'.repeat(13_000) }] },
], answer: 'verified' });
const history = context.build([full], 40);
assert.deepEqual(history.map(m => m.role), ['user', 'assistant', 'user', 'user', 'assistant', 'user', 'assistant']);
assert.deepEqual(history[0].content, [{ text: 'question' }]);
assert.deepEqual((history[1].content as any[]).map(b => b.toolUse.toolUseId), ['a', 'b'], 'consecutive calls pair up in one message');
assert.deepEqual((history[2].content as any[])[0].toolResult, { toolUseId: 'a', status: 'success', content: [{ text: 'evidence' }, { text: '{"n":1}' }] });
assert.deepEqual((history[2].content as any[])[1].toolResult, { toolUseId: 'b', status: 'error', content: [{ text: '[Output omitted]' }] });
assert.deepEqual(history[3].content, [{ text: 'Only last week' }], 'an input is user text, where it happened');
const long = (history[4].content as any[])[0].toolUse.toolUseId;
assert.ok(long.startsWith('tc_') && long.length <= 64, 'a long id is hashed as on the tool call rows');
assert.match((history[5].content as any[])[0].toolResult.content[0].text, /Truncated restored tool output/);
assert.deepEqual(history[6].content, [{ text: 'verified' }]);
assert.ok(!JSON.stringify(history).match(/"dup"|never/), 'a duplicated id and non-text content are left out');

const failed = context.build([turn('q', { status: 'TIMED_OUT', answer: null })], 40);
assert.deepEqual(failed.map(m => m.role), ['user', 'assistant']);
assert.match(JSON.stringify(failed), /Previous run TIMED_OUT/);
console.log('History tests passed (pairs, inputs, answers, failed-run notes, hashed ids, window, budget)');
