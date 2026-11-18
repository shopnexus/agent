/** Offline: the stuck-turn sweep closes RUNNING turns past their segment's deadline as FAILED and tells readers. */
import assert from 'node:assert/strict';
import { Logger } from '@nestjs/common';
import { StuckTurnSweeper, SWEEP_GRACE_MS } from '../src/sweep/stuck-turn.sweeper';
import { FAILURE_ANSWERS } from '../src/agent/agent.service';

async function main() {
  Logger.overrideLogger(['fatal']);
  const now = new Date('2026-11-17T03:00:00Z');
  const asked: Array<[Date, number]> = [];
  const finished: any[] = [];
  const published: any[] = [];
  const events = { publish: async (turnId: string, type: string, body: any) => { published.push({ turnId, type, body }); } };
  const old = new Date(now.getTime() - 10 * 60_000);
  const repo = {
    findStuck: async (at: Date, grace: number) => { asked.push([at, grace]); return [{ id: 'stuck-1', startedAt: old, wrote: true }, { id: 'stuck-2', startedAt: old, wrote: false }, { id: 'done-3', startedAt: old, wrote: true }]; },
    finishTurn: async (p: any) => { if (p.turnId === 'done-3') return false; finished.push(p); return true; },
  };
  const sweeper = new StuckTurnSweeper(repo as any, events as any);
  assert.equal(await sweeper.sweep(now), 2, 'a turn that finished meanwhile is left alone');
  assert.deepEqual(asked[0], [now, SWEEP_GRACE_MS], 'each turn is judged by its own segment deadline plus the grace');
  assert.deepEqual(finished.map(f => [f.turnId, f.status, f.errorCode, f.answer]), [
    ['stuck-1', 'FAILED', 'agent_stuck', FAILURE_ANSWERS.agent_stuck],
    ['stuck-2', 'FAILED', 'agent_stuck', FAILURE_ANSWERS.agent_stuck],
  ]);
  assert.equal(finished[0].latencyMs, 10 * 60_000);
  assert.deepEqual(published.map(p => [p.turnId, p.type, p.body.outcome, p.body.continuable]), [
    ['stuck-1', 'turn.finished', 'broken', true], ['stuck-2', 'turn.finished', 'broken', false]]);

  // Overlapping calls share one sweep.
  let release!: () => void;
  let queries = 0;
  const slow = new StuckTurnSweeper({ findStuck: async () => { queries++; await new Promise<void>(r => { release = r; }); return []; }, finishTurn: async () => true } as any, events as any);
  const first = slow.sweep(now), second = slow.sweep(now);
  await new Promise(r => setImmediate(r));
  release();
  assert.deepEqual(await Promise.all([first, second]), [0, 0]);
  assert.equal(queries, 1);

  // A database outage is logged, not thrown: start-up goes on.
  const down = new StuckTurnSweeper({ findStuck: async () => { throw new Error('PRIVATE db down'); } } as any, events as any);
  assert.equal(await down.sweep(now), 0);

  // Start-up runs a sweep at once and schedules the next ones.
  let startupSweeps = 0;
  const boot = new StuckTurnSweeper({ findStuck: async () => { startupSweeps++; return []; }, finishTurn: async () => true } as any, events as any);
  boot.onApplicationBootstrap();
  await new Promise(r => setImmediate(r));
  assert.equal(startupSweeps, 1);
  await boot.onModuleDestroy();
  console.log('Stuck-turn sweep tests passed (segment deadline, FAILED close, turn.finished, no overlap, outage, start-up)');
}
main().catch(e => { console.error(e); process.exitCode = 1; });
