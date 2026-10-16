import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { McpClient, tool } from '@strands-agents/sdk';
import { z } from 'zod';
import { ToolsetRegistry } from '../tools/toolset-registry';
import { loadServers, saveServers } from './mcp-registry';
import { config } from '../config';

/** The tool type McpClient.listTools() yields — reused by the agent loop. */
export type McpTools = Awaited<ReturnType<McpClient['listTools']>>;

/**
 * Connects to MCP servers and exposes their tools to the agent:
 *  - the default AgentCore Gateway (optional), plus
 *  - any remote servers the agent installed at runtime (persisted registry).
 *
 * The `install_mcp` tool lets the user say "install this MCP: <url>" and the
 * agent registers it. Newly installed tools become available from the next turn
 * (each turn rebuilds its tool set from getTools()). Only user-initiated installs
 * are intended — arbitrary installs are a real attack surface.
 */
@Injectable()
export class McpService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(McpService.name);
  private readonly clients = new Map<string, McpClient>();
  private tools: McpTools = [];

  constructor(
    private readonly toolset: ToolsetRegistry,
  ) {}

  async onModuleInit() {
    if (config.gateway.url) {
      await this.tryConnect('gateway', config.gateway.url);
    } else {
      this.log.warn('MCP server disabled: set MCP_SERVER_URL in .env');
    }
    for (const server of loadServers()) {
      await this.tryConnect(server.name, server.url);
    }
  }

  /** All connected MCP tools, ready to hand to the Strands Agent. */
  getTools(): McpTools {
    return this.tools;
  }

  /** Strands tool: register a remote MCP server by URL at runtime. */
  installTool() {
    return tool({
      name: 'install_mcp',
      description:
        'Register a remote MCP server by URL so its tools become available from ' +
        'the next turn. Use ONLY when the user explicitly asks to install/add an ' +
        'MCP server. Works with public/no-auth servers; servers that require ' +
        'interactive OAuth login are not supported.',
      inputSchema: z.object({
        url: z.url().describe('MCP server URL, e.g. https://example.com/mcp'),
        name: z.string().optional().describe('Short name; defaults to the URL host.'),
      }),
      callback: async (input) => this.install(input.url, input.name),
    });
  }

  private async install(url: string, name?: string): Promise<string> {
    const serverName = sanitize(name?.trim() || hostOf(url));
    if (this.clients.has(serverName)) return `MCP "${serverName}" is already installed.`;
    try {
      const count = await this.connect(serverName, url);
      const servers = loadServers().filter((s) => s.name !== serverName);
      servers.push({ name: serverName, url });
      saveServers(servers);
      this.toolset.bump(); // signal that the toolset changed
      return `Installed MCP "${serverName}" (${count} tool(s)); available from the next turn.`;
    } catch (e) {
      return `Failed to install MCP "${serverName}": ${(e as Error).message}`;
    }
  }

  /** Connect and register a server's tools; throws on failure. */
  private async connect(name: string, url: string, bearer?: string): Promise<number> {
    const headers = bearer ? { Authorization: `Bearer ${bearer}` } : undefined;
    const client = new McpClient({ url, headers, continueOnError: true });
    await client.connect();
    const tools = await client.listTools();
    this.clients.set(name, client);
    this.tools = [...this.tools, ...tools];
    this.log.log(`MCP '${name}' connected: ${tools.length} tool(s)`);
    return tools.length;
  }

  /** Boot-time connect that logs and swallows failures (never crashes startup). */
  private async tryConnect(name: string, url: string, bearer?: string): Promise<void> {
    try {
      await this.connect(name, url, bearer);
    } catch (e) {
      this.log.warn(`MCP '${name}' connect failed: ${(e as Error).message}`);
    }
  }

  async onModuleDestroy() {
    for (const client of this.clients.values()) {
      try {
        await client.disconnect();
      } catch {
        /* best-effort */
      }
    }
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return 'mcp';
  }
}

const sanitize = (s: string): string => s.replace(/[^a-zA-Z0-9_-]/g, '-') || 'mcp';
