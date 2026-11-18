/** Offline: McpService against an in-process MCP server on 127.0.0.1. */
import assert from 'node:assert/strict';
import { createServer, IncomingMessage } from 'node:http';
import { AddressInfo } from 'node:net';
import { Logger } from '@nestjs/common';
import { Agent } from '@strands-agents/sdk';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { McpService, McpUnavailableError } from '../src/mcp/mcp.service';
import { scriptedModel } from './helpers/scripted-model';

const TOKEN = 'test-mcp-token';
const MEMBER = '11111111-1111-4111-8111-111111111111';
const TICKET = '33333333-3333-4333-8333-333333333333';

async function main() {
  Logger.overrideLogger(['fatal']);
  const seen: Array<{ auth?: string; member?: string; method?: string }> = [];
  const calledWith: unknown[] = [];
  let writes = 0;
  const http = createServer(async (req: IncomingMessage, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
    seen.push({ auth: req.headers.authorization, member: req.headers['x-console-member'] as string, method: body?.method });
    if (req.headers.authorization !== `Bearer ${TOKEN}`) { res.writeHead(401).end(); return; }
    const server = new McpServer({ name: 'fake-server', version: '0.0.0' });
    server.registerTool('ticket_get', { title: 'Ticket', description: 'Read a ticket', inputSchema: { ticket_id: z.string() }, annotations: { readOnlyHint: true } },
      async (args) => { calledWith.push(args); return { content: [{ type: 'text', text: JSON.stringify({ ticket: { id: args.ticket_id } }) }] }; });
    server.registerTool('hide_listing', { description: 'Hide a listing', inputSchema: { listing_id: z.string() }, annotations: { readOnlyHint: false } },
      async () => { writes++; return { content: [{ type: 'text', text: 'hidden' }] }; });
    server.registerTool('unannotated', { description: 'No hints' }, async () => { writes++; return { content: [{ type: 'text', text: 'x' }] }; });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => { void transport.close(); void server.close(); });
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  });
  await new Promise<void>(r => http.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(http.address() as AddressInfo).port}/mcp`;
  const mcp = new McpService();
  try {
    const session = await mcp.openSession(MEMBER, url, TOKEN);
    assert.deepEqual(session.tools.map(t => t.name), ['ticket_get'], 'only readOnlyHint tools reach the agent');
    assert.equal(session.labels.get('ticket_get'), 'Ticket', 'the label is the server title');

    const model = scriptedModel([
      { tools: [{ name: 'ticket_get', input: { ticket_id: TICKET } }, { name: 'hide_listing', input: { listing_id: 'x' } }] },
      { text: 'done' },
    ]);
    const agent = new Agent({ model, printer: false, tools: session.tools });
    await agent.invoke('read the ticket');
    await session.close();
    assert.deepEqual(calledWith, [{ ticket_id: TICKET }], 'arguments reach the server without trace _meta');
    assert.equal(writes, 0, 'a write tool never runs');
    assert.ok(seen.some(r => r.method === 'tools/call'));
    for (const request of seen) {
      assert.equal(request.auth, `Bearer ${TOKEN}`, `${request.method} carries the MCP token`);
      assert.equal(request.member, MEMBER, `${request.method} carries the member`);
    }

    await assert.rejects(mcp.openSession(MEMBER, url, 'wrong-token'), McpUnavailableError);
    await assert.rejects(mcp.openSession(MEMBER, url, ''), McpUnavailableError);
    await assert.rejects(mcp.openSession(MEMBER, '', TOKEN), McpUnavailableError);
    await assert.rejects(mcp.openSession(MEMBER, 'http://127.0.0.1:1/mcp', TOKEN), McpUnavailableError);
  } finally {
    http.closeAllConnections();
    await new Promise<void>(r => http.close(() => r()));
  }
  console.log('MCP session tests passed (headers on every request, read-only tools, labels, refusals)');
}
main().catch(e => { console.error(e); process.exitCode = 1; });
