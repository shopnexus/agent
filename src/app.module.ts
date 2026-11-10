import { Module } from '@nestjs/common';
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
import { ToolGatewayService } from './guardrails/tool-gateway.service';
import { OutputVerifierService } from './guardrails/output-verifier.service';
import { InputGuardService } from './guardrails/input-guard.service';
import { RateLimiterService } from './guardrails/rate-limiter.service';
import { ScopeService } from './guardrails/scope.service';

@Module({
  controllers: [AgentController],
  providers: [
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
    ToolGatewayService,
    OutputVerifierService,
    InputGuardService,
    RateLimiterService,
    ScopeService,
  ],
})
export class AppModule {}
