/**
 * Offline: a turn's stream across replicas — the runner on one, the reader on
 * another, sharing the event store (PostgreSQL) and the run bus (Redis).
 * With REDIS_URL set, the same checks run on Redis (see redis-integration-test).
 */
import assert from 'node:assert/strict';
import { Logger } from '@nestjs/common';
import { tool } from '@strands-agents/sdk';
import { z } from 'zod';
import { MemoryTurnEventStore } from '../src/db/turn-event.repository';
import { MemoryRunBus, RunBus, eventsKey } from '../src/run/run-bus';
import { TurnStreamService, sseFrame } from '../src/run/turn-stream.service';
import type { TurnEvent } from '../src/run/events';
import { harness, FakeTurns, MEMBER, CONVERSATION, ORDER } from './helpers/agent-harness';

const collect = (stream: TurnStreamService, turnId: string, after: number, options = {}) => {
  const got: TurnEvent[] = [];
  const closed = new AbortController();
  const done = stream.stream(turnId, after, e => got.push(e), closed.signal, { blockMs: 200, idleCloseMs: 300, ...options });
  return { got, done, close: () => closed.abort() };
};

/** Runs the cross-replica checks on a bus pair: `busA` for the runner, `busB` for the reader. */
export async function crossReplica(busA: RunBus, busB: RunBus, label: string) {
  const store = new MemoryTurnEventStore();
  const turns = new FakeTurns();
  let release!: () => void;
  const gate = new Promise<void>(r => { release = r; });
  const waiting = tool({ name: 'case_get', description: 'Read a case', inputSchema: z.object({}), callback: async () => { await gate; return { case: { id: 'c-1', reason: 'Lừa đảo' } }; } });
  // Replica A runs the turn; replica B serves the reader and the controls.
  const a = harness([{ tools: [{ name: 'case_get' }] }, { text: 'Case c-1 [1].' }], { bus: busA, store, turns, tools: [waiting] });
  const b = harness([], { bus: busB, store, turns });

  const turnId = (await a.service.ask(MEMBER, CONVERSATION, { text: 'Ca này là gì?' })).turn_id;
  await a.waitFor(turnId, 'tool.started');
  // A reader that joins mid-run with Last-Event-ID 1 gets 2.. from PostgreSQL, then the rest live.
  const mid = collect(b.stream, turnId, 1);
  const early = collect(b.stream, turnId, 0);
  await new Promise(r => setTimeout(r, 50));
  release();
  await mid.done; await early.done;
  await a.runner.idle();
  const all = store.events.get(turnId)!;
  assert.deepEqual(early.got.map(e => e.seq), all.map(e => e.seq), `${label}: a reader from 0 gets every event once, in order`);
  assert.deepEqual(mid.got.map(e => e.seq), all.slice(1).map(e => e.seq), `${label}: Last-Event-ID replays only what came after`);
  assert.equal(early.got.at(-1)!.type, 'turn.finished', `${label}: the stream ends after turn.finished`);

  // After the turn: replay alone, then the stream closes.
  const late = collect(b.stream, turnId, 0);
  await late.done;
  assert.equal(late.got.length, all.length);
  const caught = collect(b.stream, turnId, all.at(-1)!.seq);
  await caught.done;
  assert.equal(caught.got.length, 0, `${label}: a reader already at the end closes at once`);

  // Pause sent through replica B reaches the runner on replica A.
  let release2!: () => void;
  const gate2 = new Promise<void>(r => { release2 = r; });
  const waiting2 = tool({ name: 'case_get', description: 'Read a case', inputSchema: z.object({}), callback: async () => { await gate2; return { case: { id: 'c-2' } }; } });
  const a2 = harness([{ tools: [{ name: 'case_get' }] }, { text: 'Never asked' }], { bus: busA, store, turns, tools: [waiting2] });
  const b2 = harness([{ text: 'Case c-2 [1].' }], { bus: busB, store, turns });
  const t2 = (await a2.service.ask(MEMBER, CONVERSATION, { text: 'x' })).turn_id;
  await a2.waitFor(t2, 'tool.started');
  const reader = collect(b2.stream, t2, 0);
  await b2.actions.pause(MEMBER, t2);
  await a2.waitFor(t2, 'turn.pausing');
  release2();
  await a2.runner.idle();
  await reader.done;
  assert.equal(turns.rows.get(t2).status, 'PAUSED', `${label}: a pause from another replica`);
  assert.equal(reader.got.at(-1)!.type, 'turn.paused', `${label}: the stream ends after turn.paused`);
  assert.equal(a2.model.calls, 1);
  // Continue on replica B: it claims the turn and runs it from the saved state.
  await b2.actions.continue(MEMBER, t2);
  const resumed = collect(b2.stream, t2, reader.got.at(-1)!.seq);
  await b2.runner.idle();
  await resumed.done;
  assert.deepEqual(resumed.got.map(e => e.type).slice(0, 1), ['turn.resumed']);
  assert.equal(resumed.got.at(-1)!.type, 'turn.finished');
  assert.equal(turns.rows.get(t2).status, 'SUCCEEDED', `${label}: any replica continues a paused turn`);
}

async function gapsAndDuplicates() {
  const store = new MemoryTurnEventStore();
  const bus = new MemoryRunBus();
  const status = { value: 'RUNNING' };
  const stream = new TurnStreamService(store, bus, { statusOf: async () => status.value });
  const turnId = 't-gap';
  const write = async (type: any, toBus = true) => {
    const e = await store.append(turnId, type, { n: Math.random() });
    if (toBus) await bus.add(eventsKey(turnId), { seq: String(e.seq), type, at: e.at, body: JSON.stringify(e.body) }, 2000);
    return e;
  };
  await write('turn.started');
  const reader = collect(stream, turnId, 0);
  await new Promise(r => setTimeout(r, 20));
  await write('step.started', false); // lost on the way to Redis
  await write('tool.started');        // arrives with a gap: 2 is read from PostgreSQL
  const dup = await write('tool.finished');
  await bus.add(eventsKey(turnId), { seq: String(dup.seq), type: 'tool.finished', at: dup.at, body: '{}' }, 2000); // a duplicate
  status.value = 'SUCCEEDED';
  await write('turn.finished');
  await reader.done;
  assert.deepEqual(reader.got.map(e => e.seq), [1, 2, 3, 4, 5], 'gaps are filled from PostgreSQL and duplicates skipped');

  // Redis lost the whole stream (expired or down): the reader polls PostgreSQL.
  const turn2 = 't-noredis';
  await store.append(turn2, 'turn.started', {});
  const status2 = { value: 'RUNNING' };
  const s2 = new TurnStreamService(store, bus, { statusOf: async () => status2.value });
  const r2 = collect(s2, turn2, 0, { blockMs: 50 });
  await store.append(turn2, 'block', {});
  status2.value = 'SUCCEEDED';
  await store.append(turn2, 'turn.finished', {});
  await r2.done;
  assert.deepEqual(r2.got.map(e => e.type), ['turn.started', 'block', 'turn.finished']);

  // A reader that goes away ends its loop.
  const turn3 = 't-close';
  await store.append(turn3, 'turn.started', {});
  const r3 = collect(new TurnStreamService(store, bus, { statusOf: async () => 'RUNNING' }), turn3, 0, { blockMs: 5000 });
  await new Promise(r => setTimeout(r, 20));
  r3.close();
  await r3.done;

  assert.equal(sseFrame({ seq: 7, type: 'usage', at: '2026-11-18T00:00:00.000Z', body: { input_tokens: 3 } }),
    'id: 7\nevent: usage\ndata: {"seq":7,"type":"usage","at":"2026-11-18T00:00:00.000Z","input_tokens":3}\n\n');
}

async function main() {
  Logger.overrideLogger(['fatal']);
  const bus = new MemoryRunBus();
  await crossReplica(bus, bus, 'memory bus');
  await gapsAndDuplicates();
  void ORDER;
  console.log('Stream tests passed (replay then follow across replicas, Last-Event-ID, gaps, duplicates, PostgreSQL fallback, pause and continue across replicas)');
}
if (require.main === module) main().catch(e => { console.error(e); process.exitCode = 1; });
