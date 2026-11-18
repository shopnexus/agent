/**
 * Opt-in, live, costs money: one agent-shaped run (system prompt, six tools, a
 * tool round) through the real model client and liteLlmFetch against a
 * LiteLLM, printing each call's prompt, cache read and cache write. Run it
 * twice with the same LIVE_NONCE: the second run should read the whole prompt
 * from the cache. Skips without LIVE_LITELLM_URL and LIVE_LITELLM_KEY.
 */
import { Agent, tool } from '@strands-agents/sdk';
import { z } from 'zod';
import { config } from '../src/config';
import { LlmService } from '../src/llm/llm.service';
import { liteLlmFetch } from '../src/llm/litellm-fetch';
import { buildRunPrompt, buildSystemPrompt } from '../src/agent/system-prompt';
async function main() {
  if (!process.env.LIVE_LITELLM_URL || !process.env.LIVE_LITELLM_KEY) { console.log('SKIP live cache check: LIVE_LITELLM_URL or LIVE_LITELLM_KEY is not set'); return; }
  (config.litellm as any).base_url = process.env.LIVE_LITELLM_URL ?? '';
  (config.litellm as any).api_key = process.env.LIVE_LITELLM_KEY ?? '';
  const usages: any[] = [];
  const model = new LlmService().createModel({ alias: 'console-agent', user: '11111111-1111-4111-8111-111111111111', maxTokens: 1024,
    fetch: liteLlmFetch({ onResponse: () => {}, onWait: () => {}, onUsage: u => usages.push(u) }) });
  const ticket = 'Ticket body: ' + Array.from({ length: 300 }, (_, i) => `line ${i} about order ${i * 31}.`).join(' ');
  const tools = Array.from({ length: 6 }, (_, i) => tool({ name: `lookup_${i}`, description: 'Reads a record with all its fields and links. '.repeat(20),
    inputSchema: z.object({ id: z.string() }), callback: () => ({ record: { id: `r-${i}`, body: ticket } }) }));
  const agent = new Agent({ model, printer: false, tools, systemPrompt: (process.env.LIVE_NONCE ? `Run ${process.env.LIVE_NONCE}.\n` : '') + buildRunPrompt(buildSystemPrompt({ role: 'moderator', now: new Date('2026-11-18T00:00:00Z') }), {}) });
  await agent.invoke('Call lookup_0 with id "x", then answer in one word.');
  for (const [i, u] of usages.entries()) console.log(`call ${i + 1}: prompt ${u.prompt_tokens}, cache read ${u.cache_read_tokens}, cache write ${u.cache_write_tokens}, uncached ${u.prompt_tokens - u.cache_read_tokens - u.cache_write_tokens}`);
}
main().catch(e => { console.error(e.message); process.exitCode = 1; });
