import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import { ConsoleMember, ConsoleMemberGuard, Member } from '../console/console-member';
import { DocumentRepository } from '../db/document.repository';
import { AgentError } from '../http/agent-error';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Documents a run wrote, with every version, for the document panel. */
@Controller('documents')
@UseGuards(ConsoleMemberGuard)
export class DocumentsController {
  constructor(private readonly documents: DocumentRepository) {}

  @Get(':id')
  async get(@Member() member: ConsoleMember, @Param('id') id: string) {
    if (!UUID.test(id)) throw AgentError.notFound();
    const doc = await this.documents.findVisible(id, member.id);
    if (!doc) throw AgentError.notFound();
    return {
      id: doc.id, conversation_id: doc.conversationId, turn_id: doc.turnId, title: doc.title, latest_version: doc.latestVersion,
      created_by: doc.createdBy, created_at: doc.createdAt.toISOString(), updated_at: doc.updatedAt.toISOString(),
      versions: doc.versions.map(v => ({ version: v.version, title: v.title, sections: v.sections, turn_id: v.turnId,
        created_by: v.createdBy, created_at: v.createdAt.toISOString() })),
    };
  }
}
