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
import { TurnEventRepository, TurnEventStore } from './db/turn-event.repository';
import { DocumentRepository } from './db/document.repository';
import { SkillRepository } from './db/skill.repository';
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
import { runBusProvider } from './run/run-bus.provider';
import { TurnEventService } from './run/turn-events.service';
import { TurnControlService } from './run/turn-control.service';
import { TurnStatusReader, TurnStreamService } from './run/turn-stream.service';
import { TurnRunner } from './run/turn-runner';
import { TurnActionsService } from './run/turn-actions.service';
import { ToolCallsController, TurnsController } from './run/turns.controller';
import { DocumentsController } from './documents/documents.controller';
import { SkillsController } from './skills/skills.controller';
import { StatsController } from './stats/stats.controller';
import { StatsService } from './stats/stats.service';
import { StatsRepository, StatsSource } from './stats/stats.repository';

@Module({
  controllers: [AgentController, TurnsController, ToolCallsController, DocumentsController, SkillsController, StatsController],
  providers: [
    { provide: APP_FILTER, useClass: AgentErrorFilter },
    PrismaService,
    ActorRepository,
    ConversationRepository,
    TurnRepository,
    { provide: TurnEventStore, useClass: TurnEventRepository },
    { provide: TurnStatusReader, useExisting: TurnRepository },
    DocumentRepository,
    SkillRepository,
    { provide: StatsSource, useClass: StatsRepository },
    StatsService,
    runBusProvider,
    TurnEventService,
    TurnControlService,
    TurnStreamService,
    TurnRunner,
    TurnActionsService,
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
