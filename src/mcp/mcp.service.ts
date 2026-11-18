import { Injectable, Logger } from '@nestjs/common';
import { McpClient, type McpClientConfig } from '@strands-agents/sdk';
import { config } from '../config';
import { errorDetails } from '../observability/error-details';

/** The tool type McpClient.listTools() yields — handed to the agent loop. */
export type McpTools = Awaited<ReturnType<McpClient['listTools']>>;

/** One turn's MCP connection, bound to the member who asked. */
export interface McpSession {
  tools: McpTools;
  /** Display label per tool name: the server's title, else the name. */
  labels: ReadonlyMap<string, string>;
  close(): Promise<void>;
}

export class McpUnavailableError extends Error {
  constructor(message = 'MCP server unavailable') { super(message); this.name = 'McpUnavailableError'; }
}

type RawTool = { name: string; title?: string; annotations?: { title?: string; readOnlyHint?: boolean } };

/**
 * Connects to the one MCP server at MCP_SERVER_URL (server's /mcp) for each
 * turn, sending AGENT_MCP_TOKEN and the member's id on every request, so the
 * server checks the member on every tool call. Only tools the server marks
 * readOnlyHint are handed to the agent.
 */
@Injectable()
export class McpService {
  private readonly log = new Logger(McpService.name);

  /** Overridable for tests. */
  protected createClient(options: McpClientConfig): McpClient {
    return new McpClient(options);
  }

  async openSession(memberId: string, url = config.mcp.url, token = config.console.mcp_token): Promise<McpSession> {
    if (!url || !token) throw new McpUnavailableError('MCP_SERVER_URL or AGENT_MCP_TOKEN is not set');
    const client = this.createClient({
      url,
      headers: { Authorization: `Bearer ${token}`, 'X-Console-Member': memberId },
      // Trace context would land in the tool arguments as `_meta`.
      disableMcpInstrumentation: true,
      continueOnError: false,
    });
    const close = async () => { try { await client.disconnect(); } catch { /* best effort */ } };
    try {
      await client.connect();
      const raw: RawTool[] = [];
      let cursor: string | undefined;
      do {
        const page = await client.client.listTools(cursor ? { cursor } : undefined);
        raw.push(...(page.tools as RawTool[]));
        cursor = page.nextCursor;
      } while (cursor);
      const readOnly = new Map(raw.filter(t => t.annotations?.readOnlyHint === true).map(t => [t.name, t]));
      const dropped = raw.filter(t => !readOnly.has(t.name)).map(t => t.name);
      if (dropped.length) this.log.warn(JSON.stringify({ event: 'mcp_tools_dropped', reason: 'not_read_only', tools: dropped }));
      const tools = (await client.listTools()).filter(t => readOnly.has(t.name));
      const labels = new Map(tools.map(t => {
        const spec = readOnly.get(t.name)!;
        return [t.name, spec.title || spec.annotations?.title || t.name] as const;
      }));
      return { tools, labels, close };
    } catch (error) {
      this.log.warn(JSON.stringify({ event: 'mcp_connect_failed', ...errorDetails(error) }));
      await close();
      throw new McpUnavailableError();
    }
  }
}
