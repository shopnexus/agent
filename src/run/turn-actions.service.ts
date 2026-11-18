import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { TurnStatus } from '@prisma/client';
import { TurnRepository } from '../db/turn.repository';
import { AgentError } from '../http/agent-error';
import type { ConsoleMember } from '../console/console-member';
import { InputGuardService } from '../guardrails/input-guard.service';
import { RateLimiterService } from '../guardrails/rate-limiter.service';
import { limitsOf } from './agent-config';
import { isContinuable } from './events';
import type { RunState } from './run-state';
import { TurnControlService } from './turn-control.service';
import { TurnEventService } from './turn-events.service';
import { TurnRunner, type RunMode } from './turn-runner';
import type { ClarifyQuestion } from './answer-blocks';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * The member's controls on a turn. On a RUNNING turn, pause, stop and steer go
 * to the replica running it through `turn:{id}:control`. On a turn nobody runs
 * (PAUSED, AWAITING_INPUT, a continuable FAILED or TIMED_OUT), this replica
 * claims it in PostgreSQL and runs the next segment itself, or ends it.
 */
@Injectable()
export class TurnActionsService {
  constructor(
    private readonly turns: TurnRepository,
    private readonly control: TurnControlService,
    private readonly events: TurnEventService,
    private readonly runner: TurnRunner,
    private readonly inputGuard: InputGuardService,
    private readonly rateLimiter: RateLimiterService,
  ) {}

  async visibleTurn(member: ConsoleMember, turnId: string) {
    if (!UUID.test(turnId)) throw AgentError.notFound();
    const turn = await this.turns.findVisible(turnId, member.id);
    if (!turn) throw AgentError.notFound();
    return turn;
  }

  async pause(member: ConsoleMember, turnId: string): Promise<void> {
    const turn = await this.visibleTurn(member, turnId);
    if (turn.status !== 'RUNNING') throw AgentError.turnState();
    await this.control.send(turnId, { type: 'pause', at: Date.now() });
  }

  async stop(member: ConsoleMember, turnId: string): Promise<void> {
    const turn = await this.visibleTurn(member, turnId);
    if (turn.status !== 'RUNNING') throw AgentError.turnState();
    await this.control.send(turnId, { type: 'stop', at: Date.now() });
  }

  /** Steering: queued for a running turn, or continues a paused one. */
  async steer(member: ConsoleMember, turnId: string, text: unknown): Promise<{ steer_id: string; resumed: boolean }> {
    const turn = await this.visibleTurn(member, turnId);
    if (typeof text !== 'string') throw AgentError.badRequest();
    if (!this.rateLimiter.consume(`member:${member.id}`).allowed) {
      if (turn.status === 'RUNNING' || turn.status === 'PAUSED') {
        await this.events.publish(turnId, 'guardrail', { rule: 'rate_limited', detail: 'More than 30 messages a minute; the update was not sent.' });
      }
      throw new AgentError('rate_limited', 429);
    }
    const guard = this.inputGuard.check(text, turn.conversationId, member.id, member.role);
    if (!guard.allowed) throw guard.blockedReason === 'EMPTY_INPUT' ? AgentError.badRequest() : new AgentError('input_rejected', 400);
    const steer = { steer_id: randomUUID(), text: guard.sanitizedText };
    if (turn.status === 'RUNNING') {
      await this.control.send(turnId, { type: 'steer', at: Date.now(), ...steer });
      return { steer_id: steer.steer_id, resumed: false };
    }
    if (turn.status !== 'PAUSED') throw AgentError.turnState();
    await this.resume(turnId, turn.state as unknown as RunState, ['PAUSED'], 'steer', { kind: 'resume', steers: [steer] });
    return { steer_id: steer.steer_id, resumed: true };
  }

  async continue(member: ConsoleMember, turnId: string): Promise<void> {
    const turn = await this.visibleTurn(member, turnId);
    await this.resume(turnId, turn.state as unknown as RunState, ['PAUSED', 'FAILED', 'TIMED_OUT'], 'continue', { kind: 'resume' });
  }

  /** A paused turn, or one waiting for answers, ends CANCELLED. */
  async end(member: ConsoleMember, turnId: string): Promise<void> {
    const turn = await this.visibleTurn(member, turnId);
    if (turn.status !== 'PAUSED' && turn.status !== 'AWAITING_INPUT') throw AgentError.turnState();
    const state = turn.state as unknown as RunState | null;
    const closed = await this.turns.finishTurn({ turnId, status: 'CANCELLED', answer: '', sources: state?.sources ?? [],
      latencyMs: state?.elapsed_ms ?? 0, ...(state ? { state: { ...state, pending_ask: undefined } } : {}) });
    if (!closed) throw AgentError.turnState();
    await this.events.publish(turnId, 'turn.finished', { status: 'CANCELLED', outcome: 'stopped', continuable: false, sources: state?.sources ?? [] });
  }

  /** Answers to ask_user: `{question_id: option_id | option_id[]}`. */
  async input(member: ConsoleMember, turnId: string, answers: unknown): Promise<void> {
    const turn = await this.visibleTurn(member, turnId);
    if (turn.status !== 'AWAITING_INPUT') throw AgentError.turnState();
    const state = turn.state as unknown as RunState;
    const text = answerText(state.pending_ask ?? [], answers);
    await this.resume(turnId, { ...state, pending_ask: undefined }, ['AWAITING_INPUT'], 'input', { kind: 'resume', answers: text },
      () => this.turns.addUserBlock(turnId, text, { answers: answers as Record<string, unknown> }));
  }

  private async resume(turnId: string, state: RunState, from: TurnStatus[], by: 'continue' | 'steer' | 'input', mode: RunMode, afterClaim?: () => Promise<void>) {
    if (!state) throw AgentError.turnState();
    const claimed = await this.turns.claim(turnId, from, limitsOf(state.agent_config).deadline_ms,
      t => isContinuable(t.status, t.errorCode, !!(t.state as RunState | null)?.wrote, t.latest));
    if (!claimed) throw AgentError.turnState();
    await afterClaim?.();
    // Written before the 202, so a reader that reconnects after it sees the turn running.
    await this.events.publish(turnId, 'turn.resumed', { by });
    this.runner.launch(turnId, state, mode);
  }
}

/** The member's answers as the message the model reads; checked against the questions asked. */
export function answerText(questions: ClarifyQuestion[], answers: unknown): string {
  if (!answers || typeof answers !== 'object' || Array.isArray(answers)) throw AgentError.badRequest();
  const given = answers as Record<string, unknown>;
  const lines: string[] = [];
  for (const q of questions) {
    const value = given[q.id];
    if (value === undefined) continue;
    const ids = Array.isArray(value) ? value : [value];
    if (!ids.every(v => typeof v === 'string') || (q.kind === 'single' && ids.length !== 1)) throw AgentError.badRequest();
    const labels = (ids as string[]).map(id => q.options.find(o => o.id === id)?.label);
    if (labels.some(l => l === undefined)) throw AgentError.badRequest();
    lines.push(`- ${q.label}: ${labels.join(', ')}`);
  }
  if (Object.keys(given).some(k => !questions.some(q => q.id === k)) || !lines.length) throw AgentError.badRequest();
  return `The member's answers to your questions:\n${lines.join('\n')}`;
}
