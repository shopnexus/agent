import { Injectable } from '@nestjs/common';
import type { Conversation, Prisma } from '@prisma/client';
import { ConversationRepository, Subject, SubjectKind } from '../db/conversation.repository';
import { ActorRepository } from '../db/actor.repository';
import type { Source } from '../run/citations';
import type { AnswerBlock, ClarifyQuestion } from '../run/answer-blocks';
import type { RunState } from '../run/run-state';
import { isContinuable, outcomeOf, type Outcome } from '../run/events';
import type { ConsoleMember } from '../console/console-member';
import { AgentError } from '../http/agent-error';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const KINDS: ReadonlySet<string> = new Set<SubjectKind>(['ticket', 'report_case', 'account']);

export interface ConversationSummary {
  id: string; subject_kind?: SubjectKind; subject_id?: string; title?: string; updated_at: string;
}
export interface TurnView {
  id: string; conversation_id: string; member_id: string; status: string; text: string; answer?: string;
  blocks: AnswerBlock[]; sources: Source[]; outcome: Outcome | null; error_code?: string; continuable: boolean;
  agent: { id: string | null; name: string | null };
  usage: { input_tokens: number; output_tokens: number; cost_usd: number; first_token_ms: number | null; provider: string | null };
  steers: Array<{ steer_id: string; text: string }>; questions?: ClarifyQuestion[];
  last_seq: number; created_at: string;
}

/** A turn row with its messages and their text blocks, as the repository loads it. */
export type StoredTurn = Prisma.TurnGetPayload<{ include: { messages: { include: { blocks: true } } } }>;

/** The member-facing view of one turn. `latest`: no later turn in the conversation. */
export function turnView(turn: StoredTurn, latest: boolean): TurnView {
  const blocks = (role: string) => turn.messages.filter(m => m.role === role).flatMap(m => m.blocks);
  const terminal = blocks('ASSISTANT').find(b => b.isTerminal);
  const payload = (terminal?.payload ?? null) as { sources?: unknown; blocks?: unknown } | null;
  const extra = (b: { payload: unknown }) => (b.payload ?? {}) as { steer_id?: string; answers?: unknown };
  const state = turn.state as unknown as RunState | null;
  return {
    id: turn.id,
    conversation_id: turn.conversationId,
    member_id: turn.memberId,
    status: turn.status,
    text: blocks('USER').filter(b => !extra(b).steer_id && extra(b).answers === undefined).map(b => b.text ?? '').join('\n'),
    ...(terminal?.text != null ? { answer: terminal.text } : {}),
    blocks: Array.isArray(payload?.blocks) ? payload!.blocks as AnswerBlock[] : [],
    sources: Array.isArray(payload?.sources) ? payload!.sources as Source[] : state?.sources ?? [],
    outcome: outcomeOf(turn.status, turn.errorCode),
    ...(turn.errorCode ? { error_code: turn.errorCode } : {}),
    continuable: isContinuable(turn.status, turn.errorCode, !!state?.wrote, latest),
    agent: { id: turn.agentId, name: turn.agentName },
    usage: { input_tokens: Number(turn.inputTokens), output_tokens: Number(turn.outputTokens), cost_usd: Number(turn.costUsd),
      first_token_ms: turn.firstTokenMs, provider: turn.provider },
    steers: blocks('USER').filter(b => extra(b).steer_id).map(b => ({ steer_id: extra(b).steer_id!, text: b.text ?? '' })),
    ...(turn.status === 'AWAITING_INPUT' && state?.pending_ask ? { questions: state.pending_ask } : {}),
    last_seq: Number(turn.eventSeq),
    created_at: turn.startedAt.toISOString(),
  };
}
export interface ConversationView extends ConversationSummary { turns: TurnView[] }

/** Parses `subject_kind` and `subject_id` from a body or a query; both or neither. */
export function parseSubject(kind: unknown, id: unknown): Subject | undefined {
  const empty = (v: unknown) => v === undefined || v === null || v === '';
  if (empty(kind) && empty(id)) return undefined;
  if (typeof kind !== 'string' || !KINDS.has(kind) || typeof id !== 'string' || !UUID.test(id)) throw AgentError.badRequest();
  return { kind: kind as SubjectKind, id: id.toLowerCase() };
}

/** Parses the list filter: a kind alone, or a kind with an id. */
export function parseSubjectFilter(kind: unknown, id: unknown): { kind?: SubjectKind; id?: string } {
  if ((kind === undefined || kind === '') && (id === undefined || id === '')) return {};
  if (id === undefined || id === '') {
    if (typeof kind !== 'string' || !KINDS.has(kind)) throw AgentError.badRequest();
    return { kind: kind as SubjectKind };
  }
  return parseSubject(kind, id)!;
}

function summary(c: Conversation): ConversationSummary {
  return {
    id: c.id,
    ...(c.subjectKind ? { subject_kind: c.subjectKind } : {}),
    ...(c.subjectId ? { subject_id: c.subjectId } : {}),
    ...(c.title ? { title: c.title } : {}),
    updated_at: c.lastActivityAt.toISOString(),
  };
}

@Injectable()
export class ConversationService {
  constructor(private readonly conversations: ConversationRepository, private readonly actors: ActorRepository) {}

  /** A record's shared conversation (found or created), or a new one of the member's own. */
  async open(member: ConsoleMember, subject?: Subject): Promise<ConversationSummary> {
    await this.actors.upsert(member.id, 'vi');
    const conversation = subject
      ? await this.conversations.findOrCreateForSubject(member.id, subject)
      : await this.conversations.createOwn(member.id);
    return summary(conversation);
  }

  async list(member: ConsoleMember, filter: { kind?: SubjectKind; id?: string } = {}): Promise<ConversationSummary[]> {
    return (await this.conversations.listVisible(member.id, filter)).map(summary);
  }

  /** The conversation if the member may see it; 404 otherwise, malformed ids included. */
  async assertVisible(member: ConsoleMember, conversationId: string): Promise<Conversation> {
    if (!UUID.test(conversationId)) throw AgentError.notFound();
    const conversation = await this.conversations.findVisible(conversationId, member.id);
    if (!conversation) throw AgentError.notFound();
    return conversation;
  }

  async get(member: ConsoleMember, conversationId: string): Promise<ConversationView> {
    if (!UUID.test(conversationId)) throw AgentError.notFound();
    const conversation = await this.conversations.findVisibleWithTurns(conversationId, member.id);
    if (!conversation) throw AgentError.notFound();
    return {
      ...summary(conversation),
      turns: conversation.turns.map((turn, i) => turnView(turn, i === conversation.turns.length - 1)),
    };
  }

  /** One turn, if the member may see its conversation. */
  async getTurn(member: ConsoleMember, turnId: string): Promise<TurnView> {
    if (!UUID.test(turnId)) throw AgentError.notFound();
    const turn = await this.conversations.findVisibleTurn(turnId, member.id);
    if (!turn) throw AgentError.notFound();
    return turnView(turn, await this.conversations.isLatestTurn(turn.conversationId, turn.ordinal));
  }
}
