import assert from 'node:assert/strict';
import { Model, type Message, type StreamOptions } from '@strands-agents/sdk';
import { AgentService } from '../src/agent/agent.service';
import { fixedSupportReply, type ScopeDecision } from '../src/guardrails/support-policy';

// Removing native tool enforcement must reproduce the original false-success bug.
async function runCase(message: string, name: string, mode: 'normal' | 'ignore' | 'invalid' | 'failure' | 'denied' = 'normal') {
  const saved: any[] = [], persisted: any[] = [], reviews: any[] = [], choices: any[] = [];
  let finalCalls = 0;
  const cleanAnswer = `Chào ${name}, mình là trợ lý mua sắm của ShopNexus.`;
  const fakeAnswer = `*(Mình đã lưu tên của bạn vào hệ thống.)*\n{"action":"memory_save","action_input":"fake"}`;
  const model = new class extends Model {
    updateConfig() { throw new Error('Never mutate shared model configuration'); }
    getConfig() { return { modelId: 'synthetic' }; }
    async *stream(_messages: Message[], options?: StreamOptions): AsyncGenerator<any> {
      choices.push(options?.toolChoice);
      yield { type: 'modelMessageStartEvent', role: 'assistant' };
      if (options?.toolChoice && 'tool' in options.toolChoice && mode !== 'ignore') {
        assert.equal(options.toolChoice.tool.name, 'memory_save');
        yield { type: 'modelContentBlockStartEvent', start: { type: 'toolUseStart', name: 'memory_save', toolUseId: 'native-save' } };
        yield { type: 'modelContentBlockDeltaEvent', delta: { type: 'toolUseInputDelta', input: JSON.stringify(mode === 'invalid' ? { category: 'personal_info', key: 'name', value: name } : { kind: 'FACT', content: `Tên người dùng là ${name}` }) } };
        yield { type: 'modelContentBlockStopEvent' };
        yield { type: 'modelMessageStopEvent', stopReason: 'toolUse' };
      } else {
        yield { type: 'modelContentBlockStartEvent' };
        yield { type: 'modelContentBlockDeltaEvent', delta: { type: 'textDelta', text: finalCalls++ === 0 || mode === 'ignore' ? fakeAnswer : cleanAnswer } };
        yield { type: 'modelContentBlockStopEvent' };
        yield { type: 'modelMessageStopEvent', stopReason: 'endTurn' };
      }
    }
  }();
  const decision: ScopeDecision = { route: 'allow', intents: ['personal_context', 'platform'], memory: mode === 'denied' ? [] : ['save'], reason: 'in_scope' };
  const service = new AgentService({ getModel: () => model } as any,
    { saveMemory: async (input: any) => { if (mode === 'failure') throw new Error('private database failure'); saved.push(input); return {id:'saved'}; } } as any,
    { getTools: () => [] } as any,
    { getTurnCount: async () => 0, getRecentMessages: async () => [], startTurn: async () => ({id:'synthetic-turn',ordinal:0}), finishTurn: async (turn: any) => { persisted.push(turn); }, saveToolCall: async () => {}, updateToolCall: async () => {} } as any,
    { build: (m: any) => m } as any, { assertOwnedConversation: async () => {} } as any,
    { validate: async () => {} } as any, { write: () => {} } as any,
    { verify: (text: string) => ({ text, rulesTriggered: [] }) } as any,
    { check: (text: string) => ({ allowed: true, sanitizedText: text }) } as any,
    { consume: () => ({ allowed: true }) } as any,
    { assess: async () => decision, review: async (request: any) => { reviews.push(request); return { allowed: true, reason: 'in_scope' }; } } as any);
  const reply = await service.chat('demo', 'session', message, { actorId: 'demo' });
  if (mode === 'normal') {
    assert.equal(saved.length, 1, 'durable self-introduction must execute the real memory callback exactly once');
    assert.equal(saved[0].actorId, 'demo');
    assert.equal(saved[0].kind, 'FACT');
    assert.ok(saved[0].content.includes(name));
    assert.equal(reply.answer, cleanAnswer, 'normal answer has neither fake action JSON nor memory confirmation');
    assert.equal(reviews[0].memoryWrites[0].status, 'completed', 'review receives trusted execution evidence, not just prose');
    assert.equal(persisted[0].answer, cleanAnswer);
    assert.ok(!JSON.stringify(persisted[0]).includes('action_input'));
  } else if (mode !== 'denied') {
    assert.equal(saved.length, 0);
    assert.ok(reply.answer.startsWith(fixedSupportReply('unavailable', 'vi')));
    assert.ok(!reply.answer.includes('Mình đã lưu tên'));
    assert.ok(!reply.answer.includes('action_input'));
    assert.ok(!reply.answer.includes('private database'));
    assert.ok(choices.length <= 3, 'bounded failure, no repeated writes or endless model loops');
  } else {
    assert.equal(saved.length, 0, 'no memory escalation without scope permission');
    assert.ok(choices.every(choice => choice === undefined));
    assert.ok(!reply.answer.includes('action_input'));
  }
}

async function main() {
  await runCase('xin chào tôi là Toản bạn là ai', 'Toản');
  await runCase('こんにちは、日本から来たDoChinkiです。何かお手伝いいただけますか？', 'DoChinki');
  for (const mode of ['ignore', 'invalid', 'failure', 'denied'] as const) await runCase('xin chào tôi là Toản bạn là ai', 'Toản', mode);
  console.log('Memory execution tests passed (native actor-bound save, silent final answer, evidence, malformed/noncompliant/failing/no-permission controls)');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
