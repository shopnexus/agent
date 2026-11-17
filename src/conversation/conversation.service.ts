import { Injectable } from '@nestjs/common';
import type { Conversation } from '@prisma/client';
import { ConversationRepository, Subject, SubjectKind } from '../db/conversation.repository';
import { ActorRepository } from '../db/actor.repository';
import type { TurnSource } from '../db/turn.repository';
import type { ConsoleMember } from '../console/console-member';
import { AgentError } from '../http/agent-error';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const KINDS: ReadonlySet<string> = new Set<SubjectKind>(['ticket', 'report_case', 'account']);

export interface ConversationSummary {
  id: string; subject_kind?: SubjectKind; subject_id?: string; title?: string; updated_at: string;
}
export interface TurnView {
  id: string; member_id: string; status: string; text: string; answer?: string; sources: TurnSource[]; created_at: string;
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
      turns: conversation.turns.map(turn => {
        const blocks = (role: string) => turn.messages.filter(m => m.role === role).flatMap(m => m.blocks);
        const terminal = blocks('ASSISTANT').find(b => b.isTerminal);
        return {
          id: turn.id,
          member_id: turn.memberId,
          status: turn.status,
          text: blocks('USER').map(b => b.text ?? '').join('\n'),
          ...(terminal?.text != null ? { answer: terminal.text } : {}),
          sources: storedSources(terminal?.payload),
          created_at: turn.startedAt.toISOString(),
        };
      }),
    };
  }
}

function storedSources(payload: unknown): TurnSource[] {
  const sources = (payload as { sources?: unknown } | null)?.sources;
  return Array.isArray(sources) ? sources as TurnSource[] : [];
}
