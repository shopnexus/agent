import { Module } from '@nestjs/common';
import { AgentController } from './agent/agent.controller';
import { AgentService } from './agent/agent.service';
import { AgentCoreClient } from './aws/agentcore-client';
import { LlmService } from './llm/llm.service';
import { EmbeddingService } from './llm/embedding.service';
import { DbPool } from './db/db.pool';
import { MemoryRepository } from './memory/memory.repository';
import { MemoryService } from './memory/memory.service';
import { SessionService } from './session/session.service';
import { McpService } from './mcp/mcp.service';
import { ToolsetRegistry } from './tools/toolset-registry';

@Module({
  controllers: [AgentController],
  providers: [
    AgentCoreClient,
    AgentService,
    LlmService,
    EmbeddingService,
    DbPool,
    MemoryRepository,
    MemoryService,
    SessionService,
    McpService,
    ToolsetRegistry,
  ],
})
export class AppModule {}
