import 'reflect-metadata';
import assert from 'node:assert/strict';
import { PATH_METADATA } from '@nestjs/common/constants';
import { memorySearchTool, memorySaveTool, memorySupersedeTool } from '../src/memory/memory-client';
import { AgentController } from '../src/agent/agent.controller';

async function main() {
  const calls: any[] = [];
  const memory = {
    saveMemory: async (p: any) => { calls.push(p); return { id: 'new' }; },
    supersedeMemory: async (p: any) => { calls.push(p); return { id: 'corrected' }; },
    searchMemory: async (actorId: string, query: string, limit?: number) => { calls.push({ actorId, query, limit }); return [{ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', origin: 'STATEMENT', kind: 'FACT', content: 'Size 40' }]; },
  } as any;
  const tools = [memorySearchTool(memory, 'trusted'), memorySaveTool(memory, 'trusted'), memorySupersedeTool(memory, 'trusted')] as const;
  assert.deepEqual(tools.map(t => t.name), ['memory_search', 'memory_save', 'memory_supersede']);
  const result = await tools[0].invoke({ query: 'shoe size', limit: 3, actorId: 'forged' } as never);
  assert.ok(JSON.stringify(result).includes('STATEMENT')); assert.ok(JSON.stringify(result).includes('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'));
  await tools[1].invoke({ kind: 'FACT', content: 'Name Alex', importance: 3, actorId: 'forged' } as never);
  await tools[2].invoke({ previousMemoryId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', content: 'Shoe size 41', actorId: 'forged' } as never);
  assert.ok(calls.every(p => p.actorId === 'trusted'));
  const n = calls.length;
  await assert.rejects(tools[0].invoke({ query: '   ' }));
  assert.equal(calls.length, n);
  memory.saveMemory = async () => { throw new Error('PRIVATE_DB_ERROR'); };
  memory.supersedeMemory = memory.saveMemory;
  await assert.rejects(tools[1].invoke({ kind: 'FACT', content: 'Name Alex', importance: 3 }), /not saved/i);
  await assert.rejects(tools[2].invoke({ previousMemoryId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', content: 'Shoe size 41' }), /not corrected/i);
  await assert.rejects(tools[1].invoke({ kind: 'FACT', content: 'Name Alex', importance: 3, expiresAt: 'bad-date' }), /not saved|timestamp/i);
  const routes = Object.getOwnPropertyNames(AgentController.prototype).filter(name => name !== 'constructor').map(name => Reflect.getMetadata(PATH_METADATA, (AgentController.prototype as any)[name]));
  assert.deepEqual(routes.sort(), ['chat', 'conversations', 'conversations']);
  console.log('Memory tools tests passed (exact surface, actor-bound callbacks, errors and route removal)');
}
main().catch(e => { console.error(e); process.exitCode = 1; });
