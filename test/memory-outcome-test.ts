import assert from 'node:assert/strict';
import { AgentService } from '../src/agent/agent.service';
import { syntheticModel } from './tool-scope-test';
import { fixedSupportReply, ScopeDecision } from '../src/guardrails/support-policy';

async function main() {
  for (const operation of ['save', 'supersede'] as const) {
    for (const failure of ['rejected', 'unavailable', 'generation', 'verifier', 'write-error', 'approved'] as const) {
      let writes = 0;
      const persisted: any[] = [];
      const name = `memory_${operation}`;
      const input = operation === 'save'
        ? { kind: 'PREFERENCE', content: 'SYNTHETIC_PRIVATE_BLUE', importance: 3 }
        : { previousMemoryId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', content: 'SYNTHETIC_PRIVATE_BLUE' };
      const model = syntheticModel(name, input);
      if (failure === 'generation') {
        const stream = model.stream.bind(model);
        let cycles = 0;
        model.stream = async function* (...args: Parameters<typeof model.stream>) {
          if (cycles++ > 0) throw new Error('synthetic generation failure');
          yield* stream(...args);
        };
      }
      const decision: ScopeDecision = { route: 'allow', intents: ['personal_context'], memory: [operation], reason: 'in_scope' };
      const performWrite = async () => { writes++; if (failure === 'write-error') throw new Error('synthetic unknown commit status'); return { id: 'synthetic-new' }; };
      const service = new AgentService({ getModel: () => model } as any,
        { saveMemory: performWrite, supersedeMemory: performWrite } as any,
        { getTools: () => [] } as any,
        { getTurnCount: async () => 0, getRecentMessages: async () => [], saveToolCall: async () => {}, startTurn: async () => ({id:'synthetic-turn',ordinal:0}), finishTurn: async (turn: any) => { persisted.push(turn); } } as any,
        { build: (messages: any) => messages } as any, { assertOwnedConversation: async () => {} } as any,
        { validate: async () => {} } as any, { write: () => {} } as any,
        { verify: (text: string) => { if (failure === 'verifier') throw new Error('synthetic verifier failure'); return { text, rulesTriggered: [] }; } } as any,
        { check: (text: string) => ({ allowed: true, sanitizedText: text }) } as any,
        { consume: () => ({ allowed: true }) } as any,
        { assess: async () => decision, review: async () => failure === 'approved' ? { allowed: true, reason: 'in_scope' } : { allowed: false, reason: failure === 'unavailable' ? 'unavailable' : 'out_of_scope' } } as any);
      const reply = await service.chat('synthetic-actor', 'synthetic-session', 'Remember my color preference', { actorId: 'synthetic-actor', locale: 'en' });
      assert.equal(writes, 1, 'exercise the real memory tool callback before final output review');
      if (failure === 'approved') assert.equal(reply.answer, 'synthetic final answer');
      else {
        assert.ok(reply.answer.includes(failure === 'write-error' ? 'A memory write may still be processing or may already have completed' : operation === 'save' ? 'Personal information was saved' : 'Personal information was corrected'), `${operation}/${failure}: ${reply.answer}`);
        assert.ok(!reply.answer.includes('SYNTHETIC_PRIVATE_BLUE'));
        assert.ok(!reply.answer.includes('synthetic final answer'));
        assert.equal(persisted[0].answer, reply.answer);
      }
    }
  }

  // A non-cooperative callback may complete after timeout; never assert rollback or definite failure.
  const originalTimeout = globalThis.setTimeout;
  globalThis.setTimeout = ((callback: (...args: any[]) => void, ms?: number, ...args: any[]) => originalTimeout(callback, ms !== undefined && ms > 1000 ? 50 : ms, ...args)) as typeof setTimeout;
  let complete!: () => void;
  let callbackStarted = false;
  let committed = false;
  const turns: any[] = [];
  const service = new AgentService({ getModel: () => syntheticModel('memory_save', { kind: 'PREFERENCE', content: 'synthetic blue' }) } as any,
    { saveMemory: async () => { callbackStarted = true; await new Promise<void>(resolve => { complete = resolve; }); committed = true; return { id: 'synthetic-new' }; } } as any,
    { getTools: () => [] } as any,
    { getTurnCount: async () => 0, getRecentMessages: async () => [], saveToolCall: async () => {}, startTurn: async () => ({id:'synthetic-turn',ordinal:0}), finishTurn: async (turn: any) => { turns.push(turn); } } as any,
    { build: (m: any) => m } as any, { assertOwnedConversation: async () => {} } as any,
    {} as any, { write: () => {} } as any, {} as any,
    { check: (text: string) => ({ allowed: true, sanitizedText: text }) } as any,
    { consume: () => ({ allowed: true }) } as any,
    { assess: async () => ({ route: 'allow', intents: ['personal_context'], memory: ['save'], reason: 'in_scope' }) } as any);
  try {
    const reply = await service.chat('synthetic-actor', 'synthetic-session', 'Remember blue', { actorId: 'synthetic-actor', locale: 'en' });
    assert.equal(callbackStarted, true);
    assert.equal(committed, false);
    assert.ok(reply.answer.startsWith(fixedSupportReply('unavailable', 'en')));
    assert.ok(reply.answer.includes('A memory write may still be processing or may already have completed'));
    complete();
    await new Promise(resolve => originalTimeout(resolve, 20));
    assert.equal(committed, true);
    assert.equal(turns.length, 1, 'late completion cannot replace the already persisted response');
  } finally { complete?.(); globalThis.setTimeout = originalTimeout; }
  console.log('Memory outcome tests passed (real SDK callbacks, rejected/failed/approved turns and late timeout completion)');
}
main().catch(e => { console.error(e); process.exitCode = 1; });
