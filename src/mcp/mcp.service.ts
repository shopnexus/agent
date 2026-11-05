import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { McpClient } from '@strands-agents/sdk';
import { config } from '../config';

/** The tool type McpClient.listTools() yields — reused by the agent loop. */
export type McpTools = Awaited<ReturnType<McpClient['listTools']>>;

/**
 * Connects exclusively to the static MCP server configured via MCP_SERVER_URL in .env.
 * Arbitrary runtime installation of MCP servers is disabled for security.
 */
@Injectable()
export class McpService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(McpService.name);
  private client?: McpClient;
  private tools: McpTools = [];

  async onModuleInit() {
    if (config.gateway.url) {
      await this.tryConnect(config.gateway.url);
    } else {
      this.log.warn('MCP server disabled: set MCP_SERVER_URL in .env');
    }
  }

  /** All connected MCP tools from the configured server, ready to hand to the Agent. */
  getTools(): McpTools {
    return this.tools;
  }

  /** Connect to the configured MCP server; logs and degrades gracefully on failure. */
  private async tryConnect(url: string): Promise<void> {
    try {
      const client = new McpClient({ url, continueOnError: true });
      await client.connect();
      const tools = await client.listTools();
      this.client = client;
      this.tools = tools;
      this.log.log(`MCP server connected (${url}): ${tools.length} tool(s) loaded`);
    } catch (e) {
      this.log.warn(`MCP server connect failed (${url}): ${(e as Error).message}`);
    }
  }

  async onModuleDestroy() {
    if (this.client) {
      try {
        await this.client.disconnect();
      } catch {
        /* best-effort */
      }
    }
  }
}
