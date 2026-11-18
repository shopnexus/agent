import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { TurnRepository } from '../db/turn.repository';
import { FAILURE_ANSWERS } from '../run/failure';
import { TurnEventService } from '../run/turn-events.service';
import { config } from '../config';
import { errorDetails } from '../observability/error-details';

/** Time a live turn gets past its deadline to write its own terminal state. */
export const SWEEP_GRACE_MS = 30_000;

/**
 * Closes turns left RUNNING past their run segment's deadline (a crash, a lost
 * database write) as FAILED agent_stuck, at start-up and then every
 * AGENT_SWEEP_INTERVAL_MS, and writes turn.finished so readers stop. The
 * conversation takes questions again, and a turn that wrote something can be
 * continued from its last checkpoint.
 */
@Injectable()
export class StuckTurnSweeper implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly log = new Logger(StuckTurnSweeper.name);
  private timer?: NodeJS.Timeout;
  private running?: Promise<number>;

  constructor(private readonly turns: TurnRepository, private readonly events: TurnEventService) {}

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
    let closed = 0;
    try {
      for (const turn of await this.turns.findStuck(now, SWEEP_GRACE_MS)) {
        // finishTurn re-checks the status under the turn lock: a turn that
        // finished meanwhile keeps its own answer.
        const done = await this.turns.finishTurn({ turnId: turn.id, status: 'FAILED', answer: FAILURE_ANSWERS.agent_stuck,
          errorCode: 'agent_stuck', latencyMs: now.getTime() - turn.startedAt.getTime() });
        if (!done) continue;
        closed++;
        await this.events.publish(turn.id, 'turn.finished', { status: 'FAILED', outcome: 'broken', failure: 'agent_stuck', continuable: !!turn.wrote });
      }
      if (closed) this.log.warn(JSON.stringify({ event: 'stuck_turns_closed', count: closed }));
    } catch (error) {
      this.log.warn(JSON.stringify({ event: 'stuck_turn_sweep_failed', closed, ...errorDetails(error) }));
    }
    return closed;
  }
}
