# ShopNexus Agent

The console agent runtime: a NestJS service that runs one segment of a console turn per request. A segment runs a Strands agent loop on a LiteLLM model, reads data only through server's MCP server, and streams what happened back in the response as NDJSON. The agent has no database and no Redis. server owns conversations, turns, events, tool calls, documents, skills and stats, serves every console endpoint, and stores what the stream carries.

The agent has no tool that changes data; members carry out every action in the console (BR-MOD-03). The service has no public host: server is its only caller, on the internal network.

## Runtime flow

1. `ServiceTokenGuard` compares the bearer token with `AGENT_SERVICE_TOKEN` in constant time. A missing or wrong token gets 401. An empty `AGENT_SERVICE_TOKEN` refuses every request.
2. The kill switches (`FEATURE_ALL_AGENT`, `FEATURE_LLM`) refuse a run with 503, and a malformed body or `agent_config` gets 400. Both happen before the stream starts.
3. The response is `200` with `Content-Type: application/x-ndjson`. Each line is written and flushed as the run goes. If server closes the request, the segment aborts.
4. A new MCP client connects to `MCP_SERVER_URL` for the segment with `Authorization: Bearer AGENT_MCP_TOKEN` and `X-Console-Member`, so server checks the member on every tool call. Only tools the server marks `readOnlyHint` and that `agent_config.tools` allows are given to the agent. Each call has a time limit and is retried on a timeout or a dropped connection.
5. The agent runs on the alias in `agent_config.alias` (else `AGENT_MODEL_ID`) with `user=<member id>` on every LiteLLM call, so LiteLLM applies the member's end-user budget. The system prompt is the built-in prompt (role, subject, the records the conversation mentions, the moderation and support rules), the output-tool rules, `agent_config.instructions` and the skill's prompt when the request names one.
6. The model shapes the run through output tools: `begin_step` / `end_step`, `answer`, `write_document` and `ask_user`. Their arguments are checked by schema; an invalid call goes back to the model as a tool error.
7. Before each model call the runner writes a checkpoint, gives the model any steering messages, and compacts the context when the last call used more than 80 % of the window. It polls server for pause, stop and steering about once a second.
8. The segment ends with an answer (`SUCCEEDED`), a pause (`PAUSED`), questions for the member (`AWAITING_INPUT`) or a failure (`FAILED`, `TIMED_OUT`). The last line is `end`.

## `POST /runs`

`GET /healthz` answers `{ok: true}` without a token, for probes. `POST /runs` is the only other route, and its request and response fields use snake_case names.

### Request

```jsonc
{
  "turn_id": "uuid",
  "conversation_id": "uuid",
  "member": { "id": "uuid", "role": "moderator" },   // or "admin"
  "mode": "new",                                       // or "resume"
  "question": "the turn's question, checked and cleaned by server",
  "subject": { "kind": "ticket", "id": "uuid" },       // optional; ticket, report_case or account
  "mentions": [{ "kind": "order", "id": "uuid" }],     // optional, at most 20; ticket, account, order, listing, report_case or document
  "agent_config": { },                                 // optional, see Configuration
  "skill": { "id": "uuid", "name": "...", "prompt": "..." },   // optional
  "history": [ ],                                      // new: prior terminal turns, oldest first
  "state": { },                                        // resume: the last checkpoint server stored
  "steers": [{ "steer_id": "uuid", "text": "..." }],   // resume: unread steers, oldest first
  "answers": "text",                                   // resume after ask_user: the answers as the model reads them
  "documents": [{ "document_id": "uuid", "latest_version": 2 }],
  "control_after": 123                                 // the input seq this segment reads control after
}
```

`mentions` are the records the members mentioned in the conversation's questions, the current turn's first, by kind and id only. The console's labels for them stay on the server, so the prompt takes no text a member typed.

A history turn is `{status, question, entries, answer}`. `status` is `SUCCEEDED`, `FAILED`, `CANCELLED` or `TIMED_OUT`. `entries` are in the order they happened: `{kind: "input", text}` for a steer or an answers text, and `{kind: "tool", tool_use_id, name, input, status: "success" | "error", content}` for a tool call that ended. The agent turns them into Strands messages: the question and inputs as user text, consecutive tool calls as one assistant message and one user message of results, the answer, and a "[Previous run X: …]" note when the turn did not succeed. It keeps the newest turns whole within `AGENT_CONVERSATION_WINDOW` messages and `AGENT_HISTORY_CHARS` characters. Tool text is cut to 12 000 characters, and a tool use id seen twice in a turn is left out.

In `resume` mode the segment continues from `state`: the Strands messages as they stood, an "interrupted" result for any tool call that has none, and a context-only "continue without repeating" message when the history ends on assistant text. The state keeps the member, subject, mentions, skill and question the turn was asked with. The request's `agent_config` replaces the state's when the request has one. `answers` clears `state.pending_ask` and is added as a user message. Steers from `state.pending_steers` and `steers` are each read once, by `steer_id`.

The JSON body may be up to 16 MB, since a resume request carries the state.

### Lines

Every line is one JSON object with `kind`:

| Kind | Fields | When |
|---|---|---|
| `event` | `type`, `body` | one turn event, see Events; server gives it the next seq |
| `checkpoint` | `state` | before each model call |
| `tool_call` | `id`, `tool_use_id`, `tool`, `label`, `source`, `input`, `status`, `output`, `content`, `output_spilled`, `latency_ms`, `attempts`, `attempt_errors`, `timing`, `finished_at` | a tool call row as it changes: `pending`, `running`, then `success`, `failed` or `cancelled` |
| `document` | `document_id`, `version`, `title`, `sections` | a `write_document` |
| `end` | see below | the last line |

A tool call row's `id` is a UUID the agent makes; events name it as `call_id`, and its first line comes before any event that does. Fields a row does not have yet are `null`. `tool_use_id` is the provider's id, or `tc_<sha256, base64url>` when the id is longer than 64 characters. `input` and `output` are bounded and have secrets redacted. `content` is the bounded result content that history replays. `attempt_errors` lists every failed attempt as `{attempt, error, at}`, the last one included when the call failed.

A new document has `version` 1 and a UUID the agent makes. A new version of a document in `documents` is its `latest_version + 1`; the agent counts its own writes in the segment. A `document_ref` block must name a document and version among those.

### End line

```jsonc
{
  "kind": "end",
  "status": "SUCCEEDED",            // FAILED, TIMED_OUT, PAUSED or AWAITING_INPUT
  "error_code": null,               // the failure code when FAILED or TIMED_OUT
  "answer": "…",                    // the answer's text blocks joined, the failure text, or null
  "blocks": [ ],                    // the answer blocks
  "sources": [ ],                   // the cited sources (all of them when the answer cites none)
  "usage": { "input_tokens": 0, "output_tokens": 0, "cache_read_tokens": 0, "cache_write_tokens": 0,
             "cost_usd": 0, "first_token_ms": null, "provider": null },
  "latency_ms": 0,                  // run time of every segment so far
  "wrote": true,                    // a step, a tool call, text or an answer
  "state": { },                     // the state to resume from
  "event": { "type": "turn.finished", "body": { } }
}
```

`event` is the closing event, and it is not also written as an event line: `turn.finished` after `SUCCEEDED`, `FAILED` or `TIMED_OUT`, `turn.paused` after `PAUSED`, and `clarify` after `AWAITING_INPUT`. `turn.finished.continuable` is worked out as if the turn is the conversation's latest. For a pause or questions, `answer` is null, `blocks` is empty and `sources` lists every source of the run. The failure texts are in `src/run/failure.ts`.

### Control polling

While a segment runs, the agent polls `GET {origin of MCP_SERVER_URL}/agent/turns/{turn_id}/control?after=<seq>` with `Authorization: Bearer <AGENT_MCP_TOKEN>` about every second. The first poll goes out when the segment starts, and the first model call does not wait for it. server answers:

```json
{ "items": [{ "seq": 124, "kind": "steer", "steer_id": "uuid", "text": "…" }], "running": true }
```

`kind` is `pause`, `stop` or `steer`. The cursor starts at `control_after` and moves to the highest seq received. A failed poll is retried on the next tick. `running: false` (the turn was deleted, swept or ended) aborts the segment as Stop now does, and server ignores the lines after it.

- Pause takes effect before the next model call. The call in flight and the tools it asked for finish, so every call keeps its result. A pause that arrives after the model has started its final answer has no call left to stop before, and the turn finishes as usual.
- Stop now aborts the call in flight at once and the segment ends `PAUSED` with reason `stop_now`. A server-side MCP call already running is not stopped.
- A steer is added as a user message ("Update from the member: …") before the next model call, and `steer.read` names it and the open step. A steer received but not yet given to the model stays in the state's `pending_steers`.
- Pause and stop sent before the segment started are at or below `control_after` and are not delivered.

## Run states

A segment ends in one of five statuses. server keeps the turn's status and the transitions between segments.

| Status | When |
|---|---|
| `SUCCEEDED` | the model answered, through `answer` or as free text |
| `PAUSED` | a pause before the next model call, Stop now, `running: false`, or the request closed |
| `AWAITING_INPUT` | the model called `ask_user` |
| `FAILED` | the model or MCP failed, model calls ran out, the context stayed full, or the budget is spent |
| `TIMED_OUT` | the segment's deadline passed |

A `FAILED` or `TIMED_OUT` turn is continuable when it is the conversation's latest turn, it wrote something and its error code is `agent_timeout`, `agent_failed`, `agent_limit`, `agent_context` or `agent_stuck`. A spent budget (`agent_budget`), a guardrail block (`agent_blocked`) and a run that failed before writing anything (`agent_unavailable`) are not. Error codes and outcomes: `agent_timeout`, `agent_limit` and `agent_context` are `out_of_room`; `agent_failed` and `agent_stuck` are `broken`; `agent_unavailable` is `unavailable`; `agent_budget` and `agent_blocked` are `blocked`. `CANCELLED` is `stopped`.

## Answer content

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
- A record seen again keeps its number; a fuller reading of it (more facts, as from a `*_get` tool) replaces its label, meta and facts. Each tool result starts with a header listing its numbers and labels, and `[n]` markers that name no source are dropped from the answer. The end line's `sources` and `turn.finished.sources` are those the answer's text and table cells cite, or all of them when it cites none; the state keeps every number.
- `write_document {title, sections, document_id?}` writes a new document, or a new version of one in the same chat, as a `document` line. Sections are `markdown`, `table` and `chart`.
- `ask_user {questions}` ends the model call; the segment ends `AWAITING_INPUT` and `clarify` carries the questions. server checks the member's answers against `state.pending_ask` and resumes with them as `answers`.

## Context and usage

- After each model call `context.meter` reports the call's input plus output tokens against `agent_config.limits.context_window` (default `AGENT_CONTEXT_WINDOW`). Past 80 % the runner summarises everything before the last assistant message with the same model, replaces it with one user message holding the summary and the member's question, and writes `context.compacting` and `context.compacted`.
- A 429 from LiteLLM that is not a spent budget is waited out at the fetch boundary: the wait comes from `reset_at`, `retry-after-ms` or `retry-after` (60 s when none is given), a `rate.waiting {until}` event is written and the same request goes again. A run waits at most three times and at most 90 s each; Stop now and the deadline end a wait.
- LiteLLM's response headers give each call's cost (`x-litellm-response-cost`), provider (the host of `x-litellm-model-api-base`, else `x-litellm-model-id`) and fallbacks (`x-litellm-attempted-fallbacks`). `model.switched` is written when the provider differs from the previous call's or LiteLLM fell back. The end line's `usage` sums every segment: `input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_write_tokens`, `cost_usd`, `first_token_ms` (the turn's first call) and `provider` (the last).
- `input_tokens` is uncached input: the prompt less cache reads and writes. The cache counts are read off the streamed response's `usage` (`prompt_tokens_details.cached_tokens` and `cache_write_tokens` or `cache_creation_tokens`, or Anthropic's `cache_read_input_tokens` and `cache_creation_input_tokens`), since the OpenAI provider keeps only prompt and completion tokens. `context.meter` counts the whole prompt.
- Prompt caching for the `openai/claude-*` deployments is the upstream's own: it caches the prompt prefix (tools, system prompt, messages) with a breakpoint at the end of each request, so a run's next call and the next turn read what the last call wrote. The agent sends no `cache_control`. `npm run test:live-cache` checks it against a LiteLLM.

## Events

server stores each event as `{seq, type, at, …body}` and serves it to the console. The agent writes every type below except `turn.resumed`, which server writes when it continues a turn, and the `turn.finished` of End. `turn.finished`, `turn.paused` and `clarify` reach server as the end line's `event`.

| Type | Body |
|---|---|
| `turn.started` | `agent {id, name}`, `model` (the alias), `deadline_s`; written by a `new` segment only |
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
| `guardrail` | `rule` (`loop_stopped`), `detail` |
| `turn.finished` | `status` (`SUCCEEDED`, `FAILED`, `CANCELLED`, `TIMED_OUT`, `BUDGET`), `outcome` (null on success, else `stopped`, `out_of_room`, `broken`, `unavailable`, `blocked`), `failure` (the error code), `continuable`, `sources` |

`timing`: `queued` is the time from the model's tool request to the call starting, `server` the call itself, `db` what server reports as `db_ms` in the result (null otherwise), `return` the time from the call's end to the result being recorded.

## Errors

Refusals before the stream starts are `{code}`:

| Status | Code | When |
|---|---|---|
| 400 | `bad_request` | malformed body, `agent_config`, history or resume state, or an empty question |
| 401 | `unauthorized` | the token is missing or wrong, or `AGENT_SERVICE_TOKEN` is empty |
| 503 | `agent_unavailable` | a kill switch is off |
| 500 | `internal` | anything else |

A run's own failures (budget, timeout, model or MCP down) arrive in the end line.

## Configuration

See `.env.example` and `src/config.ts` for every setting.

| Variable | Default | Purpose |
|---|---|---|
| `AGENT_SERVICE_TOKEN` | empty (refuse all) | Token server sends on `POST /runs` |
| `AGENT_MCP_TOKEN` | empty (no MCP) | Token sent to server's MCP and control endpoint |
| `MCP_SERVER_URL` | empty (no MCP) | server's `/mcp` endpoint; its origin serves the control endpoint |
| `AGENT_MODEL_ID` | empty | LiteLLM alias when `agent_config.alias` is absent, `console-agent` |
| `LITELLM_BASE_URL`, `LITELLM_API_KEY` | empty | LiteLLM's OpenAI-compatible endpoint and key |
| `AGENT_TURN_DEADLINE_MS` | 60000 | Deadline per segment when `agent_config.limits.deadline_s` is absent |
| `AGENT_CONTEXT_WINDOW` | 128000 | Context window when `agent_config` gives none |
| `AGENT_TOOL_TIMEOUT_MS` | 20000 | Time limit per tool attempt |
| `AGENT_TOOL_ATTEMPTS` | 3 | Attempts per tool call on a timeout or dropped connection |
| `AGENT_MAX_MODEL_CALLS` | 40 | Model calls per segment |
| `AGENT_MAX_TOKENS` | 4096 | Output tokens per model call when `agent_config` gives none |
| `AGENT_THINKING_BUDGET` | 0 | Extended thinking budget; 0 is off |
| `AGENT_CONVERSATION_WINDOW` | 40 | Messages of prior turns replayed |
| `AGENT_HISTORY_CHARS` | 60000 | Characters of prior turns replayed |
| `AGENT_TOOL_OUTPUT_CAP` | 20000 | Tool output kept in context; the rest pages through `read_output` |
| `FEATURE_ALL_AGENT`, `FEATURE_LLM` | on | `false` refuses every run with 503 |
| `CLI_MEMBER_ID`, `CLI_MEMBER_ROLE` | empty, `moderator` | The member `npm run chat` asks as |

`agent_config` is `{id?, name?, alias?, instructions?, instructions_version?, tools?: string[], limits?: {deadline_s (10 to 300), max_model_calls, context_window, tool_timeout_s, tool_attempts, max_tokens}}`. Unknown keys are dropped; a value out of range is 400. Without `MCP_SERVER_URL` or `AGENT_MCP_TOKEN` every run ends `FAILED` with `agent_unavailable`.

## Local setup

The agent has no compose file of its own. It runs on the stack's LiteLLM and server's MCP, from the umbrella's `docker-compose.yml` or the cluster.

```bash
npm install
cp .env.example .env
# Set AGENT_SERVICE_TOKEN, AGENT_MCP_TOKEN, MCP_SERVER_URL and the LiteLLM settings to the stack's.
npm run start:dev
npm run chat -- "Có bao nhiêu ticket đang mở?"
```

`AGENT_MODEL_ID` must name a model in the stack's LiteLLM; in the cluster `console-agent` routes to `claude-sonnet-5-5` with a daily budget. `npm run chat` posts one `new` run to the agent on `PORT` as `CLI_MEMBER_ID` and prints its events and end line. It calls the real model and MCP, which may cost money. Without server's control endpoint the polls fail and the run goes on without pause, stop or steering.

```bash
curl -N -X POST http://localhost:3000/runs \
  -H "Authorization: Bearer $AGENT_SERVICE_TOKEN" -H 'Content-Type: application/json' \
  -d '{"turn_id":"0193a3b0-0000-7000-8000-0000000000a1","conversation_id":"0193a3b0-0000-7000-8000-0000000000b1",
       "member":{"id":"0193a3b0-0000-7000-8000-000000000001","role":"moderator"},"mode":"new",
       "question":"Tóm tắt ticket này","agent_config":{"alias":"console-agent"}}'
```

## Components

| Path | Responsibility |
|---|---|
| `src/console` | The service-token guard |
| `src/run` | `POST /runs`, the request contract, the runner, the stream writer, control polling, output tools, citations, compaction, tool retry, run state |
| `src/agent` | System prompt, tool call rows, output cap, the invoke time limit |
| `src/memory` | History from the request's prior turns |
| `src/mcp` | The per-segment MCP client to server |
| `src/llm` | The LiteLLM model per run, budget detection and retry, the fetch that reads LiteLLM's headers and waits out rate limits |
| `src/guardrails` | Kill switches, loop detector, audit log, PII masking |
| `src/http` | `{code}` errors |

## Verification

```bash
npm run build
npm run typecheck
npm test                        # offline suites
npm run test:live-cache         # live and billed; skips unless LIVE_LITELLM_URL and LIVE_LITELLM_KEY are set
```

`npm test` runs offline with a scripted model, a fake server on 127.0.0.1 (an MCP server with read-only and write tools, and the control endpoint) and an in-memory line collector. It covers the service token, `/healthz`, the 400 and 503 refusals, the NDJSON framing and the end line, a closed request aborting the segment and the body limit. Runs cover steps, citation numbering, tool call rows, answer validation, documents and versions, tool retry and time limits, `ask_user` and resume with answers, pause and resume, steering while running and through resume with steer ids read once, control polling from `control_after`, Stop now, `running: false`, the budget stop and the other outcomes, the deadline, compaction, LiteLLM headers and usage totals, `text.delta` merging and history conversion. Other suites cover rate-limit waits and `user=` at the LiteLLM boundary, LiteLLM's budget error through the OpenAI provider, the MCP headers and read-only filter, and the system prompt.

## Operational limits

- Stop now, a tool time limit and the deadline cannot stop a server-side MCP call already running.
- Kill-switch overrides are per process.
- Steering, pause and stop reach a segment within about a second, the poll interval.
- PII masking applies to audit logs only. Answers may quote personal data the member is allowed to read through server, which records those reads.
