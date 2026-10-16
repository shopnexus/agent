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
    DEFAULT_ACTOR: str('default-user'),

    // --- Agent Model ---
    AGENT_MODEL_ID: str('gemini-2.5-flash'),
    AGENT_MAX_TOKENS: int(4096),
    AGENT_THINKING_BUDGET: int(0), // >0 enables extended thinking
    AGENT_MAX_TURNS: int(0), // 0 = unbounded tool-use cycles
    AGENT_TOOL_OUTPUT_CAP: int(20000),
    AGENT_MEMORY_ENTRY_CAP: int(500),
    AGENT_MEMORY_MAX_ENTRIES: int(10), // top-K facts injected / searched
    AGENT_CONVERSATION_WINDOW: int(40),

    // --- MCP Server & Gateway ---
    MCP_SERVER_URL: str(),
    AGENTCORE_GATEWAY_URL: str(),
    AGENTCORE_MEMORY_ID: str(),

    // --- Web Search ---
    TAVILY_API_KEY: str(), // enables the web_search tool when set

    // --- LiteLLM Proxy Gateway ---
    LITELLM_BASE_URL: str('http://localhost:4000/v1'),
    LITELLM_API_KEY: str('sk-local-dev-key'),
    GEMINI_API_KEY: str(),

    // --- PostgreSQL + pgvector Database ---
    POSTGRES_USER: str('postgres'),
    POSTGRES_PASSWORD: str('postgres'),
    POSTGRES_HOST: str('localhost'),
    POSTGRES_PORT: int(5432),
    POSTGRES_DB: str('shopnexus_agent'),
    DATABASE_URL: str(),

    // --- Embedding Model ---
    EMBEDDING_MODEL_ID: str('text-embedding-default'),
  })
  .parse(process.env);

// Fallback: build DATABASE_URL from POSTGRES_* if DATABASE_URL is not set directly
const resolvedDatabaseUrl =
  env.DATABASE_URL ||
  `postgresql://${env.POSTGRES_USER}:${env.POSTGRES_PASSWORD}@${env.POSTGRES_HOST}:${env.POSTGRES_PORT}/${env.POSTGRES_DB}`;

export const config = Object.freeze({
  aws_region: env.AWS_REGION,
  port: env.PORT,
  default_actor: env.DEFAULT_ACTOR,
  gemini_api_key: env.GEMINI_API_KEY,

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

  database: {
    url: resolvedDatabaseUrl,
    user: env.POSTGRES_USER,
    password: env.POSTGRES_PASSWORD,
    host: env.POSTGRES_HOST,
    port: env.POSTGRES_PORT,
    db: env.POSTGRES_DB,
  },

  embedding: {
    model_id: env.EMBEDDING_MODEL_ID,
  },

  gateway: {
    url: env.MCP_SERVER_URL || env.AGENTCORE_GATEWAY_URL,
  },

  web_search: {
    tavily_api_key: env.TAVILY_API_KEY,
  },

  litellm: {
    base_url: env.LITELLM_BASE_URL,
    api_key: env.LITELLM_API_KEY,
  },
});
