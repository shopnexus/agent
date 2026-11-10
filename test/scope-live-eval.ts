import type { ScopeService } from '../src/guardrails/scope.service';
import { supportScopeCases, outputScopeCases } from './fixtures/support-scope-cases';

type Evaluator = Pick<ScopeService, 'assess' | 'review'>;
export async function evaluateScope(scope: Evaluator, write: (line: string) => void): Promise<{ passed: number; total: number }> {
  const total = supportScopeCases.length + outputScopeCases.length;
  if (total > 40) throw new Error('Maximum 40 semantic calls per evaluation');
  let passed = 0;
  const signal = new AbortController().signal;
  const sorted = (values: readonly string[]) => [...values].sort();
  for (const c of supportScopeCases) {
    const actual = await scope.assess({ message: c.message, history: c.history, locale: 'vi' }, signal);
    if (actual.reason === 'unavailable') throw new Error(`unavailable: ${c.id}`);
    const expected = { route: c.expectedRoute, intents: sorted(c.expectedIntents), memory: sorted(c.expectedMemory) };
    const observed = { route: actual.route, intents: sorted(actual.intents), memory: sorted(actual.memory) };
    if (JSON.stringify(expected) === JSON.stringify(observed)) passed++;
    write(JSON.stringify({ id: c.id, expected, actual: observed }));
  }
  for (const c of outputScopeCases) {
    const actual = await scope.review(c.request, signal);
    if (actual.reason === 'unavailable') throw new Error(`unavailable: ${c.id}`);
    if (actual.allowed === c.expectedAllowed) passed++;
    write(JSON.stringify({ id: c.id, expected: { allowed: c.expectedAllowed }, actual }));
  }
  write(JSON.stringify({ passed, total }));
  return { passed, total };
}

export async function runLiveEvaluation(): Promise<{ passed: number; total: number }> {
  // Check BEFORE importing runtime configuration or constructing any client.
  // This gate is not consent: obtain explicit user authorization before enabling.
  if (process.env.RUN_SCOPE_LIVE_EVAL !== '1') throw new Error('Live evaluation disabled. Obtain authorization, then set RUN_SCOPE_LIVE_EVAL=1.');
  const { LlmService } = await import('../src/llm/llm.service');
  const { ScopeService } = await import('../src/guardrails/scope.service');
  // Generation onModuleInit is intentionally not called; no AppModule/DB/MCP/embedding bootstrap.
  return evaluateScope(new ScopeService(new LlmService()), line => console.log(line));
}

if (require.main === module) runLiveEvaluation().then(result => {
  if (result.passed !== result.total) process.exitCode = 1;
}).catch(() => {
  console.error(process.env.RUN_SCOPE_LIVE_EVAL === '1'
    ? 'Scope evaluation stopped: unavailable transport or invalid evaluation; no further calls were made.'
    : 'Live evaluation disabled. Obtain authorization, then set RUN_SCOPE_LIVE_EVAL=1.');
  process.exitCode = 1;
});
