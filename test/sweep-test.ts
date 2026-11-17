/** Offline: the stuck-turn sweep closes RUNNING turns past the deadline as FAILED. */
import assert from 'node:assert/strict';
import { Logger } from '@nestjs/common';
import { StuckTurnSweeper, SWEEP_GRACE_MS } from '../src/sweep/stuck-turn.sweeper';
import { FAILURE_ANSWERS } from '../src/agent/agent.service';
import { config } from '../src/config';

async function main() {
  Logger.overrideLogger(['fatal']);
  const now = new Date('2026-11-17T03:00:00Z');
  const cutoffs: Date[] = [];
  const finished: any[] = [];
  const old = new Date(now.getTime() - 10 * 60_000);
  const repo = {
    findRunningBefore: async (cutoff: Date) => { cutoffs.push(cutoff); return [{ id: 'stuck-1', startedAt: old }, { id: 'stuck-2', startedAt: old }]; },
    finishTurn: async (p: any) => { finished.push(p); },
  };
  const sweeper = new StuckTurnSweeper(repo as any);
  assert.equal(await sweeper.sweep(now), 2);
  assert.equal(cutoffs[0].getTime(), now.getTime() - config.agent.turn_deadline_ms - SWEEP_GRACE_MS, 'only turns past the deadline and grace');
  assert.deepEqual(finished.map(f => [f.turnId, f.status, f.errorCode, f.answer]), [
    ['stuck-1', 'FAILED', 'agent_stuck', FAILURE_ANSWERS.agent_stuck],
    ['stuck-2', 'FAILED', 'agent_stuck', FAILURE_ANSWERS.agent_stuck],
  ]);
  assert.equal(finished[0].latencyMs, 10 * 60_000);

  // Overlapping calls share one sweep.
  let release!: () => void;
  let queries = 0;
  const slow = new StuckTurnSweeper({ findRunningBefore: async () => { queries++; await new Promise<void>(r => { release = r; }); return []; }, finishTurn: async () => {} } as any);
  const first = slow.sweep(now), second = slow.sweep(now);
  await new Promise(r => setImmediate(r));
  release();
  assert.deepEqual(await Promise.all([first, second]), [0, 0]);
  assert.equal(queries, 1);

  // A database outage is logged, not thrown: start-up goes on.
  const down = new StuckTurnSweeper({ findRunningBefore: async () => { throw new Error('PRIVATE db down'); } } as any);
  assert.equal(await down.sweep(now), 0);

  // Start-up runs a sweep at once and schedules the next ones.
  let startupSweeps = 0;
  const boot = new StuckTurnSweeper({ findRunningBefore: async () => { startupSweeps++; return []; }, finishTurn: async () => {} } as any);
  boot.onApplicationBootstrap();
  await new Promise(r => setImmediate(r));
  assert.equal(startupSweeps, 1);
  await boot.onModuleDestroy();
  console.log('Stuck-turn sweep tests passed (deadline cutoff, FAILED close, no overlap, outage, start-up)');
}
main().catch(e => { console.error(e); process.exitCode = 1; });
