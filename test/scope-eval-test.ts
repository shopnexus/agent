import assert from 'node:assert/strict';
import { supportScopeCases, outputScopeCases } from './fixtures/support-scope-cases';
import { evaluateScope, runLiveEvaluation } from './scope-live-eval';
import { scopeDecisionSchema, scopeHistory, outputDecisionSchema } from '../src/guardrails/support-policy';

async function main() {
  const cases = [...supportScopeCases, ...outputScopeCases];
  assert.equal(new Set(cases.map(c => c.id)).size, cases.length);
  assert.ok(cases.length <= 40 && supportScopeCases.length >= 24);
  for (const c of supportScopeCases) {
    scopeDecisionSchema.parse({ route: c.expectedRoute, intents: c.expectedIntents, memory: c.expectedMemory,
      reason: { allow: 'in_scope', mixed: 'mixed_request', clarify: 'ambiguous', deny: 'out_of_scope' }[c.expectedRoute] });
    assert.ok(c.message.length > 0 && c.message.length <= 2000);
    const bounded = scopeHistory(c.history);
    assert.ok(bounded.length <= 6 && bounded.every(m => m.content.length <= 500));
  }
  for (const c of outputScopeCases) {
    scopeDecisionSchema.parse(c.request.decision);
    assert.ok(c.request.answer.length <= 20000);
    outputDecisionSchema.parse({ allowed: c.expectedAllowed, reason: c.expectedAllowed ? 'in_scope' : 'out_of_scope' });
  }
  const saved = process.env.RUN_SCOPE_LIVE_EVAL;
  delete process.env.RUN_SCOPE_LIVE_EVAL;
  try { await assert.rejects(() => runLiveEvaluation(), /RUN_SCOPE_LIVE_EVAL=1/); }
  finally { if (saved === undefined) delete process.env.RUN_SCOPE_LIVE_EVAL; else process.env.RUN_SCOPE_LIVE_EVAL = saved; }

  // These stubs test evaluator accounting and safety, not model understanding.
  let calls = 0;
  let active = 0;
  let maxActive = 0;
  const scope = {
    async assess(request: any, signal: AbortSignal) {
      calls++; active++; maxActive = Math.max(maxActive, active);
      assert.equal(signal.aborted, false);
      await Promise.resolve(); active--;
      const c = supportScopeCases.find(c => c.message === request.message)!;
      return { route: c.expectedRoute, intents: c.expectedIntents, memory: c.expectedMemory,
        reason: { allow: 'in_scope', mixed: 'mixed_request', clarify: 'ambiguous', deny: 'out_of_scope' }[c.expectedRoute] };
    },
    async review(request: any) {
      calls++;
      const c = outputScopeCases.find(c => c.request.answer === request.answer)!;
      return { allowed: c.expectedAllowed, reason: c.expectedAllowed ? 'in_scope' : 'out_of_scope' };
    },
  };
  const logs: string[] = [];
  const result = await evaluateScope(scope as any, s => logs.push(s));
  assert.deepEqual(result, { passed: cases.length, total: cases.length });
  assert.equal(calls, cases.length);
  assert.equal(maxActive, 1);
  assert.ok(logs.every(line => !supportScopeCases.some(c => line.includes(c.message)) && !outputScopeCases.some(c => line.includes(c.request.answer))));
  let failedCalls = 0;
  const failed = { ...scope, assess: async () => { failedCalls++; return { route: 'deny', intents: [], memory: [], reason: 'unavailable' }; } };
  await assert.rejects(() => evaluateScope(failed as any, () => {}), /unavailable/);
  assert.equal(failedCalls, 1, 'stop on first transport/unavailable failure');
  const wrong = { ...scope, assess: async () => ({ route: 'deny', intents: [], memory: [], reason: 'out_of_scope' }) };
  const mismatch = await evaluateScope(wrong as any, () => {});
  assert.ok(mismatch.passed < mismatch.total, 'expectation mismatch must be visible to the executable exit gate');
  console.log(`Scope fixtures/evaluator tests passed (${cases.length} synthetic cases; no live evaluation)`);
}
main().catch(e => { console.error(e); process.exitCode = 1; });
