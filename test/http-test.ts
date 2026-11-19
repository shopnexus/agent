/** Offline: the HTTP surface on 127.0.0.1 — the service token, refusals before the stream, NDJSON framing, the end line, disconnects. */
import 'reflect-metadata';
import assert from 'node:assert/strict';
import { Logger, Module } from '@nestjs/common';
import { APP_FILTER, NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { ServiceTokenGuard, sameSecret } from '../src/console/service-token.guard';
import { FeatureFlags } from '../src/guardrails/feature-flags';
import { AgentErrorFilter } from '../src/http/agent-error';
import { config } from '../src/config';
import { BODY_LIMIT } from '../src/main';
import { RunsController } from '../src/run/runs.controller';
import { TurnRunner } from '../src/run/turn-runner';
import { fakeServer, harness, CONVERSATION, MEMBER } from './helpers/run-harness';

const TOKEN = 'service-token-for-tests';
const TURN = '44444444-4444-4444-8444-444444444444';

async function main() {
  Logger.overrideLogger(['fatal']);
  assert.equal(sameSecret(TOKEN, TOKEN), true);
  assert.equal(sameSecret(TOKEN + 'x', TOKEN), false);
  assert.equal(sameSecret('', ''), false, 'an empty configured token matches nothing');

  const server = await fakeServer();
  const h = harness([{ text: 'Xin chào.', delayMs: 300 }, { hang: true }, { text: 'Big state ok.' }]);
  @Module({ controllers: [RunsController], providers: [
    { provide: TurnRunner, useValue: h.runner }, ServiceTokenGuard, { provide: APP_FILTER, useClass: AgentErrorFilter },
  ] })
  class TestModule {}
  const app = await NestFactory.create<NestExpressApplication>(TestModule, { logger: false, bodyParser: false });
  app.useBodyParser('json', { limit: BODY_LIMIT });
  await app.listen(0, '127.0.0.1');
  const base = await app.getUrl();
  const auth = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };
  const body = { turn_id: TURN, conversation_id: CONVERSATION, member: MEMBER, mode: 'new', question: 'Chào' };
  const post = async (payload: unknown, headers: Record<string, string> = auth) => {
    const res = await fetch(`${base}/runs`, { method: 'POST', headers, body: typeof payload === 'string' ? payload : JSON.stringify(payload) });
    return { status: res.status, type: res.headers.get('content-type') ?? '', text: await res.text() };
  };
  const refused = async (payload: unknown, status: number, code: string, headers?: Record<string, string>) => {
    const res = await post(payload, headers);
    assert.deepEqual([res.status, JSON.parse(res.text)], [status, { code }], `${status} ${code}`);
  };
  try {
    // The probe needs no token.
    const health = await fetch(`${base}/healthz`);
    assert.deepEqual([health.status, await health.json()], [200, { ok: true }]);

    (config.console as { service_token: string }).service_token = '';
    await refused(body, 401, 'unauthorized', { ...auth, authorization: 'Bearer ' });
    await refused(body, 401, 'unauthorized', { ...auth, authorization: 'Bearer x' });
    (config.console as { service_token: string }).service_token = TOKEN;
    for (const headers of [{ 'content-type': 'application/json' }, { ...auth, authorization: 'Bearer wrong' }, { ...auth, authorization: TOKEN }]) {
      await refused(body, 401, 'unauthorized', headers);
    }

    await refused('{not json', 400, 'bad_request');
    await refused({ ...body, turn_id: 'nope' }, 400, 'bad_request');
    await refused({ ...body, mode: 'later' }, 400, 'bad_request');
    await refused({ ...body, question: '  ' }, 400, 'bad_request');
    await refused({ ...body, member: { id: MEMBER.id, role: 'seller' } }, 400, 'bad_request');
    await refused({ ...body, agent_config: { limits: { deadline_s: 9999 } } }, 400, 'bad_request');
    await refused({ ...body, mode: 'resume' }, 400, 'bad_request');
    await refused({ ...body, history: [{ status: 'RUNNING', question: 'x', entries: [] }] }, 400, 'bad_request');

    FeatureFlags.setAgentEnabled(false);
    await refused(body, 503, 'agent_unavailable');
    FeatureFlags.setAgentEnabled(true);
    FeatureFlags.setLlmEnabled(false);
    await refused(body, 503, 'agent_unavailable');
    FeatureFlags.setLlmEnabled(true);
    assert.equal(h.model.calls, 0, 'refused requests run nothing');

    // 200: one JSON object per line, written while the run goes, the end line last.
    const t0 = Date.now();
    const res = await fetch(`${base}/runs`, { method: 'POST', headers: auth, body: JSON.stringify(body) });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /^application\/x-ndjson/);
    const reader = res.body!.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    assert.ok(Date.now() - t0 < 250, 'the first line comes before the model answers');
    assert.equal(JSON.parse(first.split('\n')[0]).type, 'turn.started');
    let text = first;
    for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) text += new TextDecoder().decode(chunk.value);
    assert.ok(text.endsWith('\n'));
    const lines = text.trimEnd().split('\n').map(l => JSON.parse(l));
    assert.ok(lines.every(l => typeof l.kind === 'string'));
    assert.deepEqual(lines.filter(l => l.kind === 'end').length, 1);
    const end = lines.at(-1);
    assert.deepEqual(Object.keys(end).sort(), ['answer', 'blocks', 'error_code', 'event', 'kind', 'latency_ms', 'sources', 'state', 'status', 'usage', 'wrote']);
    assert.deepEqual([end.status, end.answer, end.event.type], ['SUCCEEDED', 'Xin chào.', 'turn.finished']);
    assert.deepEqual(Object.keys(end.usage).sort(), ['cache_read_tokens', 'cache_write_tokens', 'cost_usd', 'first_token_ms', 'input_tokens', 'output_tokens', 'provider']);

    // Closing the request aborts the segment.
    const closing = new AbortController();
    const hung = await fetch(`${base}/runs`, { method: 'POST', headers: auth, body: JSON.stringify(body), signal: closing.signal });
    await hung.body!.getReader().read();
    await new Promise(r => setTimeout(r, 50));
    closing.abort();
    const at = Date.now();
    await h.runner.idle();
    assert.ok(Date.now() - at < 2000, 'the run ends when its request closes');

    // A resume request carries the state back, well over the default 100 kB body limit.
    const big = { v: 1, member: MEMBER, conversation_id: CONVERSATION, agent_config: {}, question: 'Chào', sources: [], steps: [], model_calls: 1, elapsed_ms: 10, wrote: true,
      usage: { input_tokens: 1, output_tokens: 1, cost_usd: 0 }, messages: [{ role: 'user', content: [{ text: 'Chào' }] }, { role: 'assistant', content: [{ text: 'y'.repeat(300_000) }] }] };
    const resumed = await post({ ...body, mode: 'resume', state: big });
    assert.equal(resumed.status, 200);
    assert.equal(JSON.parse(resumed.text.trimEnd().split('\n').at(-1)!).status, 'SUCCEEDED');
  } finally {
    await app.close();
    await server.stop();
  }
  console.log('HTTP tests passed (healthz, service token, 400 and 503 refusals, NDJSON framing, the end line, disconnects, body limit)');
}
main().catch(e => { console.error(e); process.exitCode = 1; });
