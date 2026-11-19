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
    PORT: int(3000),

    // --- Service trust: server calls POST /runs with this token ---
    AGENT_SERVICE_TOKEN: str(),
    // --- Token this service sends to server's MCP and control endpoint ---
    AGENT_MCP_TOKEN: str(),
    // --- `npm run chat` only: the console member the CLI asks as ---
    CLI_MEMBER_ID: str(),
    CLI_MEMBER_ROLE: z.enum(['moderator', 'admin']).default('moderator'),

    // --- Agent Model ---
    AGENT_MODEL_ID: str(),
    AGENT_MAX_TOKENS: int(4096),
    AGENT_THINKING_BUDGET: int(0), // >0 enables extended thinking
    AGENT_TOOL_OUTPUT_CAP: int(20000),
    AGENT_CONVERSATION_WINDOW: int(40),
    AGENT_HISTORY_CHARS: z.coerce.number().int().min(1000).default(60000),
    AGENT_TURN_DEADLINE_MS: z.coerce.number().int().min(1000).max(600000).default(60000),
    // Defaults for what agent_config.limits leaves out.
    AGENT_CONTEXT_WINDOW: z.coerce.number().int().min(4000).default(128000),
    AGENT_TOOL_TIMEOUT_MS: z.coerce.number().int().min(1000).max(300000).default(20000),
    AGENT_TOOL_ATTEMPTS: z.coerce.number().int().min(1).max(5).default(3),
    AGENT_MAX_MODEL_CALLS: z.coerce.number().int().min(1).max(200).default(40),

    // --- MCP server: server's /mcp; its origin also serves the control endpoint ---
    MCP_SERVER_URL: str(),

    // --- LiteLLM Proxy Gateway ---
    LITELLM_BASE_URL: str(),
    LITELLM_API_KEY: str(),
  })
  .parse(process.env);

export const config = Object.freeze({
  port: env.PORT,

  console: {
    service_token: env.AGENT_SERVICE_TOKEN,
    mcp_token: env.AGENT_MCP_TOKEN,
  },

  cli: {
    member_id: env.CLI_MEMBER_ID,
    member_role: env.CLI_MEMBER_ROLE,
  },

  model: {
    id: env.AGENT_MODEL_ID,
    max_tokens: env.AGENT_MAX_TOKENS,
    thinking_budget: env.AGENT_THINKING_BUDGET,
  },

  agent: {
    tool_output_cap: env.AGENT_TOOL_OUTPUT_CAP,
    conversation_window: env.AGENT_CONVERSATION_WINDOW,
    history_chars: env.AGENT_HISTORY_CHARS,
    turn_deadline_ms: env.AGENT_TURN_DEADLINE_MS,
    context_window: env.AGENT_CONTEXT_WINDOW,
    tool_timeout_ms: env.AGENT_TOOL_TIMEOUT_MS,
    tool_attempts: env.AGENT_TOOL_ATTEMPTS,
    max_model_calls: env.AGENT_MAX_MODEL_CALLS,
  },

  mcp: {
    url: env.MCP_SERVER_URL,
  },

  litellm: {
    base_url: env.LITELLM_BASE_URL,
    api_key: env.LITELLM_API_KEY,
  },
});
