# ShopNexus Agent

NestJS shopping-support agent using Strands, an OpenAI-compatible LiteLLM gateway, static MCP tools and PostgreSQL/pgvector. Authentication and authoritative commerce data belong to the API gateway and domain services.

## Runtime flow

1. Trust the authenticated gateway's `X-User-ID`, not an actor supplied in the body. Restrict ingress: this service does not authenticate the header itself.
2. Check conversation ownership/status, input, rate limits and feature flags.
3. Lock the conversation and allocate a `RUNNING` turn with the next ordinal and the current user TEXT block. A second unfinished turn returns conflict.
4. Restore prior terminal turns from `messages` / `message_blocks`, oldest first. Replay user text, verified terminal assistant text and complete tool pairs; omit thinking, drafts, progress and orphan results. The current input is appended once by the SDK.
5. Assess support scope, build a fresh restricted agent, execute native tools, verify the generated answer and review its scope. The guarded phase shares a 60-second deadline. Exact greetings need no model call.
6. Tool hooks incrementally persist bounded/redacted audit snapshots and transcript blocks atomically before/after execution. `tool_calls` is audit data, never the replay source.
7. Persist only the verified/fixed final answer as terminal TEXT and finish with `SUCCEEDED`, `FAILED`, `CANCELLED` or `TIMED_OUT`, latency and available generation usage. Late results can complete an existing tool record, never reopen a terminal turn or replace its answer.

HTTP and CLI use the same buffered path; raw SDK drafts are not displayed. Unavailable provider/classifier/verifier calls get a fixed safe response. Failed runs carry an explicit replay marker and do not imply completion. A rejected answer cannot roll back tool side effects: trusted memory-write notices report completion or uncertainty without repeating personal content.

## Database: fresh installation only

Authoritative DDL: [`docker/init-db/01-init-schema.sql`](docker/init-db/01-init-schema.sql).
Prisma baseline: `prisma/migrations/20261111000000_new_database/migration.sql`.

Tables: `actors`, `conversations`, `turns`, `messages`, `message_blocks`, `tool_calls`, `retrieval`. There is no runtime compatibility layer for the old sessions/JSON-message/user-memory schema. The retired migration is a no-op. No old-data conversion is provided.

Prisma maps models/enums; SQL owns partial unique indexes, CHECK constraints, updated-at triggers, vector/FTS/trigram indexes. Embeddings must be finite, nonzero **1024-dimensional** vectors from the same embedding space for ingestion and search.

Bootstrap runs only on a new PostgreSQL volume. Do not apply bootstrap on top of an existing schema and do not run Prisma migration deploy over a schema already initialized by Docker unless the baseline is recorded correctly. Provision a separate fresh database; do not delete existing volumes to upgrade.

## Components

| Path | Responsibility |
|---|---|
| `src/agent` | Guarded orchestration, tool tracking, memory enforcement, output cap |
| `src/conversation` | Conversation lifecycle and ownership |
| `src/db` | Actor/conversation/turn persistence and ordered typed transcript |
| `src/memory` | Native actor-bound memory tools and SDK history adapter |
| `src/retrieval` | Actor-private statements/documents, embeddings and hybrid search |
| `src/guardrails` | Input/output policy, scope, authorization, loop/rate limits, audit |
| `src/llm`, `src/mcp` | LiteLLM clients and startup-configured MCP tools |

## Retrieval and memory

- `memory_save({kind, content, importance?, expiresAt?})`: save one durable personal property as `STATEMENT`; kind is `FACT`, `PREFERENCE` or `SUMMARY`. No category/factKey contract and no automatic overwrite/deduplication.
- `memory_search({query, limit?, origin?})`: actor-scoped hybrid semantic/FTS/trigram retrieval with reciprocal-rank fusion. Results include IDs and document citation metadata. No automatic long-term memory injection.
- `memory_supersede({previousMemoryId, content, ...})`: lock the exact current actor-owned STATEMENT, insert a successor and link the predecessor atomically. Foreign, expired, deleted, superseded and EXCERPT targets are rejected. This is correction, not deletion.
- `RetrievalService.ingestDocument`: accepts extracted text, chunks/embeds it and atomically inserts `EXCERPT` rows with document ID/title/source URI/chunk index/locator. No upload, OCR or public ingestion endpoint is added. Duplicate imports are rejected.

Search filters actor, expiry, deletion and supersession before candidate ranking and respects a character budget. Documents and memories are untrusted references, not instructions or proof of live prices, stock, cart/order state. Live facts require authorized domain tools. Only scope-granted memory operations are exposed; successful writes remain silent in normal replies. See [memory contract](docs/memory.md) and [context contract](docs/context.md).

## HTTP API

All endpoints require gateway-owned `X-User-ID`.

| Method | Path | Input / output |
|---|---|---|
| POST | `/chat` | `{message, conversationId?, context?}` → `{actorId, conversationId, answer}`; creates conversation if omitted |
| POST | `/conversations` | `{context?}` → `{actorId, conversationId}` |
| GET | `/conversations` | Caller-owned active conversation summaries |

`/sessions` and memory CRUD endpoints are not supported. `context.actorId` is overwritten with gateway identity.

```bash
curl -X POST http://localhost:3000/chat \
  -H 'Content-Type: application/json' -H 'X-User-ID: actor-from-gateway' \
  -d '{"message":"Recommend running shoes","context":{"locale":"en"}}'
```

## Local setup

```bash
npm install
cp .env.example .env
# Configure DATABASE_URL, LiteLLM credentials/routes and MCP_SERVER_URL.
# Use a fresh database for this schema.
docker compose --env-file .env -f docker/docker-compose.yml up -d
npx prisma generate
npm run start:dev
```

Compose starts PostgreSQL and LiteLLM. Root `.env` must be passed explicitly for Compose interpolation. NestJS and `npm run mock:mcp` run separately. Model/embedding route names in `.env` must match `docker/litellm-config.yaml`. `npm run chat` runs the interactive CLI; `npm run demo` uses real configured services and may incur model costs.

## Context configuration

See `.env.example` and `src/config.ts` for complete settings.

| Variable | Default | Purpose |
|---|---|---|
| `AGENT_CONVERSATION_WINDOW` | 40 | SDK/restored message ceiling |
| `AGENT_HISTORY_TURNS` | 20 | Maximum prior terminal turns fetched |
| `AGENT_HISTORY_CHARS` | 60000 | Restored history character budget |
| `AGENT_TOOL_OUTPUT_CAP` | 20000 | In-memory tool output before invocation-owned paging |
| `AGENT_MEMORY_ENTRY_CAP` | 500 | Personal statement length ceiling |
| `RETRIEVAL_CONTEXT_CHARS` | 12000 | Total retrieved content budget |
| `DOCUMENT_CHUNK_CHARS` | 2000 | Extracted document chunk length |

## Verification

```bash
npm run build
npm test                       # All offline suites; no external model/database
npx prisma validate
npm run test:database           # Skips unless TEST_DATABASE_URL is explicit
```

Database integration requires an already bootstrapped **disposable test database**. It does not apply/reset schema; it inserts uniquely named fixtures and deletes only those fixtures afterward. It covers competing turn starts, ownership, terminal idempotence, late tool results and real hybrid SQL. Never point it at production.

Live scope evaluation is separately gated by `RUN_SCOPE_LIVE_EVAL=1`; obtain approval before enabling external requests/costs. Offline synthetic passes verify mechanics, not deployed-model comprehension.

## Operational boundaries

- Process crashes can leave `RUNNING` turns blocking a conversation; no automatic recovery/lease or approval/resume workflow is implemented.
- Cancellation cannot undo a tool side effect; noncooperative tools may finish after the response deadline.
- Persistence errors are not silently treated as success; a database outage can prevent returning a completed response.
- Rate limits/feature-flag overrides are process-local. Downstream services must enforce resource ownership independently.
- Available generation usage is persisted; classifier calls and provider failures may not contribute token usage.
- Memory versions are retained; there is no erase interface. Pattern-based sensitive-data checks are not comprehensive DLP.
