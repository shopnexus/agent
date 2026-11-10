import assert from 'node:assert/strict';
import { RetrievalService } from '../src/retrieval/retrieval.service';

async function main() {
  const saved:any[]=[];
  const repository:any={insertMemory:async (v:any)=>{saved.push(v);return {...v,id:'memory-1'};},findCurrentMemory:async()=>null,
    insertDocument:async (v:any[])=>{saved.push(...v);return v.map((x,i)=>({...x,id:String(i)}));},searchMemories:async()=>[]};
  const vector=Array(1024).fill(0);vector[0]=1;
  const service=new RetrievalService(repository,{embed:async()=>vector} as any);
  const fact=await service.saveMemory({actorId:'alice',kind:'FACT',content:'User name is Huy'});
  assert.equal(fact.kind,'FACT');
  assert.equal(saved[0].actorId,'alice');
  await assert.rejects(()=>service.saveMemory({actorId:'alice',kind:'FACT',content:'password: abcdef'}));
  await assert.rejects(()=>service.supersedeMemory({actorId:'alice',previousMemoryId:'ffffffff-ffff-4fff-8fff-ffffffffffff',content:'New name'}));
  for(const bad of [Array(1024).fill(0),[1],Array(1024).fill(NaN)]) {
    await assert.rejects(()=>new RetrievalService(repository,{embed:async()=>bad} as any).saveMemory({actorId:'a',kind:'FACT',content:'My name is Huy'}));
  }
  const chunks=await service.ingestDocument({actorId:'alice',documentId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',text:'Document paragraph. '.repeat(200),documentTitle:'Guide',sourceUri:'https://shopnexus.hopto.org/guide'});
  assert(chunks.length>1);
  assert(chunks.every((x:any)=>x.origin==='EXCERPT' && x.kind===null && x.documentTitle==='Guide'));
  assert.deepEqual(chunks.map((x:any)=>x.chunkIndex),chunks.map((_:any,i:number)=>i));
  console.log('retrieval validation and ingestion tests passed');
}
main().catch(e=>{console.error(e);process.exitCode=1;});
