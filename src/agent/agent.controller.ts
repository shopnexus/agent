import { BadRequestException, Body, Controller, Get, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { AgentService, AgentContext, ChatReply } from './agent.service';
import { ConversationService, ConversationSummary } from '../conversation/conversation.service';

interface ChatDto {
  conversationId?: string;
  message: string;
  context?: AgentContext;
}

@Controller()
export class AgentController {
  constructor(
    private readonly agent: AgentService,
    private readonly conversations: ConversationService,
  ) { }

  /** X-User-ID is trusted only behind the authenticating API gateway. */
  @Post('chat')
  async chat(@Body() body: ChatDto, @Req() req: Request): Promise<ChatReply> {
    const actorId = requireGatewayActorId(req);
    const ctx: AgentContext = { ...(body.context ?? {}), actorId };
    const conversationId = body.conversationId?.trim();
    if (conversationId) await this.conversations.assertOwnedConversation(actorId, conversationId);
    const resolvedConversationId = conversationId || await this.conversations.newConversation(actorId, ctx);
    return this.agent.chat(actorId, resolvedConversationId, body.message ?? '', ctx);
  }

  @Post('conversations')
  async createConversation(
    @Body() body: { context?: AgentContext },
    @Req() req: Request,
  ): Promise<{ actorId: string; conversationId: string }> {
    const actorId = requireGatewayActorId(req);
    const context: AgentContext = { ...(body.context ?? {}), actorId };
    const conversationId = await this.conversations.newConversation(actorId, context);
    return { actorId, conversationId };
  }

  @Get('conversations')
  listConversations(@Req() req: Request): Promise<ConversationSummary[]> {
    return this.conversations.listConversations(requireGatewayActorId(req));
  }
}

/** Reads gateway identity; performs no authentication itself. */
function requireGatewayActorId(req: Request): string {
  const value = req.header('X-User-ID')?.trim();
  if (!value || value.length > 64 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new BadRequestException('Gateway must provide a valid X-User-ID');
  }
  return value;
}
