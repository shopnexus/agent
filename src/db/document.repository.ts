import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from './prisma.service';
import { visibleTo } from './conversation.repository';
import type { DocumentSection } from '../run/answer-blocks';

export interface DocumentWrite {
  conversationId: string; turnId: string; memberId: string;
  title: string; sections: DocumentSection[]; documentId?: string;
}

/** Documents a run writes, kept with their chat; each write is a new version. */
@Injectable()
export class DocumentRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** Creates a document, or a new version of one in the same conversation. Null when that document is not in it. */
  async write(input: DocumentWrite): Promise<{ document_id: string; version: number } | null> {
    const sections = JSON.parse(JSON.stringify(input.sections)) as Prisma.InputJsonValue;
    return this.prisma.$transaction(async tx => {
      if (!input.documentId) {
        const doc = await tx.document.create({ data: { conversationId: input.conversationId, turnId: input.turnId, title: input.title, createdBy: input.memberId,
          versions: { create: { version: 1, title: input.title, sections, turnId: input.turnId, createdBy: input.memberId } } } });
        return { document_id: doc.id, version: 1 };
      }
      const rows = await tx.$queryRaw<Array<{ latest: number }>>`
        SELECT latest_version AS latest FROM documents WHERE id = ${input.documentId}::uuid AND conversation_id = ${input.conversationId}::uuid FOR UPDATE`;
      if (!rows.length) return null;
      const version = rows[0].latest + 1;
      await tx.documentVersion.create({ data: { documentId: input.documentId, version, title: input.title, sections, turnId: input.turnId, createdBy: input.memberId } });
      await tx.document.update({ where: { id: input.documentId }, data: { latestVersion: version, title: input.title, turnId: input.turnId } });
      return { document_id: input.documentId, version };
    });
  }

  /** True when the document and version exist in the conversation. */
  async exists(conversationId: string, documentId: string, version: number): Promise<boolean> {
    return !!(await this.prisma.documentVersion.findFirst({ where: { documentId, version, document: { conversationId } }, select: { version: true } }));
  }

  /** A document with every version, newest first, if the member may see its chat. */
  findVisible(id: string, memberId: string) {
    return this.prisma.document.findFirst({
      where: { id, conversation: visibleTo(memberId) },
      include: { versions: { orderBy: { version: 'desc' } } },
    });
  }
}
