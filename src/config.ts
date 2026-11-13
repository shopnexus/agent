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
    DEFAULT_ACTOR: str(),

    // --- Agent Model ---
    AGENT_MODEL_ID: str(),
    AGENT_MAX_TOKENS: int(4096),
    AGENT_THINKING_BUDGET: int(0), // >0 enables extended thinking
    AGENT_MAX_TURNS: int(0), // 0 = unbounded tool-use cycles
    AGENT_TOOL_OUTPUT_CAP: int(20000),
    AGENT_MEMORY_ENTRY_CAP: int(500),
    AGENT_MEMORY_MAX_ENTRIES: int(10), // top-K facts injected / searched
    AGENT_CONVERSATION_WINDOW: int(40),
    AGENT_HISTORY_TURNS: z.coerce.number().int().min(1).max(50).default(20),
    AGENT_HISTORY_CHARS: z.coerce.number().int().min(1000).default(60000),
    AGENT_SCOPE_TIMEOUT_MS: z.coerce.number().int().min(1000).max(60000).default(60000),
    RETRIEVAL_CONTEXT_CHARS: z.coerce.number().int().min(500).default(12000),
    DOCUMENT_CHUNK_CHARS: z.coerce.number().int().min(100).max(10000).default(2000),

    // --- MCP Server & Gateway ---
    MCP_SERVER_URL: str(),

    // --- LiteLLM Proxy Gateway ---
    LITELLM_BASE_URL: str(),
    LITELLM_API_KEY: str(),

    // --- PostgreSQL + pgvector Database ---
    POSTGRES_USER: str(),
    POSTGRES_PASSWORD: str(),
    POSTGRES_HOST: str(),
    POSTGRES_PORT: int(5432),
    POSTGRES_DB: str(),

    // --- Embedding Model ---
    EMBEDDING_MODEL_ID: str(),
  })
  .parse(process.env);

// Fallback: build DATABASE_URL from POSTGRES_* if DATABASE_URL is not set directly
const resolvedDatabaseUrl =`postgresql://${env.POSTGRES_USER}:${env.POSTGRES_PASSWORD}@${env.POSTGRES_HOST}:${env.POSTGRES_PORT}/${env.POSTGRES_DB}`;

export const config = Object.freeze({
  port: env.PORT,
  default_actor: env.DEFAULT_ACTOR,

  model: {
    id: env.AGENT_MODEL_ID,
    max_tokens: env.AGENT_MAX_TOKENS,
    thinking_budget: env.AGENT_THINKING_BUDGET,
  },

  agent: {
    max_turns: env.AGENT_MAX_TURNS,
    tool_output_cap: env.AGENT_TOOL_OUTPUT_CAP,
    conversation_window: env.AGENT_CONVERSATION_WINDOW,
    history_turns: env.AGENT_HISTORY_TURNS,
    history_chars: env.AGENT_HISTORY_CHARS,
    scope_timeout_ms: env.AGENT_SCOPE_TIMEOUT_MS,
  },

  memory: {
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

  retrieval: {
    context_chars: env.RETRIEVAL_CONTEXT_CHARS,
    chunk_chars: env.DOCUMENT_CHUNK_CHARS,
  },

  embedding: {
    model_id: env.EMBEDDING_MODEL_ID,
  },

  gateway: {
    url: env.MCP_SERVER_URL,
  },

  litellm: {
    base_url: env.LITELLM_BASE_URL,
    api_key: env.LITELLM_API_KEY,
  },
});
