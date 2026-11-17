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
}
