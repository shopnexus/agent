import assert from 'node:assert/strict';
import { ConflictException } from '@nestjs/common';
import { TurnRepository } from '../src/db/turn.repository';
import { makeAgentScopeHarness } from './helpers/agent-scope-harness';

async function main() {
  let statuses = [...Array<string>(49).fill('SUCCEEDED'), 'RUNNING'];
  let creates = 0;
  const tx = {
    $queryRaw: async () => [{id:'conversation',status:'active'}],
    turn: {
      count: async ({where}: any) => statuses.filter(status => !where.status?.notIn?.includes(status)).length,
      findFirst: async () => statuses.some(status=>['RUNNING','AWAITING_INPUT','AWAITING_APPROVAL'].includes(status)) ? {id:'running'} : null,
      aggregate: async () => ({_max:{ordinal:statuses.length-1}}),
      create: async () => { creates++; return {id:'unexpected',ordinal:statuses.length}; },
    },
    conversation:{update:async()=>{}},
  };
  const repo = new TurnRepository({...tx,$transaction:async(fn:any)=>fn(tx)} as any);
  const h=makeAgentScopeHarness();
  h.turns.getTurnCount=()=>repo.getTurnCount('conversation');
  h.turns.startTurn=()=>repo.startTurn({conversationId:'conversation',actorId:'actor',userText:'question',modelId:'test'});
  await assert.rejects(h.service.chat('actor','conversation','laptop',{actorId:'actor'}),
    e=>e instanceof ConflictException, 'the 50th RUNNING turn must conflict, not return a limit reply');
  assert.equal(creates,0);
  statuses=Array<string>(50).fill('SUCCEEDED');
  // A precheck may have seen 49 terminal turns just before another turn finished.
  // The locked start must independently enforce the final limit.
  await assert.rejects(repo.startTurn({conversationId:'conversation',actorId:'actor',userText:'question',modelId:'test'}),e=>e instanceof ConflictException);
  assert.equal(creates,0);
  const limit=await h.service.chat('actor','conversation','laptop',{actorId:'actor'});
  assert.match(limit.answer,/đạt giới hạn/);
  console.log('Turn-limit regression passed (service/repository boundary with mocked persistence; real concurrency requires DB integration)');
}
main().catch(e=>{console.error(e);process.exitCode=1;});
