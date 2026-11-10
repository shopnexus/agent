import { Injectable, NotFoundException, ConflictException } from '@nestjs/common';
import { ConversationRepository } from '../db/conversation.repository';
import { ActorRepository } from '../db/actor.repository';
import type { AgentContext } from '../agent/agent.service';
export interface ConversationSummary { conversationId:string;title:string|null;createdAt:string;lastActivityAt:string;turnCount:number }
@Injectable()
export class ConversationService {
  constructor(private readonly conversations:ConversationRepository,private readonly actors:ActorRepository) {}
  async newConversation(actorId:string,ctx:AgentContext = {}):Promise<string> {
    await this.actors.upsert(actorId,ctx.locale ?? 'vi');
    return (await this.conversations.create(actorId)).id;
  }
  async assertOwnedConversation(actorId:string,conversationId:string):Promise<void> {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(conversationId)) throw new NotFoundException('Conversation not found');
    const conversation = await this.conversations.findByIdForActor(conversationId,actorId);
    if (!conversation) throw new NotFoundException('Conversation not found');
    if (conversation.status !== 'active') throw new ConflictException('Conversation is not active');
  }
  async listConversations(actorId:string):Promise<ConversationSummary[]> {
    return (await this.conversations.listByActor(actorId)).map(c => ({conversationId:c.id,title:c.title,createdAt:c.createdAt.toISOString(),lastActivityAt:c.lastActivityAt.toISOString(),turnCount:c._count.turns}));
  }
}
