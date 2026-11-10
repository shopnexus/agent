/** Opt-in only: needs an already provisioned disposable test database. Never applies schema. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { TurnRepository } from '../src/db/turn.repository';
import { RetrievalRepository } from '../src/retrieval/retrieval.repository';

async function main() {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) { console.log('SKIP database integration: TEST_DATABASE_URL is not set'); return; }
  const db = new PrismaClient({datasourceUrl:url});
  const actorId = `integration-${randomUUID()}`;
  const foreignId = `foreign-${randomUUID()}`;
  const turns = new TurnRepository(db as any);
  const retrieval = new RetrievalRepository(db as any);
  try {
    await db.actor.createMany({data:[{id:actorId},{id:foreignId}]});
    const conversation = await db.conversation.create({data:{actorId}});
    await assert.rejects(turns.startTurn({conversationId:conversation.id,actorId:foreignId,userText:'foreign',modelId:'test'}));
    const input = {conversationId:conversation.id,actorId,userText:'question',modelId:'test'};
    const attempts = await Promise.allSettled([turns.startTurn(input),turns.startTurn(input)]);
    assert.equal(attempts.filter(x => x.status === 'fulfilled').length,1);
    const turn = (attempts.find(x => x.status === 'fulfilled') as PromiseFulfilledResult<{id:string;ordinal:number}>).value;
    assert.equal(turn.ordinal,0);
    await turns.saveToolCall({turnId:turn.id,toolUseId:'call-1',toolName:'lookup',input:{id:'p1'},status:'running'});
    await turns.finishTurn({turnId:turn.id,status:'TIMED_OUT',answer:'verified fallback',latencyMs:5});
    await turns.finishTurn({turnId:turn.id,status:'SUCCEEDED',answer:'must not overwrite',latencyMs:6});
    await turns.saveToolCall({turnId:turn.id,toolUseId:'call-1',toolName:'lookup',input:{id:'p1'},status:'success',content:[{text:'late evidence'}]});
    const stored = await db.turn.findUniqueOrThrow({where:{id:turn.id},include:{messages:{include:{blocks:true}},toolCalls:true}});
    assert.equal(stored.status,'TIMED_OUT');
    assert.equal(stored.toolCalls.length,1);
    assert.equal(stored.toolCalls[0].status,'success');
    assert.deepEqual(stored.messages.flatMap(m=>m.blocks).filter(b=>b.isTerminal).map(b=>b.text),['verified fallback']);
    assert.equal(stored.messages.flatMap(m=>m.blocks).filter(b=>b.kind==='TOOL_RESULT').length,1);
    assert.equal((await turns.getRecentMessages(conversation.id,foreignId,20)).length,0);
    const second = await turns.startTurn(input);
    assert.equal(second.ordinal,1);
    await turns.finishTurn({turnId:second.id,status:'SUCCEEDED',answer:'done',latencyMs:1});
    await db.turn.createMany({data:Array.from({length:47},(_,i)=>({conversationId:conversation.id,ordinal:i+2,status:'SUCCEEDED' as const,finishedAt:new Date(),modelId:'test'}))});
    const last = await turns.startTurn(input);
    assert.equal(last.ordinal,49);
    assert.equal(await turns.getTurnCount(conversation.id),49);
    await assert.rejects(turns.startTurn(input),/unfinished turn/);
    await turns.finishTurn({turnId:last.id,status:'SUCCEEDED',answer:'last',latencyMs:1});
    await assert.rejects(turns.startTurn(input),/turn limit/);
    const embedding=Array(1024).fill(0.01);
    const memory=await retrieval.insertMemory({actorId,origin:'STATEMENT',kind:'PREFERENCE',content:'Prefers blue shoes',importance:3,embedding});
    await retrieval.insertMemory({actorId:foreignId,origin:'STATEMENT',kind:'FACT',content:'Foreign blue shoes',importance:3,embedding});
    const replacement=await retrieval.supersedeMemory({actorId,previousMemoryId:memory.id,content:'Prefers red shoes',embedding});
    const hits=await retrieval.searchMemories({actorId,query:'shoes',queryEmbedding:embedding,limit:10});
    assert(hits.some(h=>h.id===replacement.id));
    assert(hits.every(h=>h.actorId===actorId && h.id!==memory.id));
    await assert.rejects(retrieval.supersedeMemory({actorId,previousMemoryId:memory.id,content:'stale correction',embedding}));
    console.log('Database integration passed: ownership, concurrent starts, ordinal, terminal idempotence, late tools, hybrid retrieval and supersession');
  } finally {
    // Only fixtures created by this run, never schema reset or shared rows.
    await db.actor.deleteMany({where:{id:{in:[actorId,foreignId]}}});
    await db.$disconnect();
  }
}
main().catch(e=>{console.error(e);process.exitCode=1;});
