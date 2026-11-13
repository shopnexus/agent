import assert from 'node:assert/strict';
import { TurnRepository } from '../src/db/turn.repository';
import { ConversationContextService } from '../src/memory/conversation-context.service';

async function main() {
  // Only the database boundary is fake; exercise real repository normalization
  // and real transcript replay. Restoring the 64-character rejection must fail.
  const calls = new Map<string, any>();
  const messages: any[] = [];
  const tx = {
    $queryRaw: async () => [{conversationId:'conversation', status:'RUNNING'}],
    toolCall: {
      findUnique: async ({where}: any) => calls.get(where.turnId_toolUseId.toolUseId) ?? null,
      upsert: async ({where,create,update}: any) => {
        const id = where.turnId_toolUseId.toolUseId;
        assert(id.length <= 64, 'audit IDs must fit the SQL column');
        calls.set(id, calls.has(id) ? {...calls.get(id),...update} : create);
      },
    },
    message: {
      findFirst: async ({where}: any) => messages.find(m => m.blocks.some((b: any) => b.toolUseId === where.blocks.some.toolUseId)) ?? null,
      aggregate: async () => ({_max:{ordinal:messages.length ? messages.length-1 : null}}),
      create: async ({data}: any) => {
        const row = {...data,id:`message-${messages.length}`,blocks:[data.blocks.create]};
        assert(row.blocks[0].toolUseId.length <= 64, 'transcript IDs must fit the SQL column');
        messages.push(row); return row;
      },
    },
    messageBlock: {
      upsert: async ({create,update}: any) => {
        const row = messages.find(m => m.id === create.messageId);
        const prior = row.blocks.find((b: any) => b.eventSeq === create.eventSeq);
        if (prior) Object.assign(prior,update); else row.blocks.push(create);
      },
    },
  };
  const repository = new TurnRepository({$transaction:async (fn: any) => fn(tx)} as any);
  const longId = 'x'.repeat(192);
  for (const id of [longId, 'x'.repeat(191)+'y', 'short-id', 's'.repeat(64)]) {
    const input = {turnId:'turn',toolUseId:id,toolName:'search_products',input:{query:'headphones'}};
    await repository.saveToolCall({...input,status:'pending'});
    await repository.saveToolCall({...input,status:'running'});
    await repository.saveToolCall({...input,status:'success',content:[{text:'evidence'}]});
    assert.equal(input.toolUseId,id,'live provider identity must not be mutated');
  }
  assert.equal(calls.size,4,'distinct long IDs must not merge; lifecycle updates must reuse their ID');
  assert.equal(messages.length,4,'each logical call must have one tool-use message');
  assert(calls.has('short-id'),'short IDs remain backward compatible');
  assert(calls.has('s'.repeat(64)),'64-character IDs remain unchanged');
  for (const [id,call] of calls) {
    assert.equal(call.status,'success');
    const message = messages.find(m => m.blocks[0].toolUseId === id);
    assert.equal(message.blocks[1].toolUseId,id,'tool result must pair with the stored use');
  }
  const replay = new ConversationContextService().build([{ordinal:0,status:'SUCCEEDED',messages}] as any,40);
  assert.equal(replay.length,8,'all four stored pairs must replay');
  assert(!JSON.stringify(replay).includes(longId),'replay uses the bounded storage identity');
  await assert.rejects(repository.saveToolCall({turnId:'turn',toolUseId:' ',toolName:'search_products',input:{},status:'pending'}),/Invalid tool identity/);
  console.log('Tool identity regression passed (192-character IDs, shared prefixes, lifecycle, replay, short IDs)');
}
main().catch(error=>{console.error(error);process.exitCode=1;});
