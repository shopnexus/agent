/** Offline: opening a member's turn through AgentService — 202, the run in the background, refusals before a turn opens. */
import assert from 'node:assert/strict';
import { Logger } from '@nestjs/common';
import { ModelThrottledError } from '@strands-agents/sdk';
import { AgentError } from '../src/http/agent-error';
import { harness, MEMBER, CONVERSATION, TICKET, ACCOUNT, ORDER } from './helpers/agent-harness';

async function rejectsWith(promise: Promise<unknown>, code: string, status: number) {
  await assert.rejects(promise, (e: unknown) => e instanceof AgentError && e.code === code && e.getStatus() === status, code);
}

async function main() {
  Logger.overrideLogger(['fatal']);

  // The turn opens RUNNING with its run state and answers at once; the run goes on behind it.
  const ok = harness([
    { tools: [{ name: 'ticket_get', input: { ticket_id: TICKET } }, { name: 'account_get', input: { account_id: ACCOUNT } }] },
    { tools: [{ name: 'order_get', input: { order_id: ORDER } }, { name: 'suspend_account', input: { account_id: ACCOUNT } }] },
    { text: 'Ticket hỏi về đơn đã giao [1].' },
  ]);
  const accepted = await ok.service.ask(MEMBER, CONVERSATION, { text: 'Ticket này nói gì?', agent_config: { id: 'a1', name: 'Console assistant', alias: 'console-agent', limits: { deadline_s: 120 } } });
  assert.equal(accepted.conversation_id, CONVERSATION);
  const row = ok.turns.rows.get(accepted.turn_id);
  assert.equal(row.start.memberId, MEMBER.id, 'the turn records who asked');
  assert.equal(row.start.agentName, 'Console assistant');
  assert.equal(row.start.deadlineMs, 120_000);
  assert.equal(row.start.state.question, 'Ticket này nói gì?');
  assert.deepEqual(row.start.state.agent_config.limits, { deadline_s: 120 }, 'agent_config is kept on the turn, not elsewhere');
  await ok.runner.idle();
  assert.deepEqual(ok.calls.executed.sort(), ['account_get', 'order_get', 'ticket_get'], 'a tool outside the session never runs');
  assert.deepEqual(ok.calls.sessions, [MEMBER.id], 'one MCP session per run, as the member');
  assert.equal(ok.calls.closed, 1, 'the session closes after the run');
  assert.equal(ok.turns.finished[0].status, 'SUCCEEDED');
  assert.deepEqual(ok.turns.finished[0].sources.map((s: any) => s.record_id), [TICKET], 'the answer keeps the sources it cites');
  assert.deepEqual(ok.turns.rows.get(accepted.turn_id).state.sources.map((s: any) => s.record_id), [TICKET, ACCOUNT, ORDER], 'the run state keeps every number');
  assert.equal(ok.turns.calls().find(c => c.toolName === 'account_get').status, 'failed');

  // Throttling caused by a spent budget is not retried.
  const throttled = harness([{ error: new ModelThrottledError('No deployments available: ExceededBudget', { cause: { status: 429, message: 'Budget exceeded for model=console-agent' } as any }) }]);
  await throttled.service.ask(MEMBER, CONVERSATION, { text: 'Tóm tắt' });
  await throttled.runner.idle();
  assert.equal(throttled.model.calls, 1);
  assert.equal(throttled.turns.finished[0].errorCode, 'agent_budget');

  // Refusals before a turn opens.
  for (const [text, code] of [['   ', 'bad_request'], [42, 'bad_request'], ['x'.repeat(2001), 'input_rejected']] as const) {
    const h = harness([]);
    await rejectsWith(h.service.ask(MEMBER, CONVERSATION, { text }), code, 400);
    assert.equal(h.turns.rows.size, 0);
  }
  await rejectsWith(harness([]).service.ask(MEMBER, CONVERSATION, { text: 'x', agent_config: { limits: { deadline_s: 9999 } } }), 'bad_request', 400);
  await rejectsWith(harness([]).service.ask(MEMBER, CONVERSATION, { text: 'x', skill_id: 'not-a-uuid' }), 'bad_request', 400);
  const busy = harness([]);
  busy.turns.startError = AgentError.turnInProgress();
  await rejectsWith(busy.service.ask(MEMBER, CONVERSATION, { text: 'x' }), 'turn_in_progress', 409);

  // A skill's prompt joins the system prompt.
  const skilled = harness([{ text: 'ok' }]);
  const skillId = '77777777-7777-4777-8777-777777777777';
  skilled.skillRows.set(skillId, { id: skillId, name: 'Weekly scams', prompt: 'Count scam reports by day.' });
  await skilled.service.ask(MEMBER, CONVERSATION, { text: 'Tuần này', skill_id: skillId });
  await skilled.runner.idle();
  assert.ok(String(skilled.model.systemPrompts[0]).includes('Count scam reports by day.'));

  console.log('Agent turn tests passed (202 and the background run, member and agent_config on turns, budget, refusals, skills)');
}
main().catch(e => { console.error(e); process.exitCode = 1; });
