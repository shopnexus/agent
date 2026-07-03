import { Module } from '@nestjs/common';
import { AgentController } from './agent/agent.controller';
import { AgentService } from './agent/agent.service';
import { AgentCoreClient } from './aws/agentcore-client';
import { LlmService } from './llm/llm.service';
import { MemoryService } from './memory/memory.service';
import { SessionService } from './session/session.service';
import { IdentityService } from './identity/identity.service';
import { SandboxService } from './sandbox/sandbox.service';
import { BrowserService } from './browser/browser.service';
import { McpService } from './mcp/mcp.service';
import { ToolsetRegistry } from './tools/toolset-registry';

@Module({
  controllers: [AgentController],
  providers: [
    AgentCoreClient,
    AgentService,
    LlmService,
    MemoryService,
    SessionService,
    IdentityService,
    SandboxService,
    BrowserService,
    McpService,
    ToolsetRegistry,
  ],
})
export class AppModule {}
