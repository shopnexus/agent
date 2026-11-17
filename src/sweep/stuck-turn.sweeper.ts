import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { TurnRepository } from '../db/turn.repository';
import { FAILURE_ANSWERS } from '../agent/agent.service';
import { config } from '../config';
import { errorDetails } from '../observability/error-details';

/** Time a live turn gets past its deadline to write its own terminal state. */
export const SWEEP_GRACE_MS = 30_000;

/**
 * Closes turns left RUNNING past their deadline (a crash, a lost database
 * write) as FAILED, at start-up and then every AGENT_SWEEP_INTERVAL_MS, so
 * the conversation takes questions again.
 */
@Injectable()
export class StuckTurnSweeper implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly log = new Logger(StuckTurnSweeper.name);
  private timer?: NodeJS.Timeout;
  private running?: Promise<number>;

  constructor(private readonly turns: TurnRepository) {}

  onApplicationBootstrap() {
    void this.sweep();
    this.timer = setInterval(() => { void this.sweep(); }, config.agent.sweep_interval_ms);
    this.timer.unref();
  }

  async onModuleDestroy() {
    clearInterval(this.timer);
    await this.running;
  }

  /** Returns how many turns it closed. Sweeps never overlap. */
  sweep(now = new Date()): Promise<number> {
    if (this.running) return this.running;
    this.running = this.closeStuck(now).finally(() => { this.running = undefined; });
    return this.running;
  }

  private async closeStuck(now: Date): Promise<number> {
    const cutoff = new Date(now.getTime() - config.agent.turn_deadline_ms - SWEEP_GRACE_MS);
    let closed = 0;
    try {
      for (const turn of await this.turns.findRunningBefore(cutoff)) {
        // finishTurn re-checks the status under the turn lock: a turn that
        // finished meanwhile keeps its own answer.
        await this.turns.finishTurn({ turnId: turn.id, status: 'FAILED', answer: FAILURE_ANSWERS.agent_stuck,
          errorCode: 'agent_stuck', latencyMs: now.getTime() - turn.startedAt.getTime() });
        closed++;
      }
      if (closed) this.log.warn(JSON.stringify({ event: 'stuck_turns_closed', count: closed }));
    } catch (error) {
      this.log.warn(JSON.stringify({ event: 'stuck_turn_sweep_failed', closed, ...errorDetails(error) }));
    }
    return closed;
  }
}
