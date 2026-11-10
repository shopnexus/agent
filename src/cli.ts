/** Interactive CLI: same guarded, buffered chat path as HTTP. */
import * as readline from 'readline';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { AgentService } from './agent/agent.service';
import { ConversationService } from './conversation/conversation.service';
import { config } from './config';
import { writeChatReply } from './cli-renderer';
import { fixedSupportReply } from './guardrails/support-policy';

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;

/** Testable CLI boundary; it never observes or renders SDK streaming events. */
export async function runCliTurn(service: Pick<AgentService, 'chat'>, actorId: string, conversationId: string, message: string, write: (text: string) => void): Promise<void> {
  const reply = await service.chat(actorId, conversationId, message, { actorId });
  writeChatReply(reply, write);
}

async function main() {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['warn', 'error'] });
  const agentService = app.get(AgentService);
  const conversations = app.get(ConversationService);
  const actorId = process.env.ACTOR_ID?.trim() || config.default_actor;
  const conversationId = await conversations.newConversation(actorId);

  console.log(`\nShopNexus Agent chat (actor=${actorId})`);
  console.log(dim('type a message; "exit" or Ctrl+C to quit\n'));
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.on('close', async () => { await app.close(); process.exit(0); });
  const prompt = () => rl.question('› ', async line => {
    const msg = line.trim();
    if (!msg) return prompt();
    if (msg === 'exit' || msg === 'quit') return rl.close();
    try { await runCliTurn(agentService, actorId, conversationId, msg, text => { process.stdout.write(text); }); }
    catch { process.stdout.write(fixedSupportReply('unavailable', 'vi') + '\n'); }
    process.stdout.write('\n');
    prompt();
  });
  prompt();
}

if (require.main === module) main().catch(() => {
  console.error('CLI could not start. Check the service configuration.');
  process.exitCode = 1;
});
