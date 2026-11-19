import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { LlmService } from './llm/llm.service';
import { McpService } from './mcp/mcp.service';
import { AuditLogService } from './guardrails/audit-log.service';
import { ServiceTokenGuard } from './console/service-token.guard';
import { AgentErrorFilter } from './http/agent-error';
import { ControlPoller } from './run/control-poller';
import { RunsController } from './run/runs.controller';
import { TurnRunner } from './run/turn-runner';

@Module({
  controllers: [RunsController],
  providers: [
    { provide: APP_FILTER, useClass: AgentErrorFilter },
    ServiceTokenGuard,
    TurnRunner,
    ControlPoller,
    LlmService,
    McpService,
    AuditLogService,
  ],
})
export class AppModule {}
