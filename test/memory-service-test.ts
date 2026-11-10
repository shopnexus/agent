import assert from 'node:assert/strict';
import { RetrievalService } from '../src/retrieval/retrieval.service';
import { RetrievalRecord, MemorySaveInput } from '../src/retrieval/types';
import { AgentController } from '../src/agent/agent.controller';
async function main() {
  const id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const old:RetrievalRecord={id,actorId:'actor-a',origin:'STATEMENT',kind:'FACT',content:'Shoe size 40',importance:4};
  let target:RetrievalRecord|null=old;const writes:any[]=[];
  let bad:number[]|undefined;
  const service=new RetrievalService({insertMemory:async(p:any)=>{writes.push(p);return {...p,id};},findCurrentMemory:async()=>target,
    supersedeMemory:async(p:any)=>{writes.push(p);return {...old,content:p.content};},searchMemories:async()=>[]} as any,{embed:async()=>bad ?? Array(1024).fill(0.1)} as any);
  const save:MemorySaveInput={actorId:'actor-a',kind:'FACT',content:'  Name: Alex  '};
  await service.saveMemory(save);assert.equal(writes[0].content,'Name: Alex');assert.equal(writes[0].origin,'STATEMENT');
  await service.saveMemory({...save,kind:'PREFERENCE',content:'Prefers Vietnamese'});
  await service.supersedeMemory({actorId:'actor-a',previousMemoryId:id,content:'Shoe size 41'});
  assert.equal(writes[2].previousMemoryId,id);
  for(const content of ['password: secret','order status is shipped','','x'.repeat(501),'email a@example.com']) {
    const n=writes.length;await assert.rejects(service.saveMemory({...save,content}));
    await assert.rejects(service.supersedeMemory({actorId:'actor-a',previousMemoryId:id,content}));assert.equal(writes.length,n);
  }
  for(const invalid of [{importance:0},{importance:6},{importance:1.5},{expiresAt:new Date(0)},{expiresAt:new Date('bad')}])await assert.rejects(service.saveMemory({...save,...invalid}));
  for(target of [null,{...old,actorId:'foreign'},{...old,origin:'EXCERPT' as const},{...old,deletedAt:new Date()},{...old,supersededAt:new Date()},{...old,expiresAt:new Date(0)}])await assert.rejects(service.supersedeMemory({actorId:'actor-a',previousMemoryId:id,content:'Size 42'}));
  target=old;
  for(bad of [[1],Array(1024).fill(NaN),Array(1024).fill(0)]) {
    await assert.rejects(service.saveMemory(save),/1024-dimensional/);
    await assert.rejects(service.searchMemory('actor-a','name'),/1024-dimensional/);
    await assert.rejects(service.supersedeMemory({actorId:'actor-a',previousMemoryId:id,content:'Size 42'}),/1024-dimensional/);
  }
  let actor='',owner='';
  const controller=new AgentController({chat:async(a:string,c:string)=>{actor=a;return {actorId:a,conversationId:c,answer:'ok'};}} as any,
    {newConversation:async(a:string)=>{owner=a;return id;}} as any);
  await controller.chat({message:'hello',context:{actorId:'forged'}},{header:()=> 'trusted'} as any);
  assert.equal(actor,'trusted');assert.equal(owner,'trusted');
  console.log('Memory service tests passed on retrieval schema');
}
main().catch(e=>{console.error(e);process.exitCode=1;});
