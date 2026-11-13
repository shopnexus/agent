import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Agent, BeforeToolCallEvent, BeforeToolsEvent, tool } from '@strands-agents/sdk';
import { z } from 'zod';
import { installToolCallTracker } from '../src/agent/tool-call-tracker';
import { syntheticModel } from './tool-scope-test';
import { Logger } from '@nestjs/common';
import { withTraceContext } from '../src/observability/trace-context';
const candidate=(callback:()=>any)=>tool({name:'lookup',description:'offline',inputSchema:z.object({}).passthrough(),callback});
function boundary() {
  const writes:any[]=[];const rows=new Map<string,any>();
  return {writes,rows,repository:{saveToolCall:async(p:any)=>{const copy=structuredClone(p);writes.push(copy);rows.set(`${p.turnId}:${p.toolUseId}`,copy);}} as any};
}
test('persists native tool events before callback, bounded/redacted snapshots, no final draft',async()=>{
  const db=boundary();let started=false;
  const agent=new Agent({model:syntheticModel('lookup',{query:'PRIVATE',api_key:'SECRET',reasoning:'THOUGHT'}),printer:false,tools:[candidate(()=>{
    assert.equal(db.rows.size,1);assert.equal([...db.rows.values()][0].status,'running');started=true;return {answer:'evidence'};
  })]});
  const tracker=installToolCallTracker(agent,db.repository,{turnId:'turn',maxPayloadChars:256});
  await agent.invoke('request');await tracker.flush();
  assert(started);assert.deepEqual(db.writes.map(r=>r.status),['pending','running','success']);
  assert.equal(db.rows.size,1);const row=[...db.rows.values()][0];
  assert.equal(row.input.api_key,'[redacted]');assert(!JSON.stringify(row).includes('THOUGHT'));
  assert.match(row.output,/evidence/);assert(!JSON.stringify(row).includes('synthetic final answer'));
});
test('denied callback is cancelled and never executes',async()=>{
  const db=boundary();let calls=0;
  const agent=new Agent({model:syntheticModel('lookup'),printer:false,tools:[candidate(()=>{calls++;})]});
  installToolCallTracker(agent,db.repository,{turnId:'turn'});
  agent.addHook(BeforeToolCallEvent,e=>{e.cancel='Denied';});
  await agent.invoke('request');assert.equal(calls,0);assert.equal([...db.rows.values()][0].status,'cancelled');
});
test('unknown tool result is recorded as failed',async()=>{
  const db=boundary();const agent=new Agent({model:syntheticModel('lookup'),printer:false});
  installToolCallTracker(agent,db.repository,{turnId:'turn'});
  await agent.invoke('request');assert.equal([...db.rows.values()][0].status,'failed');
});
test('late completion updates logical call without creating another row',async()=>{
  const db=boundary();let release!:()=>void,started!:()=>void;
  const ready=new Promise<void>(r=>{started=r;});const gate=new Promise<void>(r=>{release=r;});
  const agent=new Agent({model:syntheticModel('lookup'),printer:false,tools:[candidate(async()=>{started();await gate;return 'late';})]});
  const tracker=installToolCallTracker(agent,db.repository,{turnId:'turn'});
  const invoke=agent.invoke('request');await ready;await tracker.flush();assert.equal([...db.rows.values()][0].status,'running');
  release();await invoke;await tracker.flush();assert.equal(db.rows.size,1);assert.equal([...db.rows.values()][0].status,'success');
});
test('tool logs correlate request without exposing provider thought signatures',async()=>{
  const records:any[]=[];
  const originalLog=Logger.prototype.log,originalError=Logger.prototype.error;
  Logger.prototype.log=function(message:any) { records.push(JSON.parse(String(message))); };
  Logger.prototype.error=function(message:any) { records.push(JSON.parse(String(message))); };
  try {
    const id='call_test__thought__'+'PRIVATE_SIGNATURE'.repeat(12);
    await withTraceContext({trace_id:'tool-trace',conversation_id:'conversation',turn_id:'turn'},async()=>{
      const db=boundary();
      const agent=new Agent({model:syntheticModel('lookup',{},id),printer:false,tools:[candidate(()=>'PRIVATE_TOOL_OUTPUT')]});
      const tracker=installToolCallTracker(agent,db.repository,{turnId:'turn'});
      await agent.invoke('PRIVATE_INPUT');await tracker.flush();
    });
    const completed=records.find(row=>row.event==='tool_call_completed');
    assert.equal(completed.trace_id,'tool-trace');
    assert.equal(completed.turn_id,'turn');
    assert(completed.tool_call_id && completed.tool_call_id.length<=64);
    assert(records.some(row=>row.event==='tool_call_started'));
    assert(!JSON.stringify(records).match(/PRIVATE_|__thought__/));
    records.length=0;
    const agent=new Agent({model:syntheticModel('lookup'),printer:false,tools:[candidate(()=>'never')]});
    const tracker=installToolCallTracker(agent,{saveToolCall:async()=>{throw Object.assign(new Error('PRIVATE_DB'),{code:'P2024'});}} as any,{turnId:'turn'});
    await assert.rejects(agent.invoke('request'));await assert.rejects(tracker.flush());
    const failure=records.find(row=>row.event==='tool_call_persistence_failed');
    assert.equal(failure.code,'P2024');
    assert.equal(failure.stage,'tool_audit');
    assert(!JSON.stringify(records).includes('PRIVATE_DB'));
  } finally { Logger.prototype.log=originalLog;Logger.prototype.error=originalError; }
});
test('persistence failure prevents tool side effect',async()=>{
  let calls=0;
  const agent=new Agent({model:syntheticModel('lookup'),printer:false,tools:[candidate(()=>{calls++;return 'x';})]});
  const tracker=installToolCallTracker(agent,{saveToolCall:async()=>{throw new Error('offline DB');}} as any,{turnId:'turn'});
  await assert.rejects(agent.invoke('request'));await assert.rejects(tracker.flush());assert.equal(calls,0);
});
