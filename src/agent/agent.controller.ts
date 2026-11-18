import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { AgentService, AskBody, TurnAccepted } from './agent.service';
import { ConversationService, ConversationSummary, ConversationView, parseSubject, parseSubjectFilter } from '../conversation/conversation.service';
import { ConsoleMember, ConsoleMemberGuard, Member } from '../console/console-member';

/** Called by server only, with AGENT_SERVICE_TOKEN and the console member's headers. */
@Controller('conversations')
@UseGuards(ConsoleMemberGuard)
export class AgentController {
  constructor(
    private readonly agent: AgentService,
    private readonly conversations: ConversationService,
  ) {}

  @Get()
  list(@Member() member: ConsoleMember, @Query('subject_kind') kind?: string, @Query('subject_id') id?: string): Promise<ConversationSummary[]> {
    return this.conversations.list(member, parseSubjectFilter(kind, id));
  }

  /** The record's shared conversation if it exists, else a new one. */
  @Post()
  @HttpCode(200)
  open(@Member() member: ConsoleMember, @Body() body: { subject_kind?: unknown; subject_id?: unknown } = {}): Promise<ConversationSummary> {
    return this.conversations.open(member, parseSubject(body?.subject_kind, body?.subject_id));
  }

  @Get(':id')
  get(@Member() member: ConsoleMember, @Param('id') id: string): Promise<ConversationView> {
    return this.conversations.get(member, id);
  }

  /** Renames a conversation: its owner's own, or any for an admin. */
  @Patch(':id')
  rename(@Member() member: ConsoleMember, @Param('id') id: string, @Body() body: { title?: unknown } = {}): Promise<ConversationSummary> {
    return this.conversations.rename(member, id, body?.title);
  }

  /** Deletes a conversation with its turns, events and documents: its owner's own, or any for an admin. */
  @Delete(':id')
  @HttpCode(204)
  remove(@Member() member: ConsoleMember, @Param('id') id: string): Promise<void> {
    return this.conversations.remove(member, id);
  }

  /** Opens a turn and runs it in the background: 202 {turn_id}; follow it at GET /turns/{id}/events. */
  @Post(':id/turns')
  @HttpCode(202)
  ask(@Member() member: ConsoleMember, @Param('id') id: string, @Body() body: AskBody = {}): Promise<TurnAccepted> {
    return this.agent.ask(member, id, body ?? {});
  }
}
