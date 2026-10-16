# shopnexus-agent

A NestJS AI agent driving the **ShopNexus** e-commerce platform, built on the **Strands Agents SDK**. The agent supports both **Buyers** (product discovery, sizing, preference recall, order status) and **Sellers** (store policies, customer service, dispute guidance).

LLM inference is routed through an OpenAI-compatible **LiteLLM Proxy**, and long-term personalization memory is persisted locally in **PostgreSQL + pgvector** using a 2-branch hybrid retrieval engine.

| Core feature | Module | Tech / Protocol |
|---|---|---|
| LLM inference | `src/llm` | LiteLLM Proxy (`/v1/chat/completions`) → Bedrock (Claude 3.5 Sonnet) / OpenAI / Gemini / Ollama |
| Personalization memory | `src/memory` | PostgreSQL 16 + pgvector (`retrieval.user_memories`) + LiteLLM embeddings |
| Chat sessions (new / list) | `src/session` | In-memory / data-plane session tracking |
| MCP tools + runtime install | `src/mcp` | Strands `McpClient` → MCP Gateway / remote MCP servers |
| Web search | `src/tools/web-search` | Tavily Search API (optional) |
| Output pagination | `src/agent/output-cap` | Spills oversized tool results (>20KB) to disk with paging via `read_output` |

### Tools the agent can call

Assembled per turn in `AgentService.prepareAgent` (`src/agent/agent.service.ts`):

| Tool | Source | What it does |
|---|---|---|
| `remember_fact` | `src/memory/remember-fact` | Persists buyer sizing/preferences or seller policies with PII guardrails |
| `search_memory` | `MemoryManager.getTools()` | Actively recalls past facts using a hybrid vector + full-text search query |
| `read_output` | `src/agent/output-cap` | Pages through truncated tool output that exceeded the 20KB cap |
| `install_mcp` | `src/mcp` | Registers a remote MCP server by URL at runtime |
| `web_search` | `src/tools/web-search` | Live web search via Tavily (only if `TAVILY_API_KEY` is set) |
| Gateway / installed | `src/mcp` | Domain tools exposed via the MCP Gateway (product search, cart, orders) |

The model discovers tools from their definitions (tool specs) — the system prompt does **not** hardcode a tool list, so adding or removing tools requires no prompt changes.

---

## Flows

### Architecture — how a request fans out

```mermaid
flowchart LR
  Client -->|/chat, /sessions or CLI| Agent[AgentService]
  Agent --> Llm[LlmService]
  Agent --> Mem[MemoryService]
  Agent --> Mcp[McpService]
  Agent --> Web[web_search]

  Llm -->|OpenAI Chat API :4000| LiteLLM[(LiteLLM Proxy)]
  LiteLLM -->|Converse| Bedrock[(AWS Bedrock: Claude 3.5)]
  LiteLLM -.->|Alternative| OtherLLMs[(Gemini / OpenAI / Ollama)]

  Mem -->|Embeddings :4000| LiteLLM
  Mem -->|Hybrid SQL :5432| Postgres[(PostgreSQL + pgvector)]

  Mcp -->|SSE / HTTP| Gateway[(MCP Gateway / Target MCPs)]
  Web -->|HTTPS| Tavily[(Tavily API)]
```

### One chat turn

```mermaid
sequenceDiagram
  actor U as User (Buyer / Seller)
  participant A as AgentService
  participant M as MemoryService
  participant L as LiteLLM (via Strands loop)
  participant T as Tools (MCP / Tavily / Memory)

  U->>A: chat(actorId, sessionId, message, context)
  A->>M: createManager(actorId, role)
  Note over A,M: MemoryManager auto-injects relevant <memory> block into prompt
  M-->>A: memory block ([size_fit], [preference], [shop_policy])
  A->>L: invoke(message, tools) with grounding systemPrompt
  loop while stopReason == tool_use (Strands loop)
    L-->>A: tool_use (e.g. search_products, remember_fact)
    A->>T: run tool
    Note over A,T: AfterToolCall hook caps oversized output (spill + read_output)
    T-->>A: result
    A->>L: feed result back
  end
  L-->>A: final answer (stopReason == end_turn)
  A->>M: saveTurn(user, assistant)
  A-->>U: answer (streamed in the CLI)
```

### Memory lifecycle (e-commerce hybrid retrieval)

```mermaid
flowchart TD
  UserFact["User shares fact<br/>(size, preference, policy)"] --> Guardrails{"PII Guardrails<br/>(cards, OTP, passwords, CCCD)"}
  Guardrails -->|Blocked| Reject["Reject: Sensitive PII"]
  Guardrails -->|Passed| LiteLLM["Generate Vector<br/>(LiteLLM /v1/embeddings)"]
  LiteLLM --> Store["Insert into retrieval.user_memories<br/>(user_id, role, category, embedding)"]
  Store --> Supersede["Check & supersede older<br/>conflicting facts in same category"]
  
  Query["Turn prompt or search_memory"] --> HybridSearch["Hybrid Search:<br/>Cosine Distance + Postgres FTS"]
  Store --> HybridSearch
  HybridSearch --> RRF["Reciprocal Rank Fusion (RRF)<br/>score = 1/(60+r_vec) + 1/(60+r_fts)"]
  RRF --> Block["Top-K injected as bounded &lt;memory&gt; block"]
```

---

## Runtime behaviours

- **Grounding system prompt** (`buildSystemPrompt`): Rebuilt each turn with the real current datetime (ISO format), role-specific guidelines (`buyer` or `seller`), and active page context (`product`, `cart`, `order`, `home`). Instructs the model to trust tool results over training priors and forbids fabricating inventory, stock, or prices.
- **E-commerce personalization memory**: Facts are partitioned by role (`buyer` | `seller`) across 5 dedicated categories: `size_fit` (shoe/apparel sizes), `preference` (brands, colors, price range), `profile` (preferred delivery location, nickname), `feedback` (past purchase sentiment), and `shop_policy` (seller return/warranty policies). Outdated facts are automatically marked `superseded_at = NOW()` when superseded.
- **Sensitive data guardrails** (`src/memory/remember-fact.ts`): Pre-write guardrails block credit/debit card numbers, CVV/CVC, OTP/PIN codes, passwords/API keys, Vietnamese national IDs (CCCD/CMND), and bank account numbers before any data reaches the database.
- **Hybrid vector + lexical retrieval**: Uses PostgreSQL 16 `pgvector` for cosine distance and full-text search (`to_tsvector('simple')`) with Unicode NFC normalization. Merged using Reciprocal Rank Fusion (RRF) to match both conceptual meaning and exact tokens (e.g. "size 42", "Nike Pegasus", "Quận 1").
- **Bounded tool output** (`src/agent/output-cap.ts`): An `AfterToolCallEvent` hook caps tool results exceeding `AGENT_TOOL_OUTPUT_CAP` (default 20,000 chars); excess text spills to a temp file that the model pages through via `read_output(id, offset/limit)`.
- **Bounded history**: `SlidingWindowConversationManager` preserves recent messages while maintaining tool call/result pairs and pruning older turns so multi-cycle tool execution does not cause context exhaustion.
- **Provider-agnostic LLM Gateway**: Requests use the standard OpenAI Chat Completion protocol pointed at the local LiteLLM Proxy. Switching from Claude to GPT-4o, Gemini 2.5, or local Ollama requires updating only `docker/litellm-config.yaml` and `.env`.
- **Runtime MCP install**: Say *"install this MCP: <https://example.com/mcp>"* and the `install_mcp` tool registers the server (persisted in `data/mcp-servers.json`). The agent rebuilds its toolset dynamically for subsequent turns.

---

## Configuration

All configuration is parsed and validated once using Zod into a frozen object in `src/config.ts`. Defaults live in code, so most environment variables are optional. See `.env.example`.

### Key environment variables

| Env | Default | Effect |
|---|---|---|
| `AGENT_MODEL_ID` | `claude-3.5-sonnet` | Model name routed by LiteLLM Proxy |
| `LITELLM_BASE_URL` | `http://localhost:4000/v1` | Base URL of the LiteLLM Proxy |
| `LITELLM_API_KEY` | `sk-local-dev-key` | Master key for LiteLLM Proxy authentication |
| `DATABASE_URL` | `postgresql://postgres:postgres@localhost:5432/shopnexus_agent` | PostgreSQL connection string for pgvector memory |
| `EMBEDDING_MODEL_ID` | `text-embedding-default` | Embedding model ID in `litellm-config.yaml` (1536 dimensions) |
| `AGENT_MAX_TOKENS` | `4096` | Max output tokens generated per model call |
| `AGENT_THINKING_BUDGET` | `0` | > 0 enables Claude extended thinking tokens (temperature forced to 1) |
| `AGENT_MAX_TURNS` | `0` (unbounded) | Cap on tool-use cycles per turn |
| `AGENT_TOOL_OUTPUT_CAP` | `20000` | Max characters allowed in a tool result before disk spillover |
| `AGENT_MEMORY_ENTRY_CAP` | `500` | Max characters per injected memory entry |
| `AGENT_CONVERSATION_WINDOW`| `40` | Recent messages retained in the conversation sliding window |
| `TAVILY_API_KEY` | — | Enables the `web_search` tool when provided |

---

## Setup

### 1. Install dependencies

```bash
pnpm install
cp .env.example .env
```

### 2. Start local infrastructure (LiteLLM Proxy & PostgreSQL pgvector)

```bash
docker compose -f docker/docker-compose.yml up -d
```

This starts:
- **LiteLLM Proxy** on port `4000` (configured with `docker/litellm-config.yaml`).
- **PostgreSQL 16 + pgvector** on port `5432` (automatically executes `docker/init-db/01-init-memory.sql` to initialize extensions and the `retrieval.user_memories` table).

Verify proxy health:
```bash
curl http://localhost:4000/health
```

### 3. Build the project

```bash
pnpm run build
```

---

## Run

```bash
# Interactive CLI: streams thinking, tool calls, outputs, and final responses
pnpm run chat

# Scripted demo
pnpm run demo

# Start NestJS HTTP API server on :3000
pnpm run start:dev
```

### HTTP API Examples

#### 1. Chat turn with Buyer context
```bash
curl -s http://localhost:3000/chat \
  -H 'Content-Type: application/json' \
  -d '{
    "actorId": "buyer-123",
    "message": "Recommend a pair of running shoes under $100. I wear size 42.",
    "context": {
      "role": "buyer",
      "locale": "en",
      "page": "product"
    }
  }'
```

#### 2. Chat turn with Seller context
```bash
curl -s http://localhost:3000/chat \
  -H 'Content-Type: application/json' \
  -d '{
    "actorId": "seller-456",
    "message": "A customer is asking for a return on an opened electronic item. What is our policy?",
    "context": {
      "role": "seller",
      "locale": "en"
    }
  }'
```

#### 3. Session management
```bash
# Create a new chat session explicitly:
curl -s -X POST http://localhost:3000/sessions \
  -H 'Content-Type: application/json' \
  -d '{"actorId": "buyer-123"}'

# List active sessions for an actor:
curl -s 'http://localhost:3000/sessions?actorId=buyer-123'
```

---

## Project Structure

```text
agent/
├── docker/
│   ├── docker-compose.yml          # LiteLLM Proxy & PostgreSQL pgvector services
│   ├── litellm-config.yaml         # Upstream LLM and Embedding routing definitions
│   └── init-db/
│       └── 01-init-memory.sql      # Schema migration: pgvector extension & user_memories table
├── src/
│   ├── agent/                      # Core agent loop, system prompt, controller & output cap
│   │   ├── agent.controller.ts     # HTTP endpoints (/chat, /sessions)
│   │   ├── agent.service.ts        # Agent preparation, context injection, invoke/stream
│   │   └── output-cap.ts           # Hook & paging tool for oversized tool outputs
│   ├── db/                         # Database connection
│   │   └── db.pool.ts              # PostgreSQL connection pool with schema auto-init
│   ├── llm/                        # LiteLLM client integration
│   │   ├── llm.service.ts          # Wraps OpenAIModel from Strands SDK for chat
│   │   └── embedding.service.ts    # Generates vectors via LiteLLM /v1/embeddings
│   ├── memory/                     # E-commerce personalization memory
│   │   ├── memory.service.ts       # Integrates MemoryRepository with Strands MemoryStore
│   │   ├── memory.repository.ts    # pgvector + FTS hybrid search & supersede operations
│   │   ├── remember-fact.ts        # Tool for saving facts with PII guardrails
│   │   └── types.ts                # Memory types, roles (buyer/seller), categories
│   ├── mcp/                        # MCP client connection & runtime install
│   ├── session/                    # Session lifecycle tracking
│   ├── tools/                      # Toolset registry & Tavily web search
│   ├── app.module.ts               # Root NestJS module registering all services
│   ├── cli.ts                      # Terminal interactive chat REPL
│   ├── config.ts                   # Centralized Zod configuration validation
│   └── main.ts                     # NestJS application bootstrap
├── package.json
└── tsconfig.json
```
