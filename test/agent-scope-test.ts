import assert from 'node:assert/strict';
import { MessageData } from '@strands-agents/sdk';
import { makeAgentScopeHarness } from './helpers/agent-scope-harness';
import { verifiedTranscript } from '../src/agent/verified-transcript';
import { fixedSupportReply, ScopeDecision } from '../src/guardrails/support-policy';
import { FeatureFlags } from '../src/guardrails/feature-flags';
import { invokeWithTimeout } from '../src/agent/agent.service';

async function main() {
  const run = (h: ReturnType<typeof makeAgentScopeHarness>, text = 'Viết Go Hello World') => h.service.chat('actor-a', 'session-a', text, { actorId: 'actor-a' });
  for (const [route, reason, kind] of [['deny', 'out_of_scope', 'refusal'], ['clarify', 'ambiguous', 'clarification'], ['deny', 'unavailable', 'unavailable']] as const) {
    const h = makeAgentScopeHarness({ scope: { route, reason, intents: [], memory: [] } });
    const reply = await run(h);
    assert.equal(h.calls.prepared, 0); assert.equal(h.calls.generated, 0); assert.equal(h.calls.memory, 0);
    assert.equal(reply.answer, fixedSupportReply(kind, 'vi'));
    assert.equal(h.calls.persisted[0]?.answer, reply.answer);
    assert.equal(h.calls.persisted[0]?.status, reason === 'unavailable' ? 'FAILED' : 'SUCCEEDED');
  }
  const hello = makeAgentScopeHarness();
  await run(hello, 'Xin chào!');
  assert.equal(hello.calls.assessed + hello.calls.generated + hello.calls.memory, 0);
  const mixed: ScopeDecision = { route: 'mixed', intents: ['products'], memory: [], reason: 'mixed_request' };
  const h = makeAgentScopeHarness({ scope: mixed });
  assert.equal((await run(h)).answer, 'Verified shopping answer');
  assert.deepEqual(h.calls.scope, mixed); assert.equal(h.calls.history, 1); assert.equal(h.calls.reviewed, 1);
  assert.equal(h.calls.signals[0], h.calls.signals[2], 'assessment/review share parent signal');
  for (const kind of ['rate', 'input', 'turn', 'feature', 'llm'] as const) {
    const blocked = makeAgentScopeHarness();
    if (kind === 'rate') blocked.rateLimiter.consume = () => ({ allowed: false });
    if (kind === 'input') blocked.inputGuard.check = text => ({ allowed: false, sanitizedText: text, hasPiiWarning: undefined });
    if (kind === 'turn') blocked.turns.getTurnCount = async () => 50;
    if (kind === 'feature') FeatureFlags.setAgentEnabled(false);
    if (kind === 'llm') FeatureFlags.setLlmEnabled(false);
    try { await run(blocked); assert.equal(blocked.calls.assessed, 0); assert.equal(blocked.calls.generated, 0); }
    finally { FeatureFlags.setAgentEnabled(true); FeatureFlags.setLlmEnabled(true); }
  }
  const rejected = makeAgentScopeHarness({ draft: 'REJECTED GO CODE', output: { allowed: false, reason: 'out_of_scope' } });
  assert.equal((await run(rejected)).answer, fixedSupportReply('refusal', 'vi'));
  assert.ok(!JSON.stringify(rejected.calls.persisted).includes('REJECTED GO CODE'));
  for (const where of ['provider', 'verifier'] as const) {
    const failed = makeAgentScopeHarness();
    if (where === 'provider') failed.agent.invoke = async () => { throw new Error('PRIVATE_PROVIDER_ERROR'); };
    else failed.verifier.verify = () => { throw new Error('PRIVATE_PROVIDER_ERROR'); };
    assert.equal((await run(failed)).answer, fixedSupportReply('unavailable', 'vi'));
    assert.ok(!JSON.stringify(failed.calls.persisted).includes('PRIVATE_PROVIDER_ERROR'));
    assert.equal(failed.calls.persisted[0]?.status, 'FAILED');
  }
  for (const outcome of ['completed', 'uncertain'] as const) {
    for (const reviewAllowed of [true, false]) {
      const failedAudit = makeAgentScopeHarness({ output: { allowed: reviewAllowed, reason: reviewAllowed ? 'in_scope' : 'out_of_scope' } });
      const prepare = failedAudit.service.prepareAgent.bind(failedAudit.service);
      failedAudit.service.prepareAgent = async (...args) => {
        const prepared = await prepare(...args);
        prepared.toolInfo.memoryWrites = [{ toolUseId:'saved', operation:'save', status:outcome }];
        prepared.toolInfo.toolCalls = { flush: async () => { throw new Error('AUDIT_WRITE_FAILED'); } };
        return prepared;
      };
      const reply = await run(failedAudit);
      assert.match(reply.answer, outcome === 'completed' ? /đã được lưu/ : /có thể vẫn đang/);
      assert.equal(failedAudit.calls.persisted[0]?.answer, reply.answer);
      assert.equal(failedAudit.calls.persisted[0]?.status, 'FAILED');
    }
  }
  const transcript: MessageData[] = [
    { role: 'user', content: [{ text: 'request' }] },
    { role: 'assistant', content: [{ text: 'UNVERIFIED PREAMBLE' }, { toolUse: { toolUseId: 't1', name: 'get_product', input: { id: 'p1' } } }] },
    { role: 'user', content: [{ toolResult: { toolUseId: 't1', status: 'success', content: [{ text: 'product evidence' }] } }] },
    { role: 'assistant', content: [{ text: 'RAW DRAFT' }] },
  ];
  const snapshot = JSON.stringify(transcript);
  const safe = verifiedTranscript('request', 'FINAL', transcript, true);
  assert.equal(safe.length, 4); assert.equal(safe[1].role, 'assistant'); assert.equal(safe[2].role, 'user');
  assert.ok(!JSON.stringify(safe).includes('UNVERIFIED')); assert.ok(!JSON.stringify(safe).includes('RAW DRAFT'));
  assert.equal(JSON.stringify(safe).match(/FINAL/g)?.length, 1);
  assert.equal(JSON.stringify(transcript), snapshot);
  assert.equal(verifiedTranscript('request', 'fallback', transcript, false).length, 2);
  const controller = new AbortController();
  const never = { invoke: async () => new Promise<never>(() => {}) } as any;
  const pending = invokeWithTimeout(never, 'x', 5000, undefined, controller.signal);
  controller.abort();
  await assert.rejects(pending);

  // Accelerated parent deadline: a classifier that ignores abort cannot start generation.
  const realSetTimeout = globalThis.setTimeout;
  const deadlines: number[] = [];
  const late = makeAgentScopeHarness();
  let resolve!: (v: any) => void;
  late.scope.assess = async () => new Promise(r => { resolve = r; });
  globalThis.setTimeout = ((cb: (...args: any[]) => void, ms?: number, ...args: any[]) => {
    deadlines.push(ms ?? 0); return realSetTimeout(cb, ms === 60000 ? 5 : ms, ...args);
  }) as typeof setTimeout;
  try {
    const answer = await run(late);
    assert.equal(answer.answer, fixedSupportReply('unavailable', 'vi'));
    assert.equal(deadlines[0], 60000);
    assert.equal(late.calls.persisted[0]?.status, 'TIMED_OUT');
    resolve(mixed); await Promise.resolve();
    assert.equal(late.calls.generated, 0);
  } finally { globalThis.setTimeout = realSetTimeout; }
  late.scope.assess = h.scope.assess;
  assert.equal((await run(late)).answer, 'Verified shopping answer');
  console.log('Agent scope tests passed (gates, persistence, shared deadline and recovery)');
}
main().catch(e => { console.error(e); process.exitCode = 1; });
