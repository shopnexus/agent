/**
 * `npm run chat -- "question"`: posts one new run to the agent on PORT as
 * CLI_MEMBER_ID and prints its lines. Calls the real model and MCP.
 */
import { randomUUID } from 'node:crypto';
import { config } from './config';

async function main() {
  const question = process.argv.slice(2).join(' ').trim();
  if (!question) throw new Error('Usage: npm run chat -- "your question"');
  if (!config.cli.member_id) throw new Error('Set CLI_MEMBER_ID to a console member id');
  const res = await fetch(`http://127.0.0.1:${config.port}/runs`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.console.service_token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ turn_id: randomUUID(), conversation_id: randomUUID(), member: { id: config.cli.member_id, role: config.cli.member_role },
      mode: 'new', question, agent_config: config.model.id ? { alias: config.model.id } : undefined }),
  });
  if (!res.ok || !res.body) throw new Error(`the agent answered ${res.status}: ${await res.text()}`);
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = JSON.parse(buffer.slice(0, nl));
      buffer = buffer.slice(nl + 1);
      if (line.kind === 'event' && line.type === 'text.delta') continue;
      if (line.kind === 'event') console.log(`  ${line.type} ${line.type === 'tool.started' ? line.body.label : ''}`);
      else if (line.kind === 'tool_call' || line.kind === 'checkpoint') continue;
      else if (line.kind === 'end') {
        console.log(`\n${line.status}${line.error_code ? ` (${line.error_code})` : ''}\n${line.answer ?? ''}`);
        for (const s of line.sources ?? []) console.log(`  [${s.n}] ${s.kind} ${s.label}`);
      } else console.log(`  ${line.kind}`);
    }
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : 'The CLI could not run.');
  process.exitCode = 1;
});
