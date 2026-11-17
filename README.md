# ShopNexus Agent

The console agent: a NestJS service that answers ShopNexus console members (moderators and admins) about a ticket, a report case or an account. It runs a Strands agent loop on a LiteLLM model and reads data only through server2's MCP server. It has no tool that changes data; members carry out every action in the console (BR-MOD-03).

The service has no public host. server2 checks the console session and role and forwards each request on the internal network.

## Runtime flow

1. `ConsoleMemberGuard` compares the bearer token with `AGENT_SERVICE_TOKEN` in constant time and reads `X-Console-Member` (UUID) and `X-Console-Role` (`moderator` or `admin`). Anything else gets 401. An empty `AGENT_SERVICE_TOKEN` refuses every request.
2. The member must be allowed to see the conversation: every conversation with a subject is shared by all members, and a conversation without one belongs to the member who opened it. Others get 404.
3. The kill switches (`FEATURE_ALL_AGENT`, `FEATURE_LLM`), the rate limit (30 questions a minute per member), the input guard (empty, over 2000 characters, instruction-override patterns) and the 50-turn limit run before a turn opens.
4. The turn opens as `RUNNING` under the conversation's row lock, with the member in `turns.member_id`. A second unfinished turn on the same conversation gets 409 `turn_in_progress`, so two members asking at once queue on the lock.
5. Prior terminal turns replay from `messages` / `message_blocks`, oldest first: user text, terminal answers and complete tool pairs.
6. A new MCP client connects to `MCP_SERVER_URL` for this turn with `Authorization: Bearer AGENT_MCP_TOKEN` and `X-Console-Member`, so server2 checks the member on every tool call. Only tools the server marks `readOnlyHint` are given to the agent; trace `_meta` is not added to tool arguments. The client disconnects when the turn ends.
7. The agent runs with the member's system prompt (role, subject, the moderation and support rules, user content as quoted data) and the `console-agent` model alias. A hook refuses tools outside the turn's set and repeated identical calls; tool calls are written to `tool_calls` and the transcript as they run.
8. Each successful MCP call becomes a source `{tool, label, ids}`: the label is the tool's MCP title, and the ids are the string values of `id`, `*_id`, `ids` and `*_ids` keys in its result. The answer and its sources are stored on the turn's terminal TEXT block, and the turn ends `SUCCEEDED`.
9. A turn past the 60-second deadline ends `TIMED_OUT` (504 `agent_timeout`). A LiteLLM budget error ends it `FAILED` with "Hết hạn mức hôm nay." (429 `agent_budget`) and is not retried. A model or MCP failure ends it `FAILED` (503 `agent_unavailable`). The failed turn keeps a short Vietnamese answer saying what happened.
10. `StuckTurnSweeper` runs at start-up and every `AGENT_SWEEP_INTERVAL_MS`. It closes turns still `RUNNING` 30 seconds past the deadline as `FAILED` with error code `agent_stuck`, after a crash or a lost write, so the conversation takes questions again.

## HTTP API

Every endpoint needs `Authorization: Bearer <AGENT_SERVICE_TOKEN>`, `X-Console-Member` and `X-Console-Role`, and bodies and responses use snake_case field names.

| Method | Path | Input | Output |
|---|---|---|---|
| GET | `/conversations?subject_kind=&subject_id=` | optional filter: a kind, or a kind and an id | `[{id, subject_kind?, subject_id?, title?, updated_at}]`, newest first, at most 50 |
| POST | `/conversations` | `{subject_kind?, subject_id?}` | the record's shared conversation if it exists, else a new one; without a subject, a new conversation of the member's own |
| GET | `/conversations/{id}` | | the conversation and `turns: [{id, member_id, status, text, answer?, sources, created_at}]` |
| POST | `/conversations/{id}/turns` | `{text}` | `{conversation_id, turn_id, answer, sources: [{tool, label, ids}]}` |

`subject_kind` is `ticket`, `report_case` or `account`; `subject_id` is a UUID. A conversation's title is its first question, cut at 80 characters.

Errors are `{code}` with these statuses:

| Status | Code | When |
|---|---|---|
| 400 | `bad_request` | malformed body, filter or empty question |
| 400 | `input_rejected` | the question is longer than 2000 characters |
| 401 | `unauthorized` | token, member or role missing or wrong |
| 404 | `not_found` | unknown conversation, or one the member may not see |
| 409 | `turn_in_progress` | the conversation has an unfinished turn |
| 409 | `conversation_closed` | the conversation is archived or closed |
| 429 | `rate_limited` | more than 30 questions a minute from the member |
| 429 | `agent_budget` | LiteLLM's budget for the alias is spent |
| 504 | `agent_timeout` | the turn passed its deadline |
| 503 | `agent_unavailable` | the model or the MCP server is down, or a kill switch is off |
| 500 | `internal` | anything else |

```bash
curl -X POST http://localhost:3000/conversations \
  -H "Authorization: Bearer $AGENT_SERVICE_TOKEN" \
  -H 'X-Console-Member: 0193a3b0-0000-7000-8000-000000000001' -H 'X-Console-Role: moderator' \
  -H 'Content-Type: application/json' \
  -d '{"subject_kind":"ticket","subject_id":"0193a3b0-0000-7000-8000-0000000000aa"}'
```

## Database: fresh installation

Authoritative DDL: [`docker/init-db/01-init-schema.sql`](docker/init-db/01-init-schema.sql). Prisma migrations: the baseline `20261111000000_new_database` and `20261117000000_console_member`, which adds `conversations.subject_kind` / `subject_id` (unique per subject when set) and `turns.member_id`. The baseline plus the migrations give the same schema as the init script.

Tables: `actors` (console members), `conversations`, `turns`, `messages`, `message_blocks`, `tool_calls`, `retrieval`. There is no compatibility layer for older schemas and no conversion of old data. `retrieval` and `src/retrieval` stay from the shopper agent; no turn uses them.

Prisma maps models and enums; SQL owns partial unique indexes, CHECK constraints, updated-at triggers and the vector, FTS and trigram indexes. Embeddings must be finite, nonzero 1024-dimensional vectors from one embedding space.

The init script runs only on a new PostgreSQL volume. Do not apply it on top of an existing schema, and do not run `prisma migrate deploy` over a schema the init script created unless the migrations are recorded as applied. Provision a separate fresh database rather than deleting volumes to upgrade.

## Components

| Path | Responsibility |
|---|---|
| `src/console` | Service-token guard and the console member |
| `src/agent` | Turn orchestration, system prompt, sources, tool tracking, output cap |
| `src/conversation` | Conversations by subject, visibility, the conversation view |
| `src/db` | Actor, conversation and turn persistence; the ordered typed transcript |
| `src/mcp` | The per-turn MCP client to server2 |
| `src/llm` | The LiteLLM model, budget detection and retry |
| `src/sweep` | The stuck-turn sweep |
| `src/guardrails` | Input guard, loop detector, rate limiter, audit log, PII masking |
| `src/http` | `{code}` errors |
| `src/memory` | History replay from the transcript |

## Local setup

```bash
npm install
cp .env.example .env
# Set AGENT_SERVICE_TOKEN, AGENT_MCP_TOKEN, MCP_SERVER_URL, the LiteLLM and Postgres settings.
docker compose --env-file .env -f docker/docker-compose.yml up -d
npx prisma generate
npm run start:dev
```

Compose starts PostgreSQL and LiteLLM; pass the root `.env` explicitly for interpolation. `AGENT_MODEL_ID` must name a model in `docker/litellm-config.yaml`; locally `console-agent` routes to Gemini Flash Lite. In the cluster, infra's LiteLLM routes `console-agent` to `claude-sonnet-5-5` with a daily budget. `npm run chat` asks as `CLI_MEMBER_ID` through the same turn path and calls the real model and MCP, which may cost money.

## Configuration

See `.env.example` and `src/config.ts` for every setting.

| Variable | Default | Purpose |
|---|---|---|
| `AGENT_SERVICE_TOKEN` | empty (refuse all) | Token server2 sends on every request |
| `AGENT_MCP_TOKEN` | empty (no MCP) | Token sent to server2's MCP on every turn |
| `MCP_SERVER_URL` | empty (no MCP) | server2's `/mcp` endpoint |
| `AGENT_MODEL_ID` | empty | LiteLLM alias, `console-agent` |
| `AGENT_TURN_DEADLINE_MS` | 60000 | Deadline per turn |
| `AGENT_SWEEP_INTERVAL_MS` | 60000 | Stuck-turn sweep period |
| `AGENT_CONVERSATION_WINDOW` | 40 | SDK and restored message ceiling |
| `AGENT_HISTORY_TURNS` | 20 | Maximum prior terminal turns fetched |
| `AGENT_HISTORY_CHARS` | 60000 | Restored history character budget |
| `AGENT_TOOL_OUTPUT_CAP` | 20000 | Tool output kept in context; the rest pages through `read_output` |

Without `MCP_SERVER_URL` or `AGENT_MCP_TOKEN` every turn ends `FAILED` with 503 `agent_unavailable`.

## Verification

```bash
npm run build
npm test                        # Offline suites: scripted model, fake MCP on 127.0.0.1, no database
npx prisma validate
npm run test:database           # Skips unless TEST_DATABASE_URL is set
```

`npm test` covers the guard and error codes over HTTP, shared conversations by subject, the member on turns, sources, the MCP headers and read-only filter against an in-process MCP server, LiteLLM's budget error through the OpenAI provider, the deadline, and the sweep. The database suite needs an already bootstrapped disposable database; it inserts uniquely named fixtures and deletes only those.

## Operational limits

- A cancelled turn cannot stop a server-side MCP call already running.
- Rate limits and kill-switch overrides are per process.
- A conversation has no turn cap; the prompt carries the last `AGENT_HISTORY_TURNS` turns within `AGENT_HISTORY_CHARS`.
- Persistence errors are not treated as success; a database outage can lose a finished answer, and the sweep then closes the turn.
- PII masking applies to audit logs only. Answers may quote personal data the member is allowed to read through server2, which records those reads.
