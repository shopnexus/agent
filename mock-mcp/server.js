/**
 * ShopNexus Mock MCP Server
 * ==============================================================================
 * Pure Node.js standalone Model Context Protocol (MCP) server.
 * Implements MCP over Server-Sent Events (SSE) and Streamable HTTP.
 * Zero external npm dependencies.
 *
 * Usage:
 *   node server.js
 *   (or PORT=8080 node server.js)
 * ==============================================================================
 */

const http = require('http');
const { randomUUID } = require('crypto');
const db = require('./data');
const { toolsList, executeTool } = require('./tools');

const PORT = parseInt(process.env.PORT || '8080', 10);
const sessions = new Map();

/**
 * Handles incoming JSON-RPC 2.0 messages from MCP clients
 */
function handleJsonRpc(msg, res, sseStream) {
  const { id, method, params } = msg || {};

  const sendResponse = (result, error) => {
    const payload = { jsonrpc: '2.0', id: id !== undefined ? id : null };
    if (error) {
      payload.error = error;
    } else {
      payload.result = result;
    }
    const data = JSON.stringify(payload);

    // If client is waiting for HTTP POST response
    if (res && !res.writableEnded) {
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      });
      res.end(data);
    } else if (sseStream && !sseStream.destroyed) {
      // Push via SSE stream if session is connected
      sseStream.write(`event: message\ndata: ${data}\n\n`);
    }
  };

  switch (method) {
    case 'server/discover': {
      // SEP-2663 discovery probe
      sendResponse({
        protocolVersion: '2024-11-05',
        capabilities: { tools: { listChanged: true } },
        serverInfo: { name: 'shopnexus-mock-mcp', version: '1.0.0' }
      });
      break;
    }

    case 'initialize': {
      sendResponse({
        protocolVersion: '2024-11-05',
        capabilities: {
          tools: { listChanged: true }
        },
        serverInfo: {
          name: 'shopnexus-mock-mcp',
          version: '1.0.0'
        }
      });
      break;
    }

    case 'notifications/initialized': {
      if (res && !res.writableEnded) {
        res.writeHead(202, { 'Access-Control-Allow-Origin': '*' }).end();
      }
      break;
    }

    case 'ping': {
      sendResponse({});
      break;
    }

    case 'tools/list': {
      sendResponse({ tools: toolsList });
      break;
    }

    case 'tools/call': {
      const { name, arguments: args } = params || {};
      if (!name) {
        sendResponse(null, { code: -32602, message: 'Missing tool name' });
        break;
      }

      try {
        const output = executeTool(name, args);
        sendResponse({
          content: [
            {
              type: 'text',
              text: typeof output === 'string' ? output : JSON.stringify(output, null, 2)
            }
          ]
        });
      } catch (err) {
        sendResponse({
          isError: true,
          content: [
            {
              type: 'text',
              text: `Lỗi khi thực thi tool ${name}: ${err.message}`
            }
          ]
        });
      }
      break;
    }

    default: {
      sendResponse(null, {
        code: -32601,
        message: `Method not found: ${method}`
      });
      break;
    }
  }
}

/**
 * Creates the HTTP server
 */
const server = http.createServer((req, res) => {
  const host = req.headers.host || `localhost:${PORT}`;
  const url = new URL(req.url, `http://${host}`);
  const pathname = url.pathname;

  // CORS headers for all requests
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');

  if (req.method === 'OPTIONS') {
    res.writeHead(204).end();
    return;
  }

  // 1. SSE Connection endpoint (GET /sse or GET /mcp with text/event-stream)
  const isSseRequest = pathname === '/sse' || pathname === '/mcp' || req.headers.accept?.includes('text/event-stream');
  if (req.method === 'GET' && isSseRequest && pathname !== '/' && !pathname.startsWith('/api')) {
    const sessionId = randomUUID();
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'mcp-session-id': sessionId
    });

    // Send initial endpoint event for standard MCP SSE clients
    res.write(`event: endpoint\ndata: /messages?sessionId=${sessionId}\n\n`);

    sessions.set(sessionId, res);

    // Keep-alive heartbeat every 15 seconds
    const heartbeat = setInterval(() => {
      if (!res.destroyed) {
        res.write(': heartbeat\n\n');
      }
    }, 15000);

    req.on('close', () => {
      clearInterval(heartbeat);
      sessions.delete(sessionId);
    });
    return;
  }

  // 2. MCP JSON-RPC Message endpoints (POST /messages, POST /sse, POST /mcp, POST /)
  if (req.method === 'POST') {
    let rawBody = '';
    req.on('data', chunk => rawBody += chunk);
    req.on('end', () => {
      try {
        const sessionId = url.searchParams.get('sessionId') || req.headers['mcp-session-id'];
        const sseStream = sessionId ? sessions.get(sessionId) : null;
        const msg = JSON.parse(rawBody || '{}');
        handleJsonRpc(msg, res, sseStream);
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32700, message: 'Invalid JSON payload' } }));
      }
    });
    return;
  }

  // 3. Quick REST endpoints for manual browser testing
  if (req.method === 'GET') {
    if (pathname === '/api/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', uptime: process.uptime(), activeSessions: sessions.size }));
      return;
    }

    if (pathname === '/api/tools') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ count: toolsList.length, tools: toolsList }, null, 2));
      return;
    }

    if (pathname === '/api/products') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(db.products, null, 2));
      return;
    }

    if (pathname.startsWith('/api/products/')) {
      const id = pathname.replace('/api/products/', '');
      const product = db.products.find(p => p.id.toLowerCase() === id.toLowerCase());
      if (product) {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(product, null, 2));
      } else {
        res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'Product not found' }));
      }
      return;
    }

    if (pathname === '/api/orders') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(db.orders, null, 2));
      return;
    }

    if (pathname.startsWith('/api/orders/')) {
      const id = pathname.replace('/api/orders/', '');
      const order = db.orders.find(o => o.id.toLowerCase() === id.toLowerCase());
      if (order) {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(order, null, 2));
      } else {
        res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'Order not found' }));
      }
      return;
    }

    // 4. Test Chatbot Interface
    if (pathname === '/test.html' || pathname === '/chat') {
      const fs = require('fs');
      const path = require('path');
      const testFile = path.join(__dirname, 'test.html');
      if (fs.existsSync(testFile)) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(fs.readFileSync(testFile));
        return;
      }
    }

    // 5. Clean HTML Dashboard on root URL (/)
    if (pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(renderDashboard(host));
      return;
    }
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not Found');
});

/**
 * Web dashboard for developers to see server status, tool specs, and test APIs
 */
function renderDashboard(host) {
  const toolsHtml = toolsList.map(t => `
    <div class="tool-card">
      <div class="tool-header">
        <span class="tool-badge">TOOL</span>
        <span class="tool-name">${t.name}</span>
      </div>
      <p class="tool-desc">${t.description}</p>
      <div class="tool-params">
        <strong>Parameters:</strong> <code>${Object.keys(t.inputSchema.properties || {}).join(', ') || 'None'}</code>
      </div>
    </div>
  `).join('');

  return `<!DOCTYPE html>
<html lang="vi">
<head>
  <meta charset="UTF-8">
  <title>ShopNexus Mock MCP Server</title>
  <style>
    :root {
      --bg: #0f172a;
      --card-bg: #1e293b;
      --border: #334155;
      --accent: #38bdf8;
      --accent-hover: #0284c7;
      --text: #f8fafc;
      --text-muted: #94a3b8;
      --success: #10b981;
    }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      background: var(--bg);
      color: var(--text);
      margin: 0;
      padding: 32px 24px;
      line-height: 1.5;
    }
    .container {
      max-width: 960px;
      margin: 0 auto;
    }
    .hero {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding-bottom: 24px;
      border-bottom: 1px solid var(--border);
      margin-bottom: 32px;
    }
    .badge-online {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      background: rgba(16, 185, 129, 0.15);
      color: var(--success);
      padding: 6px 14px;
      border-radius: 9999px;
      font-weight: 600;
      font-size: 0.875rem;
      border: 1px solid rgba(16, 185, 129, 0.3);
    }
    .pulse-dot {
      width: 8px;
      height: 8px;
      background: var(--success);
      border-radius: 50%;
      box-shadow: 0 0 10px var(--success);
    }
    h1 {
      margin: 0 0 8px;
      font-size: 1.85rem;
      color: #fff;
    }
    p {
      margin: 0;
      color: var(--text-muted);
    }
    .info-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
      gap: 16px;
      margin-bottom: 32px;
    }
    .info-card {
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 20px;
    }
    .info-title {
      font-size: 0.85rem;
      color: var(--text-muted);
      text-transform: uppercase;
      letter-spacing: 0.05em;
      margin-bottom: 8px;
    }
    .info-value {
      font-family: monospace;
      font-size: 1rem;
      color: var(--accent);
      word-break: break-all;
    }
    .links-card {
      display: flex;
      gap: 12px;
      flex-wrap: wrap;
      margin-top: 8px;
    }
    .api-link {
      display: inline-block;
      background: #0f172a;
      color: var(--text);
      text-decoration: none;
      padding: 6px 12px;
      border-radius: 6px;
      font-size: 0.85rem;
      border: 1px solid var(--border);
      transition: all 0.2s;
    }
    .api-link:hover {
      border-color: var(--accent);
      color: var(--accent);
    }
    h2 {
      font-size: 1.35rem;
      margin: 0 0 16px;
      color: #fff;
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .tool-list {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(420px, 1fr));
      gap: 16px;
    }
    .tool-card {
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 18px;
    }
    .tool-header {
      display: flex;
      align-items: center;
      gap: 10px;
      margin-bottom: 10px;
    }
    .tool-badge {
      background: rgba(56, 189, 248, 0.15);
      color: var(--accent);
      padding: 3px 8px;
      border-radius: 4px;
      font-size: 0.75rem;
      font-weight: 700;
      border: 1px solid rgba(56, 189, 248, 0.3);
    }
    .tool-name {
      font-family: monospace;
      font-weight: 700;
      font-size: 1.05rem;
      color: #fff;
    }
    .tool-desc {
      color: #cbd5e1;
      font-size: 0.9rem;
      margin-bottom: 12px;
    }
    .tool-params {
      font-size: 0.82rem;
      color: var(--text-muted);
      background: #0f172a;
      padding: 8px 12px;
      border-radius: 6px;
    }
    .tool-params code {
      color: #38bdf8;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="hero">
      <div>
        <h1>ShopNexus Mock MCP Server</h1>
        <p>Standalone Mock E-Commerce MCP Server for Strands AI Agent</p>
      </div>
      <div class="badge-online">
        <span class="pulse-dot"></span> Online (Port ${PORT})
      </div>
    </div>

    <div class="info-grid">
      <div class="info-card">
        <div class="info-title">MCP SSE Endpoint (.env config)</div>
        <div class="info-value">http://${host}/sse</div>
        <p style="font-size: 0.8rem; margin-top: 6px; color: #94a3b8;">
          Điền vào file <code>.env</code>: <code>MCP_SERVER_URL=http://${host}/sse</code>
        </p>
      </div>

      <div class="info-card">
        <div class="info-title">Mock REST Test Endpoints</div>
        <div class="links-card">
          <a class="api-link" style="background: linear-gradient(135deg, #0284c7, #4f46e5); color: #fff; font-weight: 600; border: none;" target="_blank" href="/test.html">💬 Giao diện Test Chatbot (/test.html)</a>
          <a class="api-link" target="_blank" href="/api/products">/api/products</a>
          <a class="api-link" target="_blank" href="/api/orders">/api/orders</a>
          <a class="api-link" target="_blank" href="/api/tools">/api/tools</a>
          <a class="api-link" target="_blank" href="/api/health">/api/health</a>
        </div>
      </div>
    </div>

    <h2>Danh sách MCP Tools (${toolsList.length} tools)</h2>
    <div class="tool-list">
      ${toolsHtml}
    </div>
  </div>
</body>
</html>`;
}

server.listen(PORT, () => {
  console.log(`\n============================================================`);
  console.log(`🛒 ShopNexus Mock MCP Server running on port ${PORT}`);
  console.log(`   - MCP SSE Endpoint:     http://localhost:${PORT}/sse`);
  console.log(`   - Streamable HTTP:      http://localhost:${PORT}/mcp`);
  console.log(`   - Web Dashboard:        http://localhost:${PORT}/`);
  console.log(`   - Mock REST APIs:       http://localhost:${PORT}/api/products`);
  console.log(`============================================================\n`);
});
