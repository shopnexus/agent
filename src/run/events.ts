/** The turn events: the run writes most of them, the server `turn.resumed` and End's `turn.finished`. */
export type TurnEventType =
  | 'turn.started' | 'turn.resumed' | 'turn.pausing' | 'turn.paused' | 'turn.finished'
  | 'step.started' | 'step.finished'
  | 'tool.started' | 'tool.retry' | 'tool.finished'
  | 'model.switched' | 'thinking' | 'text.delta' | 'block' | 'clarify' | 'usage'
  | 'steer.read' | 'rate.waiting'
  | 'context.compacting' | 'context.compacted' | 'context.meter'
  | 'guardrail';

export type FinishStatus = 'SUCCEEDED' | 'FAILED' | 'CANCELLED' | 'TIMED_OUT';
export type Outcome = 'stopped' | 'out_of_room' | 'broken' | 'unavailable' | 'blocked';

/**
 * Why a turn did not succeed: the end line's error_code.
 * agent_unavailable: the model or MCP failed before the run wrote anything.
 * agent_failed: it failed after writing something. agent_limit: model calls ran out.
 * agent_context: the context stayed full after compaction. agent_blocked: a guardrail.
 */
export type FailureCode =
  | 'agent_timeout' | 'agent_budget' | 'agent_unavailable' | 'agent_failed'
  | 'agent_limit' | 'agent_context' | 'agent_blocked' | 'agent_stuck';

const OUTCOMES: Record<FailureCode, Outcome> = {
  agent_timeout: 'out_of_room',
  agent_limit: 'out_of_room',
  agent_context: 'out_of_room',
  agent_failed: 'broken',
  agent_stuck: 'broken',
  agent_unavailable: 'unavailable',
  agent_budget: 'blocked',
  agent_blocked: 'blocked',
};
const CONTINUABLE: ReadonlySet<string> = new Set(['agent_timeout', 'agent_limit', 'agent_context', 'agent_failed', 'agent_stuck']);

export function outcomeOf(status: string, errorCode?: string | null): Outcome | null {
  if (status === 'SUCCEEDED') return null;
  if (status === 'CANCELLED') return 'stopped';
  if (status === 'TIMED_OUT') return 'out_of_room';
  return OUTCOMES[errorCode as FailureCode] ?? 'broken';
}

/**
 * Whether Continue works: a paused turn always; a FAILED or TIMED_OUT one when it
 * is the conversation's latest turn, wrote something and did not stop on a spent
 * budget or a guardrail.
 */
export function isContinuable(status: string, errorCode: string | null | undefined, wrote: boolean, latest: boolean): boolean {
  if (status === 'PAUSED') return true;
  if (status !== 'FAILED' && status !== 'TIMED_OUT') return false;
  return latest && wrote && CONTINUABLE.has(status === 'TIMED_OUT' ? 'agent_timeout' : errorCode ?? '');
}

/** turn.finished's status: a spent budget reads BUDGET. */
export function eventStatus(status: FinishStatus, errorCode?: string | null): string {
  return errorCode === 'agent_budget' ? 'BUDGET' : status;
}
