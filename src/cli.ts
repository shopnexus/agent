/**
 * Interactive chat CLI — a minimal Claude-Code-style REPL. Streams the agent's
 * thinking, tool calls, tool output and answer as they happen. No commands:
 * type a message and read the stream; blank line or Ctrl+C / "exit" to quit.
 *
 *   npm run chat
 *
 * One agent is reused for the whole session, so it keeps in-session
 * conversation history; long-term facts still arrive via memory injection.
 */
import * as readline from 'readline';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { AgentService } from './agent/agent.service';
import { SessionService } from './session/session.service';
import { ToolsetRegistry } from './tools/toolset-registry';
import { config } from './config';

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;

async function main() {
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['warn', 'error'],
  });
  const agentService = app.get(AgentService);
  const sessions = app.get(SessionService);
  const toolset = app.get(ToolsetRegistry);
  const actorId = process.env.ACTOR_ID?.trim() || config.default_actor;
  const sessionId = sessions.newSession();
  let agent = await agentService.prepareAgent(actorId, sessionId);
  let toolsetRev = toolset.revision;

  console.log(`\nAgentCore chat (region=${config.aws_region}, actor=${actorId})`);
  console.log(dim('type a message; "exit" or Ctrl+C to quit\n'));

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.on('close', async () => {
    await app.close();
    process.exit(0);
  });

  const prompt = () =>
    rl.question('› ', async (line) => {
      const msg = line.trim();
      if (!msg) return prompt();
      if (msg === 'exit' || msg === 'quit') return rl.close();
      try {
        await render(agentService.streamTurn(agent, actorId, sessionId, msg));
        if (toolset.revision !== toolsetRev) {
          // A tool changed the available toolset (installed an MCP, a skill,
          // etc.); rebuild so the new tools are in scope, preserving history.
          const snapshot = agent.takeSnapshot({ preset: 'session' });
          agent = await agentService.prepareAgent(actorId, sessionId);
          agent.loadSnapshot(snapshot);
          toolsetRev = toolset.revision;
        }
      } catch (e) {
        process.stdout.write(`\n\x1b[31m[error] ${(e as Error).message}\x1b[0m\n`);
      }
      process.stdout.write('\n\n');
      prompt();
    });
  prompt();
}

/** Render the agent event stream in place, like a live transcript. */
async function render(stream: AsyncIterable<{ type: string; [k: string]: any }>): Promise<void> {
  let mode: 'text' | 'thinking' | null = null;
  const endBlock = () => {
    if (mode) process.stdout.write('\n');
    mode = null;
  };

  for await (const event of stream) {
    switch (event.type) {
      case 'modelContentBlockDeltaEvent': {
        const delta = event.delta;
        if (delta?.type === 'textDelta' && delta.text) {
          if (mode !== 'text') {
            endBlock();
            mode = 'text';
          }
          process.stdout.write(delta.text);
        } else if (delta?.type === 'reasoningContentDelta' && 'text' in delta && delta.text) {
          if (mode !== 'thinking') {
            endBlock();
            process.stdout.write(dim('[thinking] '));
            mode = 'thinking';
          }
          process.stdout.write(dim(delta.text));
        }
        break;
      }
      case 'beforeToolCallEvent': {
        endBlock();
        process.stdout.write(cyan(`\n🔧 ${event.toolUse.name}(${compact(event.toolUse.input)})\n`));
        break;
      }
      case 'afterToolCallEvent': {
        const out = resultText(event.result);
        process.stdout.write(green(`✓ ${clip(out, 200)}\n`));
        break;
      }
      case 'agentResultEvent':
        endBlock();
        break;
    }
  }
}

function resultText(result: { content?: Array<{ text?: string }> }): string {
  return (result?.content ?? [])
    .map((b) => b.text ?? '')
    .join(' ')
    .trim();
}

function compact(input: unknown): string {
  return clip(JSON.stringify(input) ?? '', 80);
}

function clip(s: string, n: number): string {
  const oneLine = s.replace(/\s+/g, ' ');
  return oneLine.length > n ? `${oneLine.slice(0, n)}…` : oneLine;
}

main().catch((e) => {
  console.error('cli failed:', e?.message ?? e);
  process.exit(1);
});
