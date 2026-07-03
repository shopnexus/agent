import * as fs from 'fs';
import * as path from 'path';

/** A remote MCP server the agent has installed. Only non-secret fields are
 *  persisted (no tokens) — auth-required servers are out of scope for now. */
export interface McpServer {
  name: string;
  url: string;
}

const FILE = path.join(process.cwd(), 'data', 'mcp-servers.json');

export function loadServers(): McpServer[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function saveServers(servers: McpServer[]): void {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(servers, null, 2));
}
