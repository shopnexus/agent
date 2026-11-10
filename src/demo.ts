/**
 * Scripted demo — exercises the agent features end to end without the HTTP
 * server. Uses the configured PostgreSQL, LiteLLM and MCP services and may incur
 * model costs. `npm run demo`.
 */
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { AgentService } from './agent/agent.service';
import { ConversationService } from './conversation/conversation.service';
import { config } from './config';

async function main() {
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['log', 'warn', 'error'],
  });
  const agent = app.get(AgentService);
  const conversations = app.get(ConversationService);
  const actorId = config.default_actor;

  console.log(`\n=== ShopNexus Agent demo ===\n`);

  // Session 1: teach a fact.
  const s1 = await conversations.newConversation(actorId);
  for (const msg of [
    'My name is Binh and I am looking for sports shoes.',
  ]) {
    const r = await agent.chat(actorId, s1, msg, { actorId });
    console.log(`[s1] USER : ${msg}`);
    console.log(`[s1] AGENT: ${r.answer}\n`);
  }

  // Session 2 (new chat): long-term memory should still recall the fact.
  const s2 = await conversations.newConversation(actorId);
  for (const msg of ['What is my name?']) {
    const r = await agent.chat(actorId, s2, msg, { actorId });
    console.log(`[s2] USER : ${msg}`);
    console.log(`[s2] AGENT: ${r.answer}\n`);
  }

  const list = await conversations.listConversations(actorId);
  console.log(`conversations for ${actorId}: ${list.map((s) => s.conversationId).join(', ') || '(none)'}`);

  await app.close();
}
main().catch((e) => {
  console.error('demo failed:', e?.message ?? e);
  process.exit(1);
});
