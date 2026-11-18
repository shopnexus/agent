/** Interactive CLI: asks as CLI_MEMBER_ID through the same turn path as HTTP and prints the run's events. Calls the real model and MCP. */
import * as readline from 'readline';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { AgentService } from './agent/agent.service';
import { TurnStreamService } from './run/turn-stream.service';
import { ConversationService } from './conversation/conversation.service';
import { AgentError } from './http/agent-error';
import type { ConsoleMember } from './console/console-member';
import { config } from './config';

async function main() {
  if (!config.cli.member_id) throw new Error('Set CLI_MEMBER_ID to a console member id');
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['warn', 'error'] });
  const agent = app.get(AgentService);
  const stream = app.get(TurnStreamService);
  const member: ConsoleMember = { id: config.cli.member_id, role: config.cli.member_role };
  const { id } = await app.get(ConversationService).open(member);

  console.log(`\nShopNexus console agent (member=${member.id}, role=${member.role})`);
  console.log('type a question; "exit" or Ctrl+C to quit\n');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.on('close', async () => { await app.close(); process.exit(0); });
  const prompt = () => rl.question('› ', async line => {
    const text = line.trim();
    if (!text) return prompt();
    if (text === 'exit' || text === 'quit') return rl.close();
    try {
      const { turn_id } = await agent.ask(member, id, { text });
      await stream.stream(turn_id, 0, event => {
        const body = event.body as Record<string, any>;
        if (event.type === 'text.delta') return;
        if (event.type === 'block' && body.block?.type === 'text') process.stdout.write(body.block.markdown + '\n');
        else if (event.type === 'tool.started') process.stdout.write(`  · ${body.label}\n`);
        else if (event.type === 'turn.finished') for (const s of body.sources ?? []) process.stdout.write(`  [${s.n}] ${s.kind} ${s.record_id}\n`);
        else if (event.type !== 'block') process.stdout.write(`  ${event.type}\n`);
      }, new AbortController().signal);
    } catch (error) {
      process.stdout.write(`error: ${error instanceof AgentError ? error.code : 'internal'}\n`);
    }
    process.stdout.write('\n');
    prompt();
  });
  prompt();
}

if (require.main === module) main().catch(error => {
  console.error(error instanceof Error ? error.message : 'CLI could not start. Check the service configuration.');
  process.exitCode = 1;
});
