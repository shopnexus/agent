import assert from 'node:assert/strict';
import { ScopeService } from '../src/guardrails/scope.service';
import { LlmService } from '../src/llm/llm.service';
import { config } from '../src/config';
import { ScopeDecision, ScopeRequest } from '../src/guardrails/support-policy';

async function main() {
  const decision: ScopeDecision = { route: 'allow', intents: ['products'], memory: [], reason: 'in_scope' };
  const unavailable = { route: 'deny', intents: [], memory: [], reason: 'unavailable' };
  const request: ScopeRequest = { message: 'viết Go', locale: 'vi', history: Array.from({ length: 8 }, () => ({ role: 'user', content: [{ text: 'laptop'.repeat(200) }, { toolResult: { toolUseId: 'x', status: 'success', content: [{ text: 'PRIVATE_TOOL' }] } }] })) };
  let response = JSON.stringify(decision);
  const calls: any[] = [];
  const llm = { classifyJson: async (messages: unknown, signal: AbortSignal) => { calls.push({ messages, signal }); return response; } };
  const scope = new ScopeService(llm as unknown as LlmService);
  const signal = new AbortController().signal;
  assert.deepEqual(await scope.assess(request, signal), decision);
  const sent = calls[0].messages;
  assert.equal(sent.length, 2);
  assert.equal(sent[0].role, 'system');
  const data = JSON.parse(sent[1].content);
  assert.equal(data.message, request.message);
  assert.equal(data.history.length, 6);
  assert.equal(data.history[0].content.length, 500);
  assert.ok(!JSON.stringify(sent).includes('PRIVATE_TOOL'));
  assert.ok(sent[0].content.includes('current message'));
  for (const bad of ['no', '```json\n{}\n```', 'Here is {}', JSON.stringify({ ...decision, extra: 1 }), JSON.stringify({ ...decision, reason: 'unsafe' })]) {
    response = bad;
    assert.deepEqual(await scope.assess(request, signal), unavailable);
  }
  response = JSON.stringify({ route: 'deny', intents: [], memory: [], reason: 'out_of_scope' });
  assert.equal((await scope.assess(request, signal)).reason, 'out_of_scope');
  response = JSON.stringify({ allowed: true, reason: 'in_scope' });
  assert.equal((await scope.review({ ...request, decision, answer: 'Laptop advice' }, signal)).allowed, true);
  response = JSON.stringify({ allowed: true, reason: 'unsafe' });
  assert.deepEqual(await scope.review({ ...request, decision, answer: 'x' }, signal), { allowed: false, reason: 'unavailable' });
  const before = calls.length;
  assert.deepEqual(await scope.review({ ...request, decision, answer: 'x'.repeat(20001) }, signal), { allowed: false, reason: 'unavailable' });
  assert.equal(calls.length, before);
  let resolve!: (s: string) => void;
  let childSignal!: AbortSignal;
  llm.classifyJson = async (_messages, child) => { childSignal = child; return new Promise<string>(r => { resolve = r; }); };
  const parent = new AbortController();
  const pending = scope.assess(request, parent.signal);
  await Promise.resolve();
  parent.abort();
  assert.deepEqual(await pending, unavailable);
  assert.equal(childSignal.aborted, true);
  resolve(JSON.stringify(decision));
  assert.deepEqual(await scope.assess(request, parent.signal), unavailable);
  const realSetTimeout = globalThis.setTimeout;
  const deadlines: number[] = [];
  globalThis.setTimeout = ((callback: (...args: any[]) => void, ms?: number, ...args: any[]) => {
    deadlines.push(ms ?? 0);
    return realSetTimeout(callback, ms === 6000 ? 1 : ms, ...args);
  }) as typeof setTimeout;
  try {
    assert.deepEqual(await scope.assess(request, signal), unavailable);
    assert.equal(deadlines[0], 6000);
    assert.equal(childSignal.aborted, true);
  } finally { globalThis.setTimeout = realSetTimeout; }

  // Real OpenAI transport, intercepted at fetch: never sends a network request.
  const originalFetch = globalThis.fetch;
  // Synthetic in-process configuration only: no real endpoint/key can reach fetch.
  const originalGateway = { ...config.litellm };
  const originalModel = config.model.id;
  config.litellm.base_url = 'http://127.0.0.1:1/v1';
  config.litellm.api_key = 'synthetic-test-key';
  config.model.id = 'synthetic-test-model';
  let fetchCalls = 0;
  globalThis.fetch = async (input, init) => {
    fetchCalls++;
    const req = new Request(input, init);
    assert.ok(req.url.startsWith(config.litellm.base_url));
    const body = await req.json() as any;
    assert.equal(body.model, config.model.id);
    assert.equal(body.max_tokens, 512);
    assert.equal(body.tools, undefined);
    assert.equal(body.response_format, undefined);
    return new Response(JSON.stringify({ choices: [{ message: { content: '{"allowed":true,"reason":"in_scope"}' } }] }), { headers: { 'content-type': 'application/json' } });
  };
  try {
    const transport = new LlmService();
    assert.ok((await transport.classifyJson([{ role: 'user', content: 'synthetic' }], signal)).includes('in_scope'));
    globalThis.fetch = async () => { fetchCalls++; throw new Error('synthetic transport failure'); };
    const n = fetchCalls;
    await assert.rejects(() => transport.classifyJson([], signal));
    assert.equal(fetchCalls - n, 1, 'SDK must not retry');
  } finally {
    globalThis.fetch = originalFetch;
    Object.assign(config.litellm, originalGateway);
    config.model.id = originalModel;
  }
  console.log('Scope service tests passed (parsing, bounds, cancellation, intercepted transport)');
}
main().catch(e => { console.error(e); process.exitCode = 1; });
