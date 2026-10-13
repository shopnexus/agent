/**
 * Central config. Parsed and validated once from the environment into a single
 * frozen, snake_case, non-null object. Defaults live here (one place), so the
 * rest of the app reads `config.x.y` directly — no `?? / ||` scattered around.
 * Unset optional resources are empty strings (feature-disabled), never null.
 */
import 'dotenv/config';
import { z } from 'zod';

const str = (def = '') => z.string().default(def);
const int = (def: number) => z.coerce.number().int().default(def);

const env = z
  .object({
    AWS_REGION: str('ap-southeast-1'),
    PORT: int(3000),

    AGENT_MODEL_ID: str('apac.anthropic.claude-3-5-sonnet-20241022-v2:0'),
    AGENT_MAX_TOKENS: int(4096),
    AGENT_THINKING_BUDGET: int(0), // >0 enables extended thinking
    AGENT_MAX_TURNS: int(0), // 0 = unbounded tool-use cycles
    AGENT_TOOL_OUTPUT_CAP: int(20000),
    AGENT_MEMORY_ENTRY_CAP: int(500),
    AGENT_MEMORY_MAX_ENTRIES: int(10),   // top-K facts injected / searched
    AGENT_CONVERSATION_WINDOW: int(40),

    AGENTCORE_MEMORY_ID: z.string().min(1, 'AGENTCORE_MEMORY_ID is required (npm run setup:memory)'),
    AGENTCORE_GATEWAY_URL: str(),

    TAVILY_API_KEY: str(), // enables the web_search tool when set
  })
  .parse(process.env);

export const config = Object.freeze({
  aws_region: env.AWS_REGION,
  port: env.PORT,
  default_actor: 'default-user',

  model: {
    id: env.AGENT_MODEL_ID,
    max_tokens: env.AGENT_MAX_TOKENS,
    thinking_budget: env.AGENT_THINKING_BUDGET,
  },

  agent: {
    max_turns: env.AGENT_MAX_TURNS,
    tool_output_cap: env.AGENT_TOOL_OUTPUT_CAP,
    conversation_window: env.AGENT_CONVERSATION_WINDOW,
  },

  memory: {
    id: env.AGENTCORE_MEMORY_ID,
    entry_cap: env.AGENT_MEMORY_ENTRY_CAP,
    max_entries: env.AGENT_MEMORY_MAX_ENTRIES,
  },

  gateway: {
    url: env.AGENTCORE_GATEWAY_URL,
  },

  web_search: {
    tavily_api_key: env.TAVILY_API_KEY,
  },
});
