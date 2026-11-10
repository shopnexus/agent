import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Agent, BeforeToolCallEvent, BeforeToolsEvent, tool } from '@strands-agents/sdk';
import { z } from 'zod';
import { installToolCallTracker } from '../src/agent/tool-call-tracker';
import { syntheticModel } from './tool-scope-test';
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
test('persistence failure prevents tool side effect',async()=>{
  let calls=0;
  const agent=new Agent({model:syntheticModel('lookup'),printer:false,tools:[candidate(()=>{calls++;return 'x';})]});
  const tracker=installToolCallTracker(agent,{saveToolCall:async()=>{throw new Error('offline DB');}} as any,{turnId:'turn'});
  await assert.rejects(agent.invoke('request'));await assert.rejects(tracker.flush());assert.equal(calls,0);
});
