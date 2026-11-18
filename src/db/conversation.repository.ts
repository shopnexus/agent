import { Injectable } from '@nestjs/common';
import { Prisma, type ConversationSubjectKind } from '@prisma/client';
import { PrismaService } from './prisma.service';

export type SubjectKind = ConversationSubjectKind;
export interface Subject { kind: SubjectKind; id: string }

/**
 * What a member may see: every conversation with a subject (shared by all
 * members) and the subject-less ones they opened.
 */
export function visibleTo(memberId: string): Prisma.ConversationWhereInput {
  return { OR: [{ subjectKind: { not: null } }, { actorId: memberId }] };
}

@Injectable()
export class ConversationRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** A new conversation owned by the member, without a subject. */
  createOwn(memberId: string) {
    return this.prisma.conversation.create({ data: { actorId: memberId } });
  }

  /** The record's shared conversation, created by this member if there is none. */
  async findOrCreateForSubject(memberId: string, subject: Subject) {
    const where = { subjectKind: subject.kind, subjectId: subject.id };
    const existing = await this.prisma.conversation.findFirst({ where });
    if (existing) return existing;
    try {
      return await this.prisma.conversation.create({ data: { actorId: memberId, ...where } });
    } catch (error) {
      // Another member created it at the same moment: the unique index decides.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        return this.prisma.conversation.findFirstOrThrow({ where });
      }
      throw error;
    }
  }

  listVisible(memberId: string, filter: { kind?: SubjectKind; id?: string } = {}, limit = 50) {
    return this.prisma.conversation.findMany({
      where: {
        AND: [visibleTo(memberId), { status: 'active' },
          filter.kind ? { subjectKind: filter.kind } : {},
          filter.id ? { subjectId: filter.id } : {}],
      },
      orderBy: [{ lastActivityAt: 'desc' }, { id: 'asc' }],
      take: limit,
    });
  }

  findVisible(id: string, memberId: string) {
    return this.prisma.conversation.findFirst({ where: { AND: [{ id }, visibleTo(memberId)] } });
  }

  /** The conversation with its turns, oldest first, and their user and terminal text blocks. */
  findVisibleWithTurns(id: string, memberId: string) {
    return this.prisma.conversation.findFirst({
      where: { AND: [{ id }, visibleTo(memberId)] },
      include: {
        turns: {
          orderBy: { ordinal: 'asc' },
          include: {
            messages: {
              orderBy: { ordinal: 'asc' },
              include: { blocks: { where: { kind: 'TEXT' }, orderBy: { ordinal: 'asc' } } },
            },
          },
        },
      },
    });
  }

  /** One turn with its messages and text blocks, if its conversation is visible. */
  findVisibleTurn(turnId: string, memberId: string) {
    return this.prisma.turn.findFirst({
      where: { id: turnId, conversation: visibleTo(memberId) },
      include: { messages: { orderBy: { ordinal: 'asc' }, include: { blocks: { where: { kind: 'TEXT' }, orderBy: { ordinal: 'asc' } } } } },
    });
  }

  /** A conversation by id, whoever may see it; the caller decides. */
  findById(id: string) {
    return this.prisma.conversation.findFirst({ where: { id } });
  }

  /** Whether a turn of the conversation still runs or waits on a member. */
  async hasOpenTurn(conversationId: string): Promise<boolean> {
    return !!(await this.prisma.turn.findFirst({ where: { conversationId, status: { in: ['RUNNING', 'PAUSED', 'AWAITING_INPUT', 'AWAITING_APPROVAL'] } }, select: { id: true } }));
  }

  rename(id: string, title: string) {
    return this.prisma.conversation.update({ where: { id }, data: { title, updatedAt: new Date() } });
  }

  /** Deletes the conversation; its turns, events, messages and documents go with it by their foreign keys. */
  async delete(id: string): Promise<void> {
    await this.prisma.conversation.delete({ where: { id } });
  }

  async isLatestTurn(conversationId: string, ordinal: number): Promise<boolean> {
    return !(await this.prisma.turn.findFirst({ where: { conversationId, ordinal: { gt: ordinal } }, select: { id: true } }));
  }
}
