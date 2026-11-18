/** Opt-in only: needs an already provisioned disposable test database. Never applies schema. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { TurnRepository } from '../src/db/turn.repository';
import { RetrievalRepository } from '../src/retrieval/retrieval.repository';
import { TurnEventRepository } from '../src/db/turn-event.repository';
import { DocumentRepository } from '../src/db/document.repository';
import { SkillRepository } from '../src/db/skill.repository';
import { StatsRepository } from '../src/stats/stats.repository';
import { StatsService } from '../src/stats/stats.service';

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
    // A conversation without a subject is its creator's only.
    await assert.rejects(turns.startTurn({conversationId:conversation.id,memberId:foreignId,userText:'foreign',modelId:'test'}),(e:any)=>e?.code==='not_found');
    const input = {conversationId:conversation.id,memberId:actorId,userText:'question',modelId:'test'};
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
    assert.equal((await turns.getRecentMessages(conversation.id,20)).length,1);
    assert.equal(stored.memberId,actorId);
    // A record's conversation is shared: another member may ask, and the turn records them.
    const shared = await db.conversation.create({data:{actorId,subjectKind:'ticket',subjectId:randomUUID()}});
    const foreignTurn = await turns.startTurn({conversationId:shared.id,memberId:foreignId,userText:'shared',modelId:'test'});
    assert.equal((await db.turn.findUniqueOrThrow({where:{id:foreignTurn.id}})).memberId,foreignId);
    await assert.rejects(db.conversation.create({data:{actorId:foreignId,subjectKind:'ticket',subjectId:shared.subjectId}}),'one conversation per record');
    await turns.finishTurn({turnId:foreignTurn.id,status:'SUCCEEDED',answer:'ok',sources:[{n:1,kind:'ticket',record_id:shared.subjectId!,label:'Ticket',meta:'',facts:[],quote:'',call_id:'c',tool:'ticket_get'}],latencyMs:1});
    const stuck = await turns.startTurn({conversationId:shared.id,memberId:actorId,userText:'stuck',modelId:'test',deadlineMs:60_000});
    await db.turn.update({where:{id:stuck.id},data:{startedAt:new Date(Date.now()-3_600_000),runStartedAt:new Date(Date.now()-3_600_000)}});
    assert.ok((await turns.findStuck(new Date(),30_000)).some(t=>t.id===stuck.id));
    // A turn within its own longer deadline is not stuck.
    await db.turn.update({where:{id:stuck.id},data:{deadlineMs:300_000,runStartedAt:new Date(Date.now()-200_000)}});
    assert.ok(!(await turns.findStuck(new Date(),30_000)).some(t=>t.id===stuck.id));

    // Runs: events with seq, pause and continue, a document with versions, a tool call with its id.
    const events = new TurnEventRepository(db as any);
    const [e1,e2] = await Promise.all([events.append(stuck.id,'turn.started',{model:'m'}),events.append(stuck.id,'usage',{input_tokens:1})]);
    assert.deepEqual([e1.seq,e2.seq].sort(),[1,2],'seq is handed out once per event');
    assert.deepEqual((await events.after(stuck.id,1,10)).map(e=>e.seq),[2]);
    assert.deepEqual((await events.after(stuck.id,0,10,1)).map(e=>e.type),[[e1,e2].find(e=>e.seq===1)!.type]);
    const state:any = {v:1,wrote:true,messages:[],sources:[],steps:[],agent_config:{}};
    assert.equal(await turns.checkpoint(stuck.id,state),true);
    assert.equal(await turns.suspend(stuck.id,'PAUSED',state,{inputTokens:5,costUsd:0.5},10),true);
    assert.equal(await turns.statusOf(stuck.id),'PAUSED');
    await assert.rejects(turns.startTurn({...input,conversationId:shared.id}),(e:any)=>e?.code==='turn_in_progress','a paused turn holds its conversation');
    assert.ok(await turns.claim(stuck.id,['PAUSED'],60_000));
    await turns.addUserBlock(stuck.id,'only last week',{steer_id:'s1'});
    const callId = randomUUID();
    await turns.saveToolCall({id:callId,turnId:stuck.id,toolUseId:'tc-1',toolName:'ticket_get',input:{},status:'running'});
    await turns.saveToolCall({turnId:stuck.id,toolUseId:'tc-1',toolName:'ticket_get',input:{},status:'success',attempts:2,timing:{queued:1},finishedAt:new Date(),content:[{text:'{}'}]});
    await turns.saveToolCall({turnId:stuck.id,toolUseId:'tc-1',toolName:'ticket_get',input:{},status:'success',attempts:2,label:'Ticket',
      attemptErrors:[{attempt:1,error:'ECONNRESET',at:new Date().toISOString()}],content:[{text:'{}'}]});
    const call = await turns.findToolCall(callId,actorId);
    assert.equal(call?.attempts,2);
    assert.equal(call?.toolLabel,'Ticket');
    assert.deepEqual((call?.attemptErrors as any[]).map(e=>e.error),['ECONNRESET']);

    // Settings figures straight from the tables.
    await events.append(stuck.id,'guardrail',{rule:'loop_stopped',detail:'ticket_get repeated'});
    const stats = new StatsService(new StatsRepository(db as any));
    const tools = await stats.tools('7d');
    const ticket = tools.items.find(i=>i.name==='ticket_get');
    assert.ok(ticket && ticket.calls>=1 && ticket.days.length===7);
    assert.equal(ticket!.days.at(-1)!.date,new Date().toISOString().slice(0,10));
    assert.ok(ticket!.days.at(-1)!.calls>=1,'today counts the call');
    assert.ok(tools.recent.some(r=>r.call_id===callId && r.member_id===actorId && r.label==='Ticket'));
    assert.ok(tools.recent.length<=20);
    const guard = await stats.guardrails('30d');
    assert.ok(guard.items.some(i=>i.rule==='loop_stopped' && i.count>=1));
    assert.ok(guard.recent.some(r=>r.turn_id===stuck.id && r.member_id===actorId && r.detail==='ticket_get repeated'));
    const byTurns = await stats.turns('90d');
    assert.equal(byTurns.by_agent.find(a=>a.agent_id===null)?.days.length,90,'turns without an agent count as the default agent');
    assert.ok((byTurns.by_member.find(m=>m.member_id===foreignId)?.requests ?? 0)>=1);
    const docs = new DocumentRepository(db as any);
    const v1 = await docs.write({conversationId:shared.id,turnId:stuck.id,memberId:actorId,title:'R',sections:[{kind:'markdown',markdown:'# R'}]});
    const v2 = await docs.write({conversationId:shared.id,turnId:stuck.id,memberId:actorId,title:'R2',sections:[{kind:'markdown',markdown:'# R2'}],documentId:v1!.document_id});
    assert.equal(v2?.version,2);
    assert.equal(await docs.write({conversationId:conversation.id,turnId:stuck.id,memberId:actorId,title:'X',sections:[{kind:'markdown',markdown:'x'}],documentId:v1!.document_id}),null,'a document of another chat');
    assert.equal(await docs.exists(shared.id,v1!.document_id,2),true);
    assert.deepEqual((await docs.findVisible(v1!.document_id,foreignId))?.versions.map(v=>v.version),[2,1]);
    await turns.finishTurn({turnId:stuck.id,status:'FAILED',answer:'broken',latencyMs:1,errorCode:'agent_failed',state});
    const reopened = await turns.claim(stuck.id,['FAILED'],60_000,t=>t.latest && t.errorCode==='agent_failed');
    assert.ok(reopened,'a failed latest turn reopens');
    assert.equal((await db.message.findMany({where:{turnId:stuck.id,blocks:{some:{isTerminal:true}}}})).length,0,'the failed answer goes when it reopens');
    await turns.finishTurn({turnId:stuck.id,status:'SUCCEEDED',answer:'done',latencyMs:1,costUsd:0.25,firstTokenMs:120,provider:'api.test',state});
    const skills = new SkillRepository(db as any);
    const slug = `s-${randomUUID().slice(0,8)}`;
    const skill = await skills.create(actorId,{name:'S',slug,description:'',prompt:'p',variables:[{name:'from'}]});
    await assert.rejects(skills.create(actorId,{name:'S',slug,description:'',prompt:'p',variables:[]}),(e:any)=>e?.code==='skill_exists');
    assert.equal((await skills.update(skill.id,{name:'S2'})).name,'S2');
    assert.equal(await skills.delete(skill.id),true);
    const second = await turns.startTurn(input);
    assert.equal(second.ordinal,1);
    await turns.finishTurn({turnId:second.id,status:'SUCCEEDED',answer:'done',latencyMs:1});
    await db.turn.createMany({data:Array.from({length:47},(_,i)=>({conversationId:conversation.id,memberId:actorId,ordinal:i+2,status:'SUCCEEDED' as const,startedAt:new Date(0),finishedAt:new Date(0),modelId:'test'}))});
    const last = await turns.startTurn(input);
    assert.equal(last.ordinal,49);
    await assert.rejects(turns.startTurn(input),(e:any)=>e?.code==='turn_in_progress');
    await turns.finishTurn({turnId:last.id,status:'SUCCEEDED',answer:'last',latencyMs:1});
    // A shared conversation has no turn cap: the 51st turn opens.
    assert.equal((await turns.startTurn(input)).ordinal,50);
    const embedding=Array(1024).fill(0.01);
    const memory=await retrieval.insertMemory({actorId,origin:'STATEMENT',kind:'PREFERENCE',content:'Prefers blue shoes',importance:3,embedding});
    await retrieval.insertMemory({actorId:foreignId,origin:'STATEMENT',kind:'FACT',content:'Foreign blue shoes',importance:3,embedding});
    const replacement=await retrieval.supersedeMemory({actorId,previousMemoryId:memory.id,content:'Prefers red shoes',embedding});
    const hits=await retrieval.searchMemories({actorId,query:'shoes',queryEmbedding:embedding,limit:10});
    assert(hits.some(h=>h.id===replacement.id));
    assert(hits.every(h=>h.actorId===actorId && h.id!==memory.id));
    await assert.rejects(retrieval.supersedeMemory({actorId,previousMemoryId:memory.id,content:'stale correction',embedding}));
    console.log('Database integration passed: ownership, shared subjects, member on turns, stuck turns, events, pause and continue, documents, skills, concurrent starts, ordinal, terminal idempotence, late tools, hybrid retrieval and supersession');
  } finally {
    // Only fixtures created by this run, never schema reset or shared rows.
    await db.turn.deleteMany({where:{memberId:{in:[actorId,foreignId]}}});
    await db.actor.deleteMany({where:{id:{in:[actorId,foreignId]}}});
    await db.$disconnect();
  }
}
main().catch(e=>{console.error(e);process.exitCode=1;});
