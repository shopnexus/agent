import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { AgentController } from './agent/agent.controller';
import { AgentService } from './agent/agent.service';
import { LlmService } from './llm/llm.service';
import { EmbeddingService } from './llm/embedding.service';
import { PrismaService } from './db/prisma.service';
import { ActorRepository } from './db/actor.repository';
import { ConversationRepository } from './db/conversation.repository';
import { TurnRepository } from './db/turn.repository';
import { RetrievalRepository } from './retrieval/retrieval.repository';
import { RetrievalService } from './retrieval/retrieval.service';
import { ConversationContextService } from './memory/conversation-context.service';
import { ConversationService } from './conversation/conversation.service';
import { McpService } from './mcp/mcp.service';
import { AuditLogService } from './guardrails/audit-log.service';
import { InputGuardService } from './guardrails/input-guard.service';
import { RateLimiterService } from './guardrails/rate-limiter.service';
import { ConsoleMemberGuard } from './console/console-member';
import { AgentErrorFilter } from './http/agent-error';
import { StuckTurnSweeper } from './sweep/stuck-turn.sweeper';

@Module({
  controllers: [AgentController],
  providers: [
    { provide: APP_FILTER, useClass: AgentErrorFilter },
    PrismaService,
    ActorRepository,
    ConversationRepository,
    TurnRepository,
    AgentService,
    LlmService,
    EmbeddingService,
    RetrievalRepository,
    RetrievalService,
    ConversationContextService,
    ConversationService,
    McpService,
    AuditLogService,
    InputGuardService,
    RateLimiterService,
    ConsoleMemberGuard,
    StuckTurnSweeper,
  ],
})
export class AppModule {}
