import assert from 'node:assert/strict';
import { Logger } from '@nestjs/common';
import { AuditLogService } from '../src/guardrails/audit-log.service';
import { withTraceContext } from '../src/observability/trace-context';
import { harness, MEMBER, CONVERSATION } from './helpers/agent-harness';

async function main() {
  const records: any[] = [];
  const methods = ['log', 'warn', 'error'] as const;
  const originals = methods.map(method => Logger.prototype[method]);
  for (const method of methods) Logger.prototype[method] = function (message: any) {
    if (typeof message === 'string' && message.startsWith('{')) records.push(JSON.parse(message));
  };
  try {
    const a = harness([{ text: 'PRIVATE_ANSWER_A' }]), b = harness([{ text: 'PRIVATE_ANSWER_B' }]);
    await Promise.all([
      a.service.ask(MEMBER, CONVERSATION, 'PRIVATE_INPUT_A'),
      b.service.ask(MEMBER, CONVERSATION, 'PRIVATE_INPUT_B'),
    ]);
    const completed = records.filter(row => row.event === 'turn_completed');
    assert.equal(completed.length, 2, 'every turn logs its completion');
    assert.equal(new Set(completed.map(row => row.trace_id)).size, 2, 'concurrent turns do not share a trace');
    assert.ok(completed.every(row => row.turn_id === 'turn-1' && row.status === 'SUCCEEDED' && Number.isFinite(row.duration_ms)));
    for (const trace of new Set(completed.map(row => row.trace_id))) {
      const events = records.filter(row => row.trace_id === trace).map(row => row.event);
      assert.deepEqual(events.filter(e => e.startsWith('turn_')), ['turn_requested', 'turn_completed', 'turn_answered']);
    }
    records.length = 0;

    const failed = harness([{ error: Object.assign(new Error('PRIVATE_ERROR_BODY'), { cause: Object.assign(new Error('PRIVATE_CAUSE'), { code: 'ECONNRESET' }) }) }]);
    await assert.rejects(failed.service.ask(MEMBER, CONVERSATION, 'PRIVATE_INPUT_C'));
    const error = records.find(row => row.event === 'turn_failed');
    assert.ok(error, 'a failed turn logs a diagnostic');
    assert.equal(error.errorName, 'ModelError');
    assert.equal(error.cause.cause.code, 'ECONNRESET');
    assert.equal(error.error_code, 'agent_unavailable');
    assert.ok(error.trace_id && error.turn_id === 'turn-1');
    assert.ok(records.some(row => row.event === 'turn_refused' && row.error_code === 'agent_unavailable'));
    assert.ok(!JSON.stringify(records).match(/PRIVATE_/), 'logs carry no questions, answers or raw errors');
    records.length = 0;

    const requestTrace = '00000000-0000-4000-8000-012345678901';
    withTraceContext({ trace_id: requestTrace, conversation_id: 'owned-conversation', turn_id: 'owned-turn' }, () => {
      new AuditLogService().write({ trace_id: 'old-random-id', conversation_id: 'owned-conversation', actor_id: 'synthetic', role: 'moderator', event: 'turn_error', status: 'error', output_summary: 'synthetic phone 0912345678', ts: new Date().toISOString() });
    });
    assert.equal(records[0].trace_id, requestTrace, 'audit keeps the internal trace even when UUID digits resemble PII');
    assert.ok(!records[0].output_summary.includes('0912345678'), 'audit content is still masked');
    assert.equal(records[0].turn_id, 'owned-turn');
  } finally {
    methods.forEach((method, index) => { Logger.prototype[method] = originals[index] as any; });
  }
  console.log('Observability tests passed (trace isolation, failure causes, no raw content, audit masking)');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
