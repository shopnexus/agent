import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Agent, BeforeToolCallEvent, tool } from '@strands-agents/sdk';
import { z } from 'zod';
import { Logger } from '@nestjs/common';
import { installToolCallTracker } from '../src/agent/tool-call-tracker';
import type { ToolCallLine } from '../src/run/run-stream';
import { withTraceContext } from '../src/observability/trace-context';
import { syntheticModel } from './helpers/scripted-model';

const candidate = (callback: () => any) => tool({ name: 'lookup', description: 'offline', inputSchema: z.object({}).passthrough(), callback });
function sink() {
  const writes: ToolCallLine[] = [];
  const rows = new Map<string, ToolCallLine>();
  return { writes, rows, write: (row: ToolCallLine) => { const copy = structuredClone(row); writes.push(copy); rows.set(copy.tool_use_id, copy); } };
}

test('rows go out before the callback, bounded and redacted, without the final draft', async () => {
  const out = sink(); let started = false;
  const agent = new Agent({ model: syntheticModel('lookup', { query: 'PRIVATE', api_key: 'SECRET', reasoning: 'THOUGHT' }), printer: false, tools: [candidate(() => {
    assert.equal(out.rows.size, 1); assert.equal([...out.rows.values()][0].status, 'running'); started = true; return { answer: 'evidence' };
  })] });
  installToolCallTracker(agent, out.write, { turnId: 'turn', maxPayloadChars: 256, label: () => 'Lookup' });
  await agent.invoke('request');
  assert(started);
  assert.deepEqual(out.writes.map(r => r.status), ['pending', 'running', 'success']);
  assert.equal(new Set(out.writes.map(r => r.id)).size, 1, 'one row id per call');
  const row = [...out.rows.values()][0];
  assert.deepEqual([row.kind, row.label, row.source, row.attempts], ['tool_call', 'Lookup', 'mcp', 1]);
  assert.equal(row.input.api_key, '[redacted]');
  assert(!JSON.stringify(row).includes('THOUGHT'));
  assert.match(row.output!, /evidence/);
  assert.ok(row.finished_at && row.latency_ms !== null);
  assert(!JSON.stringify(row).includes('synthetic final answer'));
});

test('a denied call is cancelled and never runs', async () => {
  const out = sink(); let calls = 0;
  const agent = new Agent({ model: syntheticModel('lookup'), printer: false, tools: [candidate(() => { calls++; })] });
  installToolCallTracker(agent, out.write, { turnId: 'turn' });
  agent.addHook(BeforeToolCallEvent, e => { e.cancel = 'Denied'; });
  await agent.invoke('request');
  assert.equal(calls, 0);
  assert.equal([...out.rows.values()][0].status, 'cancelled');
});

test('an unknown tool is recorded as failed', async () => {
  const out = sink();
  const agent = new Agent({ model: syntheticModel('lookup'), printer: false });
  installToolCallTracker(agent, out.write, { turnId: 'turn' });
  await agent.invoke('request');
  assert.equal([...out.rows.values()][0].status, 'failed');
});

test('long provider ids are hashed, never cut, so shared prefixes stay distinct', async () => {
  for (const [id, expectHashed] of [['x'.repeat(192), true], ['s'.repeat(64), false], ['short-id', false]] as const) {
    const out = sink();
    const agent = new Agent({ model: syntheticModel('lookup', {}, id), printer: false, tools: [candidate(() => 'ok')] });
    installToolCallTracker(agent, out.write, { turnId: 'turn' });
    await agent.invoke('request');
    const row = [...out.rows.values()][0];
    assert.equal(row.tool_use_id.startsWith('tc_'), expectHashed);
    assert.ok(row.tool_use_id.length <= 64);
    assert.equal(new Set(out.writes.map(r => r.tool_use_id)).size, 1, 'every line of a call has the same id');
  }
  const a = sink(), b = sink();
  for (const [out, id] of [[a, 'x'.repeat(191) + 'a'], [b, 'x'.repeat(191) + 'b']] as const) {
    const agent = new Agent({ model: syntheticModel('lookup', {}, id), printer: false, tools: [candidate(() => 'ok')] });
    installToolCallTracker(agent, out.write, { turnId: 'turn' });
    await agent.invoke('request');
  }
  assert.notEqual(a.writes[0].tool_use_id, b.writes[0].tool_use_id);
});

test('tool logs correlate the request without exposing provider thought signatures', async () => {
  const records: any[] = [];
  const originalLog = Logger.prototype.log;
  Logger.prototype.log = function (message: any) { records.push(JSON.parse(String(message))); };
  try {
    const id = 'call_test__thought__' + 'PRIVATE_SIGNATURE'.repeat(12);
    await withTraceContext({ trace_id: 'tool-trace', conversation_id: 'conversation', turn_id: 'turn' }, async () => {
      const agent = new Agent({ model: syntheticModel('lookup', {}, id), printer: false, tools: [candidate(() => 'PRIVATE_TOOL_OUTPUT')] });
      installToolCallTracker(agent, sink().write, { turnId: 'turn' });
      await agent.invoke('PRIVATE_INPUT');
    });
    const completed = records.find(row => row.event === 'tool_call_completed');
    assert.equal(completed.trace_id, 'tool-trace');
    assert.equal(completed.turn_id, 'turn');
    assert(completed.tool_call_id && completed.tool_call_id.length <= 64);
    assert(records.some(row => row.event === 'tool_call_started'));
    assert(!JSON.stringify(records).match(/PRIVATE_|__thought__/));
  } finally { Logger.prototype.log = originalLog; }
});
