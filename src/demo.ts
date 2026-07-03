/**
 * Scripted demo — exercises the AgentCore features end to end without the HTTP
 * server. Runs against real AWS, so it needs credentials and the resources from
 * the setup scripts. `npm run demo`.
 */
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { AgentService } from './agent/agent.service';
import { SessionService } from './session/session.service';
import { config } from './config';

async function main() {
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['log', 'warn', 'error'],
  });
  const agent = app.get(AgentService);
  const sessions = app.get(SessionService);
  const actorId = config.default_actor;

  console.log(`\n=== AgentCore agent demo (region=${config.aws_region}) ===\n`);

  // Session 1: teach a fact + run code in the sandbox.
  const s1 = sessions.newSession();
  for (const msg of [
    'My name is Binh and I like AWS.',
    'Use code to compute the 12th Fibonacci number.',
  ]) {
    const r = await agent.chat(actorId, s1, msg);
    console.log(`[s1] USER : ${msg}`);
    console.log(`[s1] AGENT: ${r.answer}\n`);
  }

  // Session 2 (new chat): long-term memory should still recall the fact.
  const s2 = sessions.newSession();
  for (const msg of ['What is my name?']) {
    const r = await agent.chat(actorId, s2, msg);
    console.log(`[s2] USER : ${msg}`);
    console.log(`[s2] AGENT: ${r.answer}\n`);
  }

  const list = await sessions.listSessions(actorId);
  console.log(`sessions for ${actorId}: ${list.map((s) => s.sessionId).join(', ') || '(none)'}`);

  await app.close();
}
main().catch((e) => {
  console.error('demo failed:', e?.message ?? e);
  process.exit(1);
});
