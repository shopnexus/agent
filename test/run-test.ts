/** Offline: a turn as a run with a scripted model — steps, citations, answer checks, tool retry, pause, steer, Stop now, ask_user, outcomes. */
import assert from 'node:assert/strict';
import { Logger } from '@nestjs/common';
import { tool } from '@strands-agents/sdk';
import { z } from 'zod';
import { AgentError } from '../src/http/agent-error';
import { config } from '../src/config';
import { harness, MEMBER, CONVERSATION, TICKET, ACCOUNT, ORDER } from './helpers/agent-harness';

const ask = async (h: ReturnType<typeof harness>, text = 'Ticket này nói gì?', agent_config?: unknown) =>
  (await h.service.ask(MEMBER, CONVERSATION, { text, agent_config })).turn_id;
const body = (h: ReturnType<typeof harness>, turnId: string, type: string) => h.eventsOf(turnId).filter(e => e.type === (type as string)).map(e => e.body as any);
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function stepsCitationsAnswer() {
  const h = harness([
    { tools: [{ name: 'begin_step', input: { title: 'Read the ticket' } }], reasoning: 'Need the ticket first' },
    { tools: [{ name: 'ticket_get', input: { ticket_id: TICKET } }] },
    { tools: [{ name: 'end_step', input: { summary: 'Counterfeit report' } }] },
    { tools: [{ name: 'answer', input: { blocks: [
      { type: 'text', markdown: 'The ticket reports a counterfeit [1] from account [2], see also [9].' },
      { type: 'figures', items: [{ value: 1, label: 'Tickets' }, { value: '2', label: 'Accounts', tone: 'neutral' }] },
      { type: 'follow_ups', items: ['Who else bought from this account?'] },
    ] } }] },
  ]);
  const turnId = await ask(h, 'Ticket này nói gì?', { id: 'a1', name: 'Console assistant', alias: 'console-agent', tools: ['ticket_get'] });
  await h.runner.idle();
  const types: string[] = h.types(turnId);
  assert.equal(types[0], 'turn.started');
  for (const t of ['thinking', 'step.started', 'tool.started', 'tool.finished', 'step.finished', 'usage', 'context.meter', 'block', 'turn.finished']) assert.ok(types.includes(t), t);
  assert.ok(types.indexOf('step.started') < types.indexOf('tool.started') && types.indexOf('tool.finished') < types.indexOf('step.finished'));
  assert.equal(types.at(-1), 'turn.finished');
  assert.deepEqual(body(h, turnId, 'turn.started')[0], { agent: { id: 'a1', name: 'Console assistant' }, model: 'console-agent', deadline_s: 60 });
  const started = body(h, turnId, 'tool.started')[0];
  assert.equal(started.step_id, 'step-1', 'a tool call belongs to the open step');
  assert.equal(started.label, 'Ticket');
  const finished = body(h, turnId, 'tool.finished')[0];
  assert.equal(finished.status, 'success');
  assert.deepEqual(finished.source_ids, [1, 2]);
  assert.ok(finished.timing && 'queued' in finished.timing && 'server' in finished.timing && 'db' in finished.timing && 'return' in finished.timing);
  assert.equal(finished.call_id, h.turns.calls()[0].id, 'call_id is the tool_calls row id');
  const done = body(h, turnId, 'turn.finished')[0];
  assert.equal(done.status, 'SUCCEEDED');
  assert.equal(done.outcome, null);
  assert.deepEqual(done.sources.map((s: any) => [s.n, s.kind, s.record_id]), [[1, 'ticket', TICKET], [2, 'account', ACCOUNT]]);
  assert.equal(done.sources[0].quote, 'Hàng giả', 'the source keeps a quoted line');
  assert.equal(done.sources[0].call_id, finished.call_id, 'the source keeps its tool call');
  const blocks = body(h, turnId, 'block').map(b => b.block);
  assert.deepEqual(blocks.map(b => b.type), ['text', 'figures', 'follow_ups']);
  assert.equal(blocks[0].markdown, 'The ticket reports a counterfeit [1] from account [2], see also.', 'a marker without a source is dropped');
  const stored = h.turns.finished[0];
  assert.equal(stored.status, 'SUCCEEDED');
  assert.deepEqual(stored.blocks, blocks);
  assert.equal(stored.answer, blocks[0].markdown);
  // The model saw the numbers in the tool result.
  const seen = JSON.stringify(h.model.messages.at(-1));
  assert.ok(seen.includes('[1] ticket ' + TICKET), 'the tool result header names the source numbers');
  assert.equal(h.calls.models[0].user, MEMBER.id, 'LiteLLM gets user=<member id>');
  assert.equal(h.calls.models[0].alias, 'console-agent');
  assert.deepEqual(h.calls.sessions, [MEMBER.id]);
  assert.equal(h.calls.closed, 1);
  // agent_config.tools: order_get is not allowed, so the model never had it.
  const prompt = String(h.model.systemPrompts[0]);
  assert.ok(prompt.includes('begin_step') && prompt.includes(TICKET));
}

async function answerValidation() {
  const h = harness([
    { tools: [{ name: 'answer', input: { blocks: [{ type: 'table', columns: ['a', 'b'], rows: [['1']] }] } }] },
    { tools: [{ name: 'answer', input: { blocks: [{ type: 'figures', items: [{ value: 1, label: 'only one' }] }] } }] },
    { tools: [{ name: 'answer', input: { blocks: [{ type: 'document_ref', document_id: ORDER, version: 1 }] } }] },
    { tools: [{ name: 'answer', input: { blocks: [{ type: 'table', columns: ['a', 'b'], rows: [['1', 2]] }] } }] },
  ]);
  const turnId = await ask(h);
  await h.runner.idle();
  assert.equal(h.model.calls, 4, 'each invalid answer goes back to the model');
  const errors = h.model.messages.slice(1).map(m => JSON.stringify(m.at(-1)));
  assert.ok(errors[0].includes('row has 1 cells'));
  assert.ok(errors[2].includes('is not in this chat'), 'a document_ref must name a document of the chat');
  assert.deepEqual(body(h, turnId, 'block').map(b => b.block.type), ['table']);
  assert.equal(body(h, turnId, 'turn.finished')[0].status, 'SUCCEEDED');
}

async function documents() {
  const h = harness([
    { tools: [{ name: 'write_document', input: { title: 'Report', sections: [{ kind: 'markdown', markdown: '# Report' }] } }] },
  ]);
  // The second step answers with a ref to whatever the first wrote.
  (h.model as any).stream = ((orig) => async function* (this: any, ...args: any[]) {
    if (this.calls === 1) {
      const id = [...h.documents.docs.keys()][0];
      this.calls++;
      yield { type: 'modelMessageStartEvent', role: 'assistant' };
      yield { type: 'modelContentBlockStartEvent', start: { type: 'toolUseStart', name: 'answer', toolUseId: 'a-1' } };
      yield { type: 'modelContentBlockDeltaEvent', delta: { type: 'toolUseInputDelta', input: JSON.stringify({ blocks: [{ type: 'document_ref', document_id: id, version: 1 }] }) } };
      yield { type: 'modelContentBlockStopEvent' };
      yield { type: 'modelMessageStopEvent', stopReason: 'toolUse' };
      return;
    }
    yield* orig.apply(this, args);
  })((h.model as any).stream);
  const turnId = await ask(h);
  await h.runner.idle();
  assert.equal(h.documents.docs.size, 1);
  assert.equal(body(h, turnId, 'block')[0].block.type, 'document_ref');
  assert.equal(body(h, turnId, 'turn.finished')[0].status, 'SUCCEEDED');
}

async function toolRetry() {
  let attempts = 0;
  const flaky = tool({ name: 'report_get', description: 'Read a report', inputSchema: z.object({ id: z.string() }),
    callback: ({ id }) => { if (++attempts === 1) throw new Error('fetch failed: ECONNRESET'); return { report: { id, reason: 'Hàng cấm' } }; } });
  const h = harness([{ tools: [{ name: 'report_get', input: { id: 'r-1' } }] }, { text: 'Report r-1 [1].' }], { tools: [flaky] });
  const turnId = await ask(h);
  await h.runner.idle();
  const retry = body(h, turnId, 'tool.retry');
  assert.equal(retry.length, 1);
  assert.equal(retry[0].attempt, 2);
  assert.ok(retry[0].error.includes('ECONNRESET'));
  assert.equal(retry[0].next_in_ms, 500);
  assert.equal(retry[0].timeout_ms, config.agent.tool_timeout_ms);
  assert.equal(body(h, turnId, 'tool.started').length, 1, 'one tool.started per call, not per attempt');
  assert.equal(body(h, turnId, 'tool.finished')[0].status, 'success');
  assert.equal(h.turns.calls()[0].attempts, 2);
  assert.equal(body(h, turnId, 'block')[0].block.markdown, 'Report r-1 [1].', 'free text becomes one text block');

  // A tool past its time limit, with one attempt allowed, fails.
  const slow = tool({ name: 'slow_get', description: 'Slow', inputSchema: z.object({}), callback: () => new Promise<string>(() => {}) });
  const t = harness([{ tools: [{ name: 'slow_get' }] }, { text: 'It timed out.' }], { tools: [slow] });
  const slowTurn = await ask(t, 'x', { limits: { tool_timeout_s: 1, tool_attempts: 1 } });
  await t.runner.idle();
  const failed = body(t, slowTurn, 'tool.finished')[0];
  assert.equal(failed.status, 'failed');
  assert.match(failed.result_summary, /timed out/);
}

async function askUser() {
  const questions = [{ id: 'range', label: 'Which period?', kind: 'single', options: [{ id: 'd7', label: 'Last 7 days' }, { id: 'd30', label: 'Last 30 days' }] }];
  const h = harness([
    { tools: [{ name: 'ask_user', input: { questions } }] },
    { text: 'For the last 30 days: none.' },
  ]);
  const turnId = await ask(h);
  await h.runner.idle();
  assert.equal(h.turns.rows.get(turnId).status, 'AWAITING_INPUT');
  assert.deepEqual(body(h, turnId, 'clarify')[0].questions, questions);
  assert.equal(h.types(turnId).at(-1), 'clarify');
  assert.equal(h.model.calls, 1, 'ask_user ends the model call');
  await assert.rejects(h.actions.input(MEMBER, turnId, { range: 'd90' }), (e: any) => e.code === 'bad_request');
  await h.actions.input(MEMBER, turnId, { range: 'd30' });
  await h.runner.idle();
  assert.deepEqual(body(h, turnId, 'turn.resumed'), [{ by: 'input' }]);
  assert.ok(JSON.stringify(h.model.messages[1]).includes('Which period?: Last 30 days'), 'the model reads the answers');
  assert.equal(h.turns.rows.get(turnId).status, 'SUCCEEDED');
  assert.equal(h.turns.userBlocks[0].payload.answers.range, 'd30');
}

async function pauseAndContinue() {
  let release!: () => void;
  const gate = new Promise<void>(r => { release = r; });
  const waiting = tool({ name: 'case_get', description: 'Read a case', inputSchema: z.object({}), callback: async () => { await gate; return { case: { id: 'c-1', reason: 'Lừa đảo' } }; } });
  const h = harness([{ tools: [{ name: 'case_get' }] }, { text: 'Case c-1 is a scam [1].' }], { tools: [waiting] });
  const turnId = await ask(h);
  await h.waitFor(turnId, 'tool.started');
  await h.actions.pause(MEMBER, turnId);
  await h.waitFor(turnId, 'turn.pausing');
  release();
  await h.runner.idle();
  assert.equal(h.turns.rows.get(turnId).status, 'PAUSED');
  assert.equal(h.model.calls, 1, 'no model call after the pause');
  assert.equal(body(h, turnId, 'tool.finished')[0].status, 'success', 'the tool in flight finishes and keeps its result');
  assert.deepEqual(body(h, turnId, 'turn.paused'), [{ steps_done: 0, reason: 'member' }]);
  const saved = h.turns.rows.get(turnId).state;
  assert.ok(JSON.stringify(saved.messages.at(-1)).includes('toolResult'), 'the saved state ends with the tool result');
  await assert.rejects(h.actions.pause(MEMBER, turnId), (e: any) => e instanceof AgentError && e.code === 'turn_state');

  await h.actions.continue(MEMBER, turnId);
  await h.runner.idle();
  assert.equal(h.turns.rows.get(turnId).status, 'SUCCEEDED', 'Continue resumes the same turn');
  assert.deepEqual(body(h, turnId, 'turn.resumed'), [{ by: 'continue' }]);
  assert.equal(h.types(turnId).filter(t => t === 'turn.started').length, 1);
  assert.equal(body(h, turnId, 'turn.finished')[0].sources[0].record_id, 'c-1', 'sources carry over');
  assert.equal(h.model.messages[1].filter((m: any) => m.role === 'user').length >= 2, true);
}

async function steering() {
  // While running: read before the next model call.
  let release!: () => void;
  const gate = new Promise<void>(r => { release = r; });
  const waiting = tool({ name: 'case_get', description: 'Read a case', inputSchema: z.object({}), callback: async () => { await gate; return { case: { id: 'c-1' } }; } });
  const h = harness([{ tools: [{ name: 'begin_step', input: { title: 'Look' } }] }, { tools: [{ name: 'case_get' }] }, { text: 'Done.' }], { tools: [waiting] });
  const turnId = await ask(h);
  await h.waitFor(turnId, 'tool.started');
  const { steer_id, resumed } = await h.actions.steer(MEMBER, turnId, 'Only last week, please');
  assert.equal(resumed, false);
  await sleep(30);
  release();
  await h.runner.idle();
  const read = body(h, turnId, 'steer.read');
  assert.equal(read.length, 1);
  assert.equal(read[0].steer_id, steer_id);
  assert.equal(read[0].step_id, 'step-1');
  assert.ok(JSON.stringify(h.model.messages[2]).includes('Update from the member: Only last week, please'));
  assert.deepEqual(h.turns.userBlocks.map(b => b.payload.steer_id), [steer_id], 'the update is kept in the transcript');

  // While paused: the message continues the run and is read as steering.
  const p = harness([{ tools: [{ name: 'order_get', input: { order_id: ORDER } }], delayMs: 50 }, { text: 'Delivered [1].' }]);
  const paused = await ask(p);
  await p.actions.pause(MEMBER, paused);
  await p.runner.idle();
  assert.equal(p.turns.rows.get(paused).status, 'PAUSED');
  const sent = await p.actions.steer(MEMBER, paused, 'Check the delivery date');
  assert.equal(sent.resumed, true);
  await p.runner.idle();
  assert.deepEqual(body(p, paused, 'turn.resumed'), [{ by: 'steer' }]);
  assert.equal(body(p, paused, 'steer.read')[0].steer_id, sent.steer_id);
  assert.equal(p.turns.rows.get(paused).status, 'SUCCEEDED');
}

async function stopNowAndEnd() {
  const h = harness([{ hang: true }, { text: 'After stop.' }]);
  const turnId = await ask(h);
  await h.waitFor(turnId, 'turn.started');
  await sleep(20);
  const at = Date.now();
  await h.actions.stop(MEMBER, turnId);
  await h.runner.idle();
  assert.ok(Date.now() - at < 2000, 'Stop now ends the call at once');
  assert.equal(h.turns.rows.get(turnId).status, 'PAUSED');
  assert.deepEqual(body(h, turnId, 'turn.paused'), [{ steps_done: 0, reason: 'stop_now' }]);
  await h.actions.end(MEMBER, turnId);
  assert.equal(h.turns.rows.get(turnId).status, 'CANCELLED');
  assert.deepEqual(body(h, turnId, 'turn.finished')[0], { status: 'CANCELLED', outcome: 'stopped', continuable: false, sources: [] });
  await assert.rejects(h.actions.continue(MEMBER, turnId), (e: any) => e.code === 'turn_state');
}

async function outcomes() {
  // A spent budget: BUDGET, blocked, not continuable, not retried.
  const budgetError = Object.assign(new Error('400 Budget has been exceeded! Current cost: 20.01, Max budget: 20.0'), { status: 400, type: 'budget_exceeded' });
  const b = harness([{ tools: [{ name: 'order_get', input: { order_id: ORDER } }] }, { error: budgetError }]);
  const bt = await ask(b);
  await b.runner.idle();
  const bf = body(b, bt, 'turn.finished')[0];
  assert.deepEqual([bf.status, bf.outcome, bf.failure, bf.continuable], ['BUDGET', 'blocked', 'agent_budget', false]);
  assert.equal(b.model.calls, 2);
  assert.equal(b.turns.finished[0].answer, 'Hết hạn mức hôm nay.');
  await assert.rejects(b.actions.continue(MEMBER, bt), (e: any) => e.code === 'turn_state');

  // Broken on the way: continuable.
  const down = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
  const f = harness([{ tools: [{ name: 'order_get', input: { order_id: ORDER } }] }, { error: down }, { text: 'Recovered [1].' }]);
  const ft = await ask(f);
  await f.runner.idle();
  const ff = body(f, ft, 'turn.finished')[0];
  assert.deepEqual([ff.status, ff.outcome, ff.failure, ff.continuable], ['FAILED', 'broken', 'agent_failed', true]);
  await f.actions.continue(MEMBER, ft);
  await f.runner.idle();
  assert.equal(f.turns.rows.get(ft).status, 'SUCCEEDED');

  // Unavailable before anything: not continuable.
  const u = harness([], { mcpDown: true });
  const ut = await ask(u);
  await u.runner.idle();
  const uf = body(u, ut, 'turn.finished')[0];
  assert.deepEqual([uf.status, uf.outcome, uf.continuable], ['FAILED', 'unavailable', false]);
  assert.equal(u.model.calls, 0);

  // The deadline: TIMED_OUT, out of room.
  const deadline = config.agent.turn_deadline_ms;
  (config.agent as { turn_deadline_ms: number }).turn_deadline_ms = 200;
  try {
    const t = harness([{ tools: [{ name: 'order_get', input: { order_id: ORDER } }] }, { hang: true }]);
    const tt = await ask(t);
    await t.runner.idle();
    const tf = body(t, tt, 'turn.finished')[0];
    assert.deepEqual([tf.status, tf.outcome, tf.continuable], ['TIMED_OUT', 'out_of_room', true]);
    assert.equal(tf.sources.length, 1, 'a timed-out run keeps what it found');
    assert.equal(t.calls.closed, 1);
  } finally { (config.agent as { turn_deadline_ms: number }).turn_deadline_ms = deadline; }

  // Model calls run out: out of room.
  const l = harness([{ tools: [{ name: 'order_get', input: { order_id: ORDER } }] }, { tools: [{ name: 'order_get', input: { order_id: 'o-2' } }] }]);
  const lt = await ask(l, 'x', { limits: { max_model_calls: 1 } });
  await l.runner.idle();
  assert.deepEqual([body(l, lt, 'turn.finished')[0].failure, body(l, lt, 'turn.finished')[0].outcome], ['agent_limit', 'out_of_room']);

  // A loop: the guardrail event.
  const g = harness([0, 1, 2].map(() => ({ tools: [{ name: 'order_get', input: { order_id: ORDER } }] })).concat([{ text: 'ok' } as any]));
  const gt = await ask(g);
  await g.runner.idle();
  assert.equal(body(g, gt, 'guardrail')[0].rule, 'loop_stopped');
  assert.equal(body(g, gt, 'tool.finished')[2].status, 'skipped');
}

async function compaction() {
  const h = harness([
    { tools: [{ name: 'order_get', input: { order_id: ORDER } }], usage: { input: 3000, output: 300 } },
    { tools: [{ name: 'ticket_get', input: { ticket_id: TICKET } }], usage: { input: 3500, output: 200 } },
    { text: 'Done [1].' },
  ], { summarize: async transcript => { assert.ok(transcript.includes('order_get')); return 'The order was delivered.'; } });
  const turnId = await ask(h, 'x', { limits: { context_window: 4000 } });
  await h.runner.idle();
  const meter = body(h, turnId, 'context.meter');
  assert.deepEqual(meter[0], { used_tokens: 3300, window_tokens: 4000 });
  const compacting = body(h, turnId, 'context.compacting');
  const compacted = body(h, turnId, 'context.compacted');
  assert.equal(compacting.length, 1);
  assert.equal(compacted[0].summary, 'The order was delivered.');
  assert.equal(compacted[0].before_tokens, 3700);
  assert.ok(compacted[0].after_tokens < compacted[0].before_tokens);
  const last = JSON.stringify(h.model.messages.at(-1));
  assert.ok(last.includes('Summary of the earlier conversation') && last.includes('The order was delivered.'));
  assert.equal(body(h, turnId, 'turn.finished')[0].status, 'SUCCEEDED');
}

async function providerHeaders() {
  // The fake model calls its fetch, as the OpenAI client would, so LiteLLM's headers reach the run.
  const real = globalThis.fetch;
  const hosts = ['https://api.provider-a.test/v1', 'https://api.provider-b.test/v1'];
  let n = 0;
  globalThis.fetch = (async () => new Response('{}', { headers: {
    'x-litellm-model-api-base': hosts[Math.min(n++, 1)], 'x-litellm-response-cost': '0.0125', 'x-litellm-attempted-fallbacks': n === 2 ? '1' : '0' } })) as typeof fetch;
  try {
    const h = harness([{ tools: [{ name: 'order_get', input: { order_id: ORDER } }] }, { text: 'ok' }]);
    const createModel = (h.runner as any).llm.createModel;
    (h.runner as any).llm.createModel = (o: any) => {
      const model = createModel(o);
      const stream = model.stream.bind(model);
      model.stream = async function* (...args: any[]) { await o.fetch('http://litellm.test/v1/chat/completions'); yield* stream(...args); };
      return model;
    };
    const turnId = await ask(h);
    await h.runner.idle();
    const usage = body(h, turnId, 'usage');
    assert.deepEqual(usage.map(u => [u.provider, u.cost_usd]), [['api.provider-a.test', 0.0125], ['api.provider-b.test', 0.0125]]);
    assert.equal(typeof usage[0].first_token_ms, 'number');
    const switched = body(h, turnId, 'model.switched');
    assert.deepEqual(switched, [{ from_provider: 'api.provider-a.test', to_provider: 'api.provider-b.test', reason: 'fallback after 1 failed attempt(s)' }]);
    const finished = h.turns.finished[0];
    assert.equal(finished.costUsd, 0.025);
    assert.equal(finished.provider, 'api.provider-b.test');
  } finally { globalThis.fetch = real; }
}

async function main() {
  Logger.overrideLogger(['fatal']);
  for (const [name, test] of Object.entries({ stepsCitationsAnswer, answerValidation, documents, toolRetry, askUser, pauseAndContinue, steering, stopNowAndEnd, outcomes, compaction, providerHeaders })) {
    try { await test(); }
    catch (error) { console.error(`FAIL ${name}`); throw error; }
  }
  console.log('Run tests passed (steps, citations, answer checks, documents, tool retry, ask_user, pause, steer, Stop now, End, outcomes, compaction, provider headers)');
}
main().catch(e => { console.error(e); process.exitCode = 1; });
