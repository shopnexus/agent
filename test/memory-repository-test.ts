import assert from 'node:assert/strict';
import { RetrievalRepository } from '../src/retrieval/retrieval.repository';
import { RetrievalRecord } from '../src/retrieval/types';
async function main() {
  const queries:Array<{text:string;values:any[]}>=[];
  const old:RetrievalRecord={id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',actorId:'actor-a',origin:'STATEMENT',kind:'FACT',content:'Size 40',importance:4};
  let target:RetrievalRecord|null=old,linked=false;
  const query=async(strings:any,...values:any[])=>{
    const text=strings.strings?strings.strings.join('?'):strings.join('?');
    queries.push({text,values:Array.isArray(strings.values) ? strings.values : values});
    if(text.includes('INSERT INTO'))return [{...old,id:'new'}];
    if(text.includes('WITH active'))return [{...old,score:'0.03'}];
    return target?[target]:[];
  };
  const tx={$queryRaw:query,retrieval:{update:async()=>{linked=true;}}};
  const repository=new RetrievalRepository({...tx,$transaction:async(fn:any)=>fn(tx)} as any);
  await repository.insertMemory({actorId:'actor-a',origin:'STATEMENT',kind:'FACT',importance:3,content:'Size 40',embedding:Array(1024).fill(0.1)});
  assert.match(queries[0].text,/INSERT INTO retrieval/);assert(queries[0].values.includes('actor-a'));
  queries.length=0;
  await repository.supersedeMemory({actorId:'actor-a',previousMemoryId:old.id,content:'Size 41',embedding:Array(1024).fill(0.1)});
  assert.match(queries[0].text,/actor_id=[\s\S]*superseded_at IS NULL[\s\S]*FOR UPDATE/);
  assert.equal(linked,true);assert.equal(queries.filter(q=>q.text.includes('INSERT')).length,1);
  target=null;queries.length=0;
  await assert.rejects(repository.supersedeMemory({actorId:'actor-a',previousMemoryId:old.id,content:'Size 42',embedding:[1]}));
  assert(!queries.some(q=>q.text.includes('INSERT')));
  queries.length=0;
  const hits=await repository.searchMemories({actorId:'actor-a',query:'size',queryEmbedding:Array(1024).fill(.1),limit:3,origin:'STATEMENT'});
  assert.equal(hits[0].score,.03);
  const sql=queries[0];assert.match(sql.text,/active AS MATERIALIZED/);assert.match(sql.text,/actor_id=.*superseded_at IS NULL AND deleted_at IS NULL/);
  assert.match(sql.text,/expires_at>NOW\(\)/);assert.match(sql.text,/plainto_tsquery/);assert.match(sql.text,/similarity/);assert(sql.values.includes('actor-a'));assert(sql.values.includes('STATEMENT'));
  console.log('Retrieval repository SQL contract tests passed (mocked DB, not integration)');
}
main().catch(e=>{console.error(e);process.exitCode=1;});
