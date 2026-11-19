/**
 * The server's side of a run, on 127.0.0.1: `/mcp` (a stateless MCP server
 * with the test's read-only tools) and `/agent/turns/{id}/control` (a queue
 * the test pushes pause, stop and steer into).
 */
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

export const MCP_TOKEN = 'test-mcp-token';

export interface FakeTool {
  name: string;
  title?: string;
  /** Input fields, all strings; absent means none. */
  fields?: string[];
  readOnly?: boolean;
  run: (args: Record<string, string>) => unknown | Promise<unknown>;
}

type Item = { seq: number; kind: 'pause' | 'stop' | 'steer'; steer_id?: string; text?: string };

export class FakeServer {
  readonly seen: Array<{ path: string; auth?: string; member?: string; method?: string }> = [];
  private readonly queues = new Map<string, Item[]>();
  private readonly gone = new Set<string>();
  private seq = 100;
  private http?: Server;
  url = '';

  constructor(public tools: FakeTool[] = []) {}

  async start(): Promise<this> {
    this.http = createServer((req, res) => { void this.handle(req, res); });
    await new Promise<void>(r => this.http!.listen(0, '127.0.0.1', r));
    this.url = `http://127.0.0.1:${(this.http.address() as AddressInfo).port}`;
    return this;
  }

  async stop(): Promise<void> {
    this.http?.closeAllConnections();
    await new Promise<void>(r => this.http ? this.http.close(() => r()) : r());
  }

  /** Queues a control input for a turn; returns its seq. */
  push(turnId: string, item: Omit<Item, 'seq'>): number {
    const queue = this.queues.get(turnId) ?? [];
    const seq = ++this.seq;
    queue.push({ seq, ...item });
    this.queues.set(turnId, queue);
    return seq;
  }

  /** The turn stops running on the server: polls answer running:false. */
  end(turnId: string) { this.gone.add(turnId); }

  polls(turnId: string) { return this.seen.filter(s => s.path.startsWith(`/agent/turns/${turnId}/control`)); }

  private async handle(req: IncomingMessage, res: import('node:http').ServerResponse) {
    const url = new URL(req.url ?? '/', 'http://x');
    const control = /^\/agent\/turns\/([^/]+)\/control$/.exec(url.pathname);
    if (control && req.method === 'GET') {
      this.seen.push({ path: url.pathname + url.search, auth: req.headers.authorization });
      if (req.headers.authorization !== `Bearer ${MCP_TOKEN}`) { res.writeHead(401).end(); return; }
      const after = Number(url.searchParams.get('after') ?? 0);
      const items = (this.queues.get(control[1]) ?? []).filter(i => i.seq > after);
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ items, running: !this.gone.has(control[1]) }));
      return;
    }
    if (url.pathname !== '/mcp') { res.writeHead(404).end(); return; }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
    this.seen.push({ path: '/mcp', auth: req.headers.authorization, member: req.headers['x-console-member'] as string, method: body?.method });
    if (req.headers.authorization !== `Bearer ${MCP_TOKEN}`) { res.writeHead(401).end(); return; }
    const server = new McpServer({ name: 'fake-server', version: '0.0.0' });
    for (const t of this.tools) {
      const shape = Object.fromEntries((t.fields ?? []).map(f => [f, z.string()]));
      server.registerTool(t.name, { title: t.title, description: t.title ?? t.name, inputSchema: shape, annotations: { readOnlyHint: t.readOnly ?? true } },
        async (args: Record<string, string>) => {
          try {
            const out = await t.run(args);
            return { content: [{ type: 'text' as const, text: typeof out === 'string' ? out : JSON.stringify(out) }] };
          } catch (error) {
            return { isError: true, content: [{ type: 'text' as const, text: error instanceof Error ? error.message : String(error) }] };
          }
        });
    }
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => { void transport.close(); void server.close(); });
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  }
}
