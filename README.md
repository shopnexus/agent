# ShopNexus Agent

The console agent: a NestJS service that answers ShopNexus console members (moderators and admins) about a ticket, a report case or an account. It runs a Strands agent loop on a LiteLLM model and reads data only through server's MCP server. It has no tool that changes data; members carry out every action in the console (BR-MOD-03).

The service has no public host. server checks the console session and role and forwards each request on the internal network.

## Runtime flow

1. `ConsoleMemberGuard` compares the bearer token with `AGENT_SERVICE_TOKEN` in constant time and reads `X-Console-Member` (UUID) and `X-Console-Role` (`moderator` or `admin`). Anything else gets 401. An empty `AGENT_SERVICE_TOKEN` refuses every request.
2. The member must be allowed to see the conversation: every conversation with a subject is shared by all members, and a conversation without one belongs to the member who opened it. Others get 404.
3. The kill switches (`FEATURE_ALL_AGENT`, `FEATURE_LLM`), the rate limit (30 questions or updates a minute per member), the input guard (empty, over 2000 characters) and `agent_config` validation run before a turn opens.
4. The turn opens as `RUNNING` under the conversation's row lock, with the member in `turns.member_id`, the agent's id and name, its deadline and the run state in `turns.state`. A second unfinished turn (`RUNNING`, `PAUSED`, `AWAITING_INPUT`) on the same conversation gets 409 `turn_in_progress`. The request answers 202 `{conversation_id, turn_id}`; the run goes on in the background on the replica that took the request.
5. Prior terminal turns replay from `messages` / `message_blocks`, oldest first: user text, terminal answers and complete tool pairs.
6. A new MCP client connects to `MCP_SERVER_URL` for each run segment with `Authorization: Bearer AGENT_MCP_TOKEN` and `X-Console-Member`, so server checks the member on every tool call. Only tools the server marks `readOnlyHint` and that `agent_config.tools` allows are given to the agent. Each call has a time limit and is retried on a timeout or a dropped connection.
7. The agent runs on the alias in `agent_config.alias` (else `AGENT_MODEL_ID`) with `user=<member id>` on every LiteLLM call, so LiteLLM applies the member's end-user budget. The system prompt is the built-in prompt (role, subject, the moderation and support rules), the output-tool rules, `agent_config.instructions` and the skill's prompt when the turn names one.
8. The model shapes the run through output tools: `begin_step` / `end_step`, `answer`, `write_document` and `ask_user`. Their arguments are checked by schema; an invalid call goes back to the model as a tool error.
9. Each event is written to `turn_events` and added to the Redis stream `turn:{id}`. Readers follow it through `GET /turns/{id}/events` on any replica.
10. Before each model call the runner saves a checkpoint of the run state, reads pause and steering from `turn:{id}:control`, and compacts the context when the last call used more than 80 % of the window. Stop now aborts the call in flight at once.
11. A segment ends in one of four ways: an answer (`SUCCEEDED`), a pause (`PAUSED`), questions for the member (`AWAITING_INPUT`) or a failure (`FAILED`, `TIMED_OUT`). The turn's status changes first, then the event is written.
12. `StuckTurnSweeper` runs at start-up and every `AGENT_SWEEP_INTERVAL_MS`. It closes turns still `RUNNING` 30 seconds past their segment's deadline (`run_started_at + deadline_ms`) as `FAILED` with `agent_stuck` and writes `turn.finished`. Such a turn can be continued from its last checkpoint if it wrote something.

## Runs

### Turn states

| From | To | When |
|---|---|---|
| `RUNNING` | `PAUSED` | Pause took effect before the next model call, or Stop now |
| `RUNNING` | `AWAITING_INPUT` | the model called `ask_user` |
| `RUNNING` | `SUCCEEDED`, `FAILED`, `TIMED_OUT` | the segment ended |
| `PAUSED` | `RUNNING` | Continue, or a steering message |
| `PAUSED`, `AWAITING_INPUT` | `CANCELLED` | End |
| `AWAITING_INPUT` | `RUNNING` | the member's answers |
| `FAILED`, `TIMED_OUT` | `RUNNING` | Continue, when continuable |

A `FAILED` or `TIMED_OUT` turn is continuable when it is the conversation's latest turn, it wrote something (a step, a tool call, text or an answer) and its error code is `agent_timeout`, `agent_failed`, `agent_limit`, `agent_context` or `agent_stuck`. A spent budget (`agent_budget`), a guardrail block (`agent_blocked`) and a run that failed before writing anything (`agent_unavailable`) are not. Continuing removes the failed run's stored answer and clears the error code.

A continued turn keeps its id, sources, steps and usage totals, and gets a new deadline for the segment. It resumes from `turns.state`: the Strands messages as they stood, with an "interrupted" result for any tool call that has none, and a context-only "continue without repeating" message when the history ends on assistant text.

### Run control

- Pause takes effect before the next model call. The call in flight and the tools it asked for finish, so every call keeps its result. A pause that arrives after the model has started its final answer has no call left to stop before, and the turn finishes as usual.
- Stop now aborts the call in flight at once. The turn lands `PAUSED` with reason `stop_now` and can be continued. A server-side MCP call already running is not stopped.
- A steering message sent while the run is going waits in `turn:{id}:control` and is added as a user message ("Update from the member: …") before the next model call; `steer.read` names the update and the step it was read in. Sent to a paused turn, it continues the turn and is read before the first call. An update read from the stream but not yet given to the model is kept in the run state.
- Pause and Stop now sent before a segment started are ignored by it.

### Answer content

- `answer(blocks)` takes `text {markdown}`, `figures {items}` (2 to 4), `table {columns, rows}` (at most 20 rows, every row as wide as the columns), `chart {kind: bar|stacked_bar|line, labels, series}` (each series as long as the labels), `document_ref {document_id, version}` (a document of the same chat) and `follow_ups {items}` (at most 3). Text the model writes without calling `answer` becomes one `text` block.
- Every record a successful MCP call returns becomes a numbered source `{n, kind, record_id, label, meta, facts: [{label, value}], quote, call_id, tool}`, in the order results arrive. The record is recognised by its shape in server's MCP results:
  - `account`: an object with `display_name` (accounts, the person on a ticket, a seller, the account of a report case). The label is the display name; meta is its role where it appears (Account, Customer, Seller, Buyer, Reported account), the id's last six characters and its status, as in "Seller · 7d22e9 · active".
  - `ticket`: an object with `kind` and `opened_at`. The label is the person's name ("Lan's ticket"), or the kind and date when the result has no person; meta "Ticket · not received · open".
  - `report`: a report case (`account_id` with `reasons` or `reports`; its id is the account's), labelled "Report case: <account>" with meta "3 reports · scam · open", and each report in it ("Report by <reporter>").
  - `order`: an object with `code` or `listing_title`, or held under `order`; labelled "Order: <listing title>".
  - `listing`: an object with `title`; labelled by the title.
  - `log`: a console action (`action` and `target_kind`), labelled "<action> by <actor>" with meta "Console action · <date> · <target kind>".
  - `member`: the console member named in an action (`actor_kind` member) or a case's resolution, labelled by their name.
  - `data`: a result with no record (a count, a price guide, an empty list), one source for the call. The label says what was asked ("Reports, last 7 days", "Support tickets, open") and meta is "<tool> · N rows"; `record_id` is the tool call's id.
- `facts` holds up to four facts from the result for that record (status, price, dates, counts). `quote` is what the record's people wrote (a ticket's message, a report's note, a listing's description), cut at 200 characters. A bare `*_id` reference is no source: it has no name. Labels are never ids.
- A record seen again keeps its number; a fuller reading of it (more facts, as from a `*_get` tool) replaces its label, meta and facts. Each tool result starts with a header listing its numbers and labels, and `[n]` markers that name no source are dropped from the answer. The answer's stored sources and `turn.finished.sources` are those its text and table cells cite, or all of them when it cites none; the run state keeps every number. Sources stored before `meta` and `facts` existed read with empty ones.
- `write_document {title, sections, document_id?}` writes a new document, or a new version of one in the same chat, to `documents` and `document_versions`. Sections are `markdown`, `table` and `chart`.
- `ask_user {questions}` ends the model call; the turn goes `AWAITING_INPUT` and `clarify` carries the questions. `POST /turns/{id}/input` checks the answers against them and continues the run.

### Context and usage

- After each model call `context.meter` reports the call's input plus output tokens against `agent_config.limits.context_window` (default `AGENT_CONTEXT_WINDOW`). Past 80 % the runner summarises everything before the last assistant message with the same model, replaces it with one user message holding the summary and the member's question, and writes `context.compacting` and `context.compacted`.
- A 429 from LiteLLM that is not a spent budget is waited out at the fetch boundary: the wait comes from `reset_at`, `retry-after-ms` or `retry-after` (60 s when none is given), a `rate.waiting {until}` event is written and the same request goes again. A run waits at most three times and at most 90 s each; Stop now and the deadline end a wait.
- LiteLLM's response headers give each call's cost (`x-litellm-response-cost`), provider (the host of `x-litellm-model-api-base`, else `x-litellm-model-id`) and fallbacks (`x-litellm-attempted-fallbacks`). `model.switched` is written when the provider differs from the previous call's or LiteLLM fell back. Usage is summed on the turn: `input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_write_tokens`, `cost_usd`, `first_token_ms` (the turn's first call) and `provider` (the last).
- `input_tokens` is uncached input: the prompt less cache reads and writes. The cache counts are read off the streamed response's `usage` (`prompt_tokens_details.cached_tokens` and `cache_write_tokens` or `cache_creation_tokens`, or Anthropic's `cache_read_input_tokens` and `cache_creation_input_tokens`), since the OpenAI provider keeps only prompt and completion tokens. `context.meter` counts the whole prompt.
- Prompt caching for the `openai/claude-*` deployments is the upstream's own: it caches the prompt prefix (tools, system prompt, messages) with a breakpoint at the end of each request, so a run's next call and the next turn read what the last call wrote. The agent sends no `cache_control`. Checked on the dev stack with `npm run test:live-cache` (see Verification).

### Events

Every event is `{seq, type, at, …body}`. `seq` counts from 1 per turn and is the SSE `id`.

| Type | Body |
|---|---|
| `turn.started` | `agent {id, name}`, `model` (the alias), `deadline_s` |
| `turn.resumed` | `by`: `continue`, `steer` or `input` |
| `step.started` | `step_id`, `title` |
| `step.finished` | `step_id`, `summary`, `duration_ms` |
| `tool.started` | `call_id`, `step_id`, `tool`, `label`, `input` (cut at 2000 characters) |
| `tool.retry` | `call_id`, `attempt`, `error`, `next_in_ms`, `timeout_ms` |
| `tool.finished` | `call_id`, `status` (`success`, `failed`, `skipped`), `duration_ms`, `timing {queued, server, db, return}`, `result_summary`, `source_ids`, `sources` |
| `model.switched` | `from_provider`, `to_provider`, `reason` |
| `thinking` | `summary`, `duration_ms` |
| `text.delta` | `delta`; deltas are merged about every 120 ms or 400 characters |
| `block` | `block`: one answer block |
| `clarify` | `questions` |
| `usage` | `input_tokens` (uncached), `output_tokens`, `cache_read_tokens`, `cache_write_tokens`, `cost_usd`, `provider`, `first_token_ms` |
| `steer.read` | `steer_id`, `step_id` (the open step, or null), `step_number` |
| `turn.pausing` | `steps_done`, `reason` (`member`, `stop_now`) |
| `turn.paused` | `steps_done`, `reason` |
| `rate.waiting` | `until` |
| `context.compacting` | `before_tokens` |
| `context.compacted` | `summary`, `before_tokens`, `after_tokens` |
| `context.meter` | `used_tokens`, `window_tokens` |
| `guardrail` | `rule` (`loop_stopped`, `rate_limited`), `detail` |
| `turn.finished` | `status` (`SUCCEEDED`, `FAILED`, `CANCELLED`, `TIMED_OUT`, `BUDGET`), `outcome` (null on success, else `stopped`, `out_of_room`, `broken`, `unavailable`, `blocked`), `failure` (the error code), `continuable`, `sources` |

`timing`: `queued` is the time from the model's tool request to the call starting, `server` the call itself, `db` what server reports as `db_ms` in the result (null otherwise), `return` the time from the call's end to the result being recorded.

Error codes and outcomes: `agent_timeout`, `agent_limit` (model calls ran out) and `agent_context` are `out_of_room`; `agent_failed` and `agent_stuck` are `broken`; `agent_unavailable` is `unavailable`; `agent_budget` and `agent_blocked` are `blocked`. `CANCELLED` is `stopped`.

### Stream

`GET /turns/{id}/events` replays `turn_events` after `Last-Event-ID` (or `?after=`), then follows `turn:{id}` with `XREAD BLOCK`. The reader notes the stream's last id before the replay, skips entries it has already sent and fills a gap in seq from PostgreSQL. Every 15 s without events it sends a `: keep-alive` comment and checks PostgreSQL, so a lost or expired Redis stream still delivers. Closing the stream leaves the run going. The stream ends after `turn.finished`, `turn.paused` or `clarify`, or 10 s after the turn stopped running with nothing new; after Continue, input or a steering message to a paused turn the console reconnects with its last seq.

`turn:{id}` keeps about 2000 entries (`MAXLEN ~`). Both streams expire one hour after the turn stops writing and are made persistent again when it continues. Without `REDIS_URL` the bus stays in the process, which works with one replica only.

## HTTP API

Every endpoint needs `Authorization: Bearer <AGENT_SERVICE_TOKEN>`, `X-Console-Member` and `X-Console-Role`, and bodies and responses use snake_case field names.

| Method | Path | Input | Output |
|---|---|---|---|
| GET | `/conversations?subject_kind=&subject_id=` | optional filter: a kind, or a kind and an id | `[{id, subject_kind?, subject_id?, title?, updated_at}]`, newest first, at most 50 |
| POST | `/conversations` | `{subject_kind?, subject_id?}` | the record's shared conversation if it exists, else a new one; without a subject, a new conversation of the member's own |
| GET | `/conversations/{id}` | | the conversation and `turns` (see the turn view) |
| PATCH | `/conversations/{id}` | `{title}` | the conversation renamed (1 to 80 characters); a member renames their own subject-less conversation, an admin any; another member's own is 404, a shared one 403 for a moderator |
| DELETE | `/conversations/{id}` | | 204; the turns, events, messages and documents go with it; who may is as for PATCH; 409 `turn_in_progress` while a turn runs, is paused or waits for answers |
| POST | `/conversations/{id}/turns` | `{text, agent_config?, skill_id?, attachments?}` | 202 `{conversation_id, turn_id}` |
| GET | `/turns/{id}` | | the turn view; a turn that ended carries `finished_at` and `duration_ms` (time worked, pauses left out) |
| GET | `/turns/{id}/events` | `Last-Event-ID` header or `?after=` | `text/event-stream` |
| POST | `/turns/{id}/pause` | | 202 `{}`; the turn must be `RUNNING` |
| POST | `/turns/{id}/stop` | | 202 `{}` (Stop now); the turn must be `RUNNING` |
| POST | `/turns/{id}/steer` | `{text}` | 202 `{steer_id, resumed}`; `RUNNING` queues it, `PAUSED` continues the turn |
| POST | `/turns/{id}/continue` | | 202 `{turn_id}`; `PAUSED` or a continuable `FAILED` / `TIMED_OUT` turn |
| POST | `/turns/{id}/end` | | 200 `{status: "CANCELLED"}`; `PAUSED` or `AWAITING_INPUT` |
| POST | `/turns/{id}/input` | `{answers: {question_id: option_id or [option_id]}}` | 202 `{turn_id}`; `AWAITING_INPUT` |
| GET | `/tool-calls/{id}` | | `{id, turn_id, tool, label, status, input, output, output_spilled, attempts, attempt_errors: [{attempt, error, at}], started_at, finished_at, duration_ms, timing}` |
| GET | `/stats/tools?range=` | `7d` (default), `30d` or `90d` | `{items: [{name, calls, failed, p50_ms, days: [{date, calls}]}], recent: [{call_id, turn_id, member_id, tool, label, duration_ms, status, at}]}`; admins only |
| GET | `/stats/guardrails?range=` | as above | `{items: [{rule, count}], recent: [{rule, detail, member_id, turn_id, at}]}`; admins only |
| GET | `/stats/turns?range=` | as above | `{by_agent: [{agent_id, requests, days: [{date, requests}]}], by_member: [{member_id, requests}]}`; admins only |
| GET | `/documents/{id}` | | `{id, conversation_id, turn_id, title, latest_version, created_by, created_at, updated_at, versions: [{version, title, sections, turn_id, created_by, created_at}]}`, newest version first |
| GET | `/skills` | | every skill, by name |
| GET | `/skills/{id}` | | `{id, created_by, name, slug, description, prompt, variables, updated_at}` |
| POST | `/skills` | `{name, prompt, slug?, description?, variables?: [{name, label?, default?}]}` | 201 with the skill; the slug defaults to the name in lower-case ASCII |
| PATCH | `/skills/{id}` | any of the fields | the skill; its creator or an admin only |
| DELETE | `/skills/{id}` | | 204; its creator or an admin only |

`subject_kind` is `ticket`, `report_case` or `account`; `subject_id` is a UUID. A conversation's title is its first question, cut at 80 characters. `attachments` is accepted and not used yet.

The stats cover every UTC day of the range up to today; `date` is `YYYY-MM-DD` and each `days` list has one entry per day, 0 where there was nothing. `/stats/tools` reads `tool_calls`: `failed` counts calls that ended `failed`, `p50_ms` is the median latency, and `recent` is the newest 20 calls with their turn's member. `/stats/guardrails` reads `guardrail` events in `turn_events`, newest 20 in `recent`. `/stats/turns` counts turns by start time; `agent_id` is the turn's `agent_config.id`, and null stands for turns asked without one (the default Console assistant). `attempt_errors` lists every failed attempt of a tool call, the last one included when the call failed.

`agent_config` comes from server with each turn and is stored only in the turn's run state: `{id?, name?, alias?, instructions?, instructions_version?, tools?: string[], limits?: {deadline_s (10 to 300, default 60), max_model_calls (default 40), context_window, tool_timeout_s (default 20), tool_attempts (default 3), max_tokens}}`. Unknown keys are dropped; a value out of range is 400.

The turn view is `{id, conversation_id, member_id, status, text, answer?, blocks, sources, outcome, error_code?, continuable, agent {id, name}, usage {input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd, first_token_ms, provider}, steers: [{steer_id, text}], questions?, last_seq, created_at}`. `questions` is present while the turn is `AWAITING_INPUT`; `last_seq` is the newest event's seq.

Errors are `{code}` with these statuses:

| Status | Code | When |
|---|---|---|
| 400 | `bad_request` | malformed body, filter, `agent_config`, skill id, answers or empty question |
| 400 | `input_rejected` | the question or update is longer than 2000 characters |
| 401 | `unauthorized` | token, member or role missing or wrong |
| 403 | `forbidden` | changing a skill another member created, or reading stats, as a moderator |
| 404 | `not_found` | unknown conversation, turn, tool call, document or skill, or one the member may not see |
| 409 | `turn_in_progress` | the conversation has an unfinished turn (running, paused or waiting for answers) |
| 409 | `turn_state` | the turn is not in a state that takes this action |
| 409 | `conversation_closed` | the conversation is archived or closed |
| 409 | `skill_exists` | another skill has the slug |
| 429 | `rate_limited` | more than 30 questions or updates a minute from the member |
| 503 | `agent_unavailable` | a kill switch is off |
| 500 | `internal` | anything else |

A run's own failures (budget, timeout, model or MCP down) arrive as `turn.finished`, not as HTTP errors.

```bash
curl -X POST http://localhost:3000/conversations/$CONVERSATION/turns \
  -H "Authorization: Bearer $AGENT_SERVICE_TOKEN" \
  -H 'X-Console-Member: 0193a3b0-0000-7000-8000-000000000001' -H 'X-Console-Role: moderator' \
  -H 'Content-Type: application/json' \
  -d '{"text":"Tóm tắt ticket này","agent_config":{"id":"console-agent","name":"Console assistant","alias":"console-agent"}}'
curl -N http://localhost:3000/turns/$TURN/events -H "Authorization: Bearer $AGENT_SERVICE_TOKEN" \
  -H 'X-Console-Member: 0193a3b0-0000-7000-8000-000000000001' -H 'X-Console-Role: moderator'
```

## Database: fresh installation

Authoritative DDL: [`docker/init-db/01-init-schema.sql`](docker/init-db/01-init-schema.sql). Prisma migrations: the baseline `20261111000000_new_database`; `20261117000000_console_member`, which adds `conversations.subject_kind` / `subject_id` (unique per subject when set) and `turns.member_id`; `20261118000000_turn_paused`, which adds `PAUSED` to `turn_status` (alone, because a new enum value cannot be used in the transaction that adds it); `20261118000001_runs`, which adds the run columns on `turns` (`agent_id`, `agent_name`, `cost_usd`, `first_token_ms`, `provider`, `run_started_at`, `deadline_ms`, `event_seq`, `state`), `attempts`, `timing` and `finished_at` on `tool_calls`, and the tables `turn_events`, `documents`, `document_versions` and `skills`; and `20261119000000_tool_stats`, which adds `tool_calls.attempt_errors` and `tool_label` and the time indexes the stats read; and `20261120000000_cache_tokens`, which adds `turns.cache_read_tokens` and `cache_write_tokens`. The baseline plus the migrations give the same schema as the init script.

Tables: `actors` (console members), `conversations`, `turns`, `messages`, `message_blocks`, `tool_calls`, `turn_events`, `documents`, `document_versions`, `skills`, `retrieval`. Documents are deleted with their conversation. Steering messages and answers to questions are `USER` text blocks of their turn, with `steer_id` or `answers` in the payload. There is no compatibility layer for older schemas and no conversion of old data. `retrieval` and `src/retrieval` stay from the shopper agent; no turn uses them.

Prisma maps models and enums; SQL owns partial unique indexes, CHECK constraints, updated-at triggers and the vector, FTS and trigram indexes. Embeddings must be finite, nonzero 1024-dimensional vectors from one embedding space.

The init script runs only on a new PostgreSQL volume. Do not apply it on top of an existing schema, and do not run `prisma migrate deploy` over a schema the init script created unless the migrations are recorded as applied. Provision a separate fresh database rather than deleting volumes to upgrade.

## Components

| Path | Responsibility |
|---|---|
| `src/console` | Service-token guard and the console member |
| `src/agent` | Opening a turn, system prompt, tool tracking, output cap |
| `src/run` | The runner, events, the run bus (Redis or in-process), control, the SSE reader, output tools, citations, compaction, tool retry, turn controls |
| `src/documents`, `src/skills` | Document and skill endpoints |
| `src/conversation` | Conversations by subject, visibility, the conversation view |
| `src/db` | Actor, conversation, turn, event, document and skill persistence; the ordered typed transcript |
| `src/mcp` | The per-turn MCP client to server |
| `src/llm` | The LiteLLM model per run, budget detection and retry, the fetch that reads LiteLLM's headers and waits out rate limits |
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

Compose starts PostgreSQL, Redis and LiteLLM; pass the root `.env` explicitly for interpolation. `AGENT_MODEL_ID` must name a model in `docker/litellm-config.yaml`; locally `console-agent` routes to Gemini Flash Lite. In the cluster, infra's LiteLLM routes `console-agent` to `claude-sonnet-5-5` with a daily budget. `npm run chat` asks as `CLI_MEMBER_ID` through the same turn path, prints the run's events and calls the real model and MCP, which may cost money.

## Configuration

See `.env.example` and `src/config.ts` for every setting.

| Variable | Default | Purpose |
|---|---|---|
| `AGENT_SERVICE_TOKEN` | empty (refuse all) | Token server sends on every request |
| `AGENT_MCP_TOKEN` | empty (no MCP) | Token sent to server's MCP on every turn |
| `MCP_SERVER_URL` | empty (no MCP) | server's `/mcp` endpoint |
| `AGENT_MODEL_ID` | empty | LiteLLM alias, `console-agent` |
| `REDIS_URL` | empty (in-process bus) | Redis for `turn:{id}` and `turn:{id}:control` |
| `AGENT_TURN_DEADLINE_MS` | 60000 | Deadline per run segment when `agent_config.limits.deadline_s` is absent |
| `AGENT_CONTEXT_WINDOW` | 128000 | Context window when `agent_config` gives none |
| `AGENT_TOOL_TIMEOUT_MS` | 20000 | Time limit per tool attempt |
| `AGENT_TOOL_ATTEMPTS` | 3 | Attempts per tool call on a timeout or dropped connection |
| `AGENT_MAX_MODEL_CALLS` | 40 | Model calls per run segment |
| `AGENT_SWEEP_INTERVAL_MS` | 60000 | Stuck-turn sweep period |
| `AGENT_CONVERSATION_WINDOW` | 40 | SDK and restored message ceiling |
| `AGENT_HISTORY_TURNS` | 20 | Maximum prior terminal turns fetched |
| `AGENT_HISTORY_CHARS` | 60000 | Restored history character budget |
| `AGENT_TOOL_OUTPUT_CAP` | 20000 | Tool output kept in context; the rest pages through `read_output` |

Without `MCP_SERVER_URL` or `AGENT_MCP_TOKEN` every turn ends `FAILED` with `agent_unavailable`.

## Verification

```bash
npm run build
npm run typecheck
npm test                        # Offline suites: scripted model, fake MCP on 127.0.0.1, in-memory store and bus
npx prisma validate
npm run test:database           # Skips unless TEST_DATABASE_URL is set
npm run test:redis              # Skips unless REDIS_URL is set
npm run test:live-cache         # Live and billed; skips unless LIVE_LITELLM_URL and LIVE_LITELLM_KEY are set
```

`npm test` covers the guard and error codes over HTTP, the SSE endpoint and the turn controls, shared conversations by subject, the member on turns, and runs with a scripted model: steps, citation numbering, answer validation, documents, tool retry and time limits, `ask_user`, pause and continue, steering while running and while paused, Stop now, End, the budget stop and the other outcomes, compaction, LiteLLM headers, rate-limit waits and `user=`. The stream suite runs the runner and the reader as two replicas on a shared store and bus, with Last-Event-ID, gaps, duplicates and the PostgreSQL fallback. It also covers the MCP headers and read-only filter against an in-process MCP server, LiteLLM's budget error through the OpenAI provider, the deadline and the sweep. `npm run test:redis` runs the two-replica checks on a real Redis with two connections. The database suite needs an already bootstrapped disposable database; it inserts uniquely named fixtures and deletes only those.

## Operational limits

- Stop now, a tool time limit and the deadline cannot stop a server-side MCP call already running.
- Each open event stream holds its own Redis connection.
- A replica that stops mid-run leaves its turns `RUNNING` until the sweep closes them as `agent_stuck`.
- Rate limits and kill-switch overrides are per process.
- A conversation has no turn cap; the prompt carries the last `AGENT_HISTORY_TURNS` turns within `AGENT_HISTORY_CHARS`.
- Persistence errors are not treated as success; a database outage can lose a finished answer, and the sweep then closes the turn.
- PII masking applies to audit logs only. Answers may quote personal data the member is allowed to read through server, which records those reads.
