import { Module } from '@nestjs/common';
import { AgentController } from './agent/agent.controller';
import { AgentService } from './agent/agent.service';
import { LlmService } from './llm/llm.service';
import { EmbeddingService } from './llm/embedding.service';
import { PrismaService } from './db/prisma.service';
import { ActorRepository } from './db/actor.repository';
import { SessionRepository } from './db/session.repository';
import { TurnRepository } from './db/turn.repository';
import { MemoryRepository } from './memory/memory.repository';
import { MemoryService } from './memory/memory.service';
import { ConversationContextService } from './memory/conversation-context.service';
import { SessionService } from './session/session.service';
import { McpService } from './mcp/mcp.service';
import { ToolsetRegistry } from './tools/toolset-registry';
import { AuditLogService } from './guardrails/audit-log.service';
import { ToolGatewayService } from './guardrails/tool-gateway.service';
import { OutputVerifierService } from './guardrails/output-verifier.service';
import { InputGuardService } from './guardrails/input-guard.service';
import { RateLimiterService } from './guardrails/rate-limiter.service';

@Module({
  controllers: [AgentController],
  providers: [
    PrismaService,
    ActorRepository,
    SessionRepository,
    TurnRepository,
    AgentService,
    LlmService,
    EmbeddingService,
    MemoryRepository,
    MemoryService,
    ConversationContextService,
    SessionService,
    McpService,
    ToolsetRegistry,
    AuditLogService,
    ToolGatewayService,
    OutputVerifierService,
    InputGuardService,
    RateLimiterService,
  ],
})
export class AppModule {}
