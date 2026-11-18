/** Offline: the LiteLLM boundary — user=<member> on every call, response headers, waiting out a per-minute ceiling. */
import assert from 'node:assert/strict';
import { Agent } from '@strands-agents/sdk';
import { LlmService } from '../src/llm/llm.service';
import { liteLlmFetch, readLiteLlmHeaders, readUsage, retryAfterMs } from '../src/llm/litellm-fetch';
import { config } from '../src/config';

const sse = (text: string) => [
  `data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', created: 0, model: 'm', choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }] })}`,
  `data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', created: 0, model: 'm', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}`,
  `data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', created: 0, model: 'm', choices: [], usage: { prompt_tokens: 7, completion_tokens: 2, total_tokens: 9, prompt_tokens_details: { cached_tokens: 4, cache_write_tokens: 2 } } })}`,
  'data: [DONE]', '', ''].join('\n\n');

async function main() {
  (config.litellm as { base_url: string }).base_url = 'http://litellm.test/v1';

  // The member goes to LiteLLM as `user`, on the agent's alias, through the run's fetch.
  const bodies: any[] = [];
  const seen: any[] = [];
  const waits: Date[] = [];
  const usages: any[] = [];
  let refusals = 1;
  const base = (async (_url: any, init: any) => {
    bodies.push(JSON.parse(init.body));
    if (refusals-- > 0) return new Response(JSON.stringify({ error: { message: 'Rate limit reached for rpm' } }), { status: 429, headers: { reset_at: new Date(Date.now() + 30).toISOString() } });
    return new Response(sse('xin chào'), { status: 200, headers: { 'content-type': 'text/event-stream', 'x-litellm-model-api-base': 'https://api.anthropic.test', 'x-litellm-response-cost': '0.002', 'x-litellm-model-id': 'dep-1' } });
  }) as typeof fetch;
  const model = new LlmService().createModel({ alias: 'console-agent', user: '11111111-1111-4111-8111-111111111111',
    fetch: liteLlmFetch({ onResponse: info => seen.push(info), onWait: until => waits.push(until), onUsage: u => usages.push(u) }, base) });
  const result = await new Agent({ model, printer: false }).invoke('hello');
  assert.equal(result.stopReason, 'endTurn');
  assert.equal(bodies.length, 2, 'the refused request goes again after the wait');
  assert.equal(bodies[1].user, '11111111-1111-4111-8111-111111111111');
  assert.equal(bodies[1].model, 'console-agent');
  assert.equal(waits.length, 1, 'the run is told when it calls again (rate.waiting)');
  assert.deepEqual(usages, [{ prompt_tokens: 7, completion_tokens: 2, cache_read_tokens: 4, cache_write_tokens: 2 }], 'cache counts are read off the stream');
  assert.equal(result.metrics?.accumulatedUsage?.inputTokens, 7, 'the model client still gets the body unchanged');
  assert.deepEqual(readUsage({ prompt_tokens: 10, completion_tokens: 1, cache_read_input_tokens: 6, cache_creation_input_tokens: 3 }),
    { prompt_tokens: 10, completion_tokens: 1, cache_read_tokens: 6, cache_write_tokens: 3 }, "Anthropic's spelling");
  assert.deepEqual(readUsage({ prompt_tokens: 10, prompt_tokens_details: { cache_creation_tokens: 4 } }),
    { prompt_tokens: 10, completion_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 4 });
  assert.deepEqual(seen.at(-1), { cost_usd: 0.002, provider: 'api.anthropic.test', deployment_id: 'dep-1', attempted_fallbacks: 0 });

  // A spent budget is not waited out; nor is a wait longer than the limit.
  let calls = 0;
  const budget = liteLlmFetch({ onResponse: () => {}, onWait: () => assert.fail('no wait on a spent budget') },
    (async () => { calls++; return new Response('{"error":{"message":"Budget has been exceeded!"}}', { status: 429 }); }) as typeof fetch);
  assert.equal((await budget('http://x')).status, 429);
  assert.equal(calls, 1);
  const long = liteLlmFetch({ onResponse: () => {}, onWait: () => assert.fail('too long to wait'), maxWaitMs: 1000 },
    (async () => new Response('{}', { status: 429, headers: { 'retry-after': '120' } })) as typeof fetch);
  assert.equal((await long('http://x')).status, 429);
  // Stop now ends a wait.
  const stop = new AbortController();
  const waiting = liteLlmFetch({ onResponse: () => {}, onWait: () => setTimeout(() => stop.abort(), 10), signal: stop.signal },
    (async () => new Response('{}', { status: 429, headers: { 'retry-after': '30' } })) as typeof fetch);
  await assert.rejects(waiting('http://x'), /cancelled/);

  const headers = (h: Record<string, string>) => ({ get: (k: string) => h[k] ?? null });
  assert.equal(retryAfterMs(headers({ 'retry-after-ms': '1500' })), 1500);
  assert.equal(retryAfterMs(headers({ 'retry-after': '2' })), 2000);
  assert.equal(retryAfterMs(headers({ reset_at: new Date(10_000).toISOString() }), 4000), 6000);
  assert.equal(retryAfterMs(headers({})), null);
  assert.equal(readLiteLlmHeaders(headers({ 'x-litellm-attempted-fallbacks': '2', 'x-litellm-model-id': 'dep-9' })).provider, 'dep-9');
  console.log('LiteLLM tests passed (user=<member>, alias, headers, rate-limit wait, budget and long waits refused, Stop now)');
}
main().catch(e => { console.error(e); process.exitCode = 1; });
