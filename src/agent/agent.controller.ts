import { Body, Controller, Get, HttpCode, Param, Post, Query, UseGuards } from '@nestjs/common';
import { AgentService, TurnReply } from './agent.service';
import { ConversationService, ConversationSummary, ConversationView, parseSubject, parseSubjectFilter } from '../conversation/conversation.service';
import { ConsoleMember, ConsoleMemberGuard, Member } from '../console/console-member';

/** Called by server2 only, with AGENT_SERVICE_TOKEN and the console member's headers. */
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

  @Post(':id/turns')
  @HttpCode(200)
  ask(@Member() member: ConsoleMember, @Param('id') id: string, @Body() body: { text?: unknown } = {}): Promise<TurnReply> {
    return this.agent.ask(member, id, body?.text);
  }
}
