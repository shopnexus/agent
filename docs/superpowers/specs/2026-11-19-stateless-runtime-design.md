# Stateless agent runtime

Date: 2026-11-19. Status: approved by the user ("ok làm theo thiết kế này, bỏ redis luôn").

## Goal

The agent becomes a runtime only. It has no database, no Prisma, no Redis, no
sweeper and no LiteLLM or Postgres compose of its own. The server owns every
piece of state (conversations, turns, events, tool calls, documents, skills,
stats) in its own database, through a server migration, and serves every
console endpoint itself. The agent is called once per run segment, runs the
Strands loop against LiteLLM and the server's MCP, and streams what happened
back in the response. Whatever it needs from the backend during a run it asks
the server for directly.

Old data in the agent's database is dropped; nothing is converted.

The console's API (`/v1/console/agent/...` on the server, `api/openapi.yaml`)
does not change shape. The event types and bodies the console reads do not
change (see the agent README's Events table), except that the server now
writes them.

## Who does what

| Concern | Before (agent) | After |
|---|---|---|
| conversations, visibility, rename, delete | agent DB | server |
| opening a turn (lock, one unfinished turn, ordinal, title) | agent | server |
| rate limit 30/min/member, input guard (empty, > 2000 chars, sanitising) | agent | server |
| history replay selection (last 20 terminal turns) | agent | server picks the turns, agent turns them into Strands messages within its window and char budget |
| run loop, prompts, output tools, citations, compaction, tool retry, LiteLLM headers, loop detector | agent | agent (unchanged) |
| events: seq, storage, SSE to the console | agent + Redis | server (`agent_turn_events` + `pg_notify`) |
| pause / stop / steer delivery to a running segment | Redis control stream | server table, the agent polls the server |
| checkpoints, suspend, finish | agent DB | agent sends them in the stream, server stores |
| tool call rows | agent DB | agent sends them in the stream, server stores |
| documents | agent DB | agent sends them in the stream, server stores |
| skills CRUD | agent | server |
| stats (tools, guardrails, turns) | agent | server |
| stuck-turn sweep | agent | server |
| kill switches FEATURE_ALL_AGENT / FEATURE_LLM | agent | agent (refuses `/runs` with 503) |

## Server: tables (one new migration, `server/migrations/0061_agent_runs.sql`)

Server style: `text` + `CHECK` instead of enums, `uuid` ids, `timestamptz`,
member ids are `uuid REFERENCES console_members (id)`. All names start with
`agent_` (the server already has `conversations` and `messages`).

- `agent_conversations`: `id`, `member_id` (who opened it), `subject_kind`
  (`ticket`, `report_case`, `account`) and `subject_id` (both or neither),
  `title`, `status` (`active`, `archived`, `closed`), `created_at`,
  `updated_at`, `last_activity_at`. Unique `(subject_kind, subject_id)` where
  `subject_kind IS NOT NULL`; index `(member_id, last_activity_at DESC)` where
  `subject_kind IS NULL`.
- `agent_turns`: `id`, `conversation_id` (cascade), `member_id`, `ordinal`
  (unique per conversation), `status` (`running`, `paused`, `awaiting_input`,
  `succeeded`, `failed`, `cancelled`, `timed_out`), `question`, `answer`,
  `blocks jsonb`, `sources jsonb`, `agent_id`, `agent_name`, `model_alias`,
  `error_code`, `input_tokens`, `output_tokens`, `cache_read_tokens`,
  `cache_write_tokens` (bigint), `cost_usd numeric(12,6)`, `first_token_ms`,
  `provider`, `started_at`, `run_started_at`, `deadline_ms`, `finished_at`,
  `latency_ms`, `event_seq bigint`, `wrote boolean`, `state jsonb` (the
  agent's checkpoint, opaque to the server except `pending_ask`).
  At most one unfinished turn per conversation: unique `(conversation_id)`
  where `status IN ('running','paused','awaiting_input')`. Index on
  `started_at`; partial index on `run_started_at` where `status = 'running'`.
- `agent_turn_inputs`: `seq bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY`,
  `id uuid UNIQUE` (the steer_id for steers), `turn_id` (cascade), `kind`
  (`pause`, `stop`, `steer`, `answers`), `text`, `answers jsonb`, `read_at`,
  `created_at`. Pause, stop and running-turn steers are the control queue the
  agent polls; steers and answers are also what the turn view and the history
  show.
- `agent_tool_calls`: `id uuid` (chosen by the agent), `turn_id` (cascade),
  `tool_use_id`, unique `(turn_id, tool_use_id)`, `tool_name`, `tool_label`,
  `tool_source`, `input jsonb`, `output text`, `content jsonb` (bounded result
  content, for history replay), `output_spilled`, `status` (`pending`,
  `running`, `success`, `failed`, `cancelled`), `latency_ms`, `attempts`,
  `attempt_errors jsonb`, `timing jsonb`, `created_at`, `finished_at`.
  Indexes `(created_at)` and `(tool_name, created_at DESC)`.
- `agent_turn_events`: `turn_id` (cascade), `seq`, `type`, `body jsonb`, `at`;
  primary key `(turn_id, seq)`; index `(type, at)`.
- `agent_documents` (`id` chosen by the agent, `conversation_id` cascade,
  `turn_id` set null, `title`, `latest_version`, `created_by`, `created_at`,
  `updated_at`) and `agent_document_versions` (`document_id` cascade,
  `version`, `title`, `sections jsonb`, `turn_id`, `created_by`, `created_at`;
  primary key `(document_id, version)`).
- `agent_skills`: `id`, `created_by`, `name`, `slug` unique, `description`,
  `prompt`, `variables jsonb`, `created_at`, `updated_at`.

No `actors` table (console members are `console_members`), no `retrieval`,
no pgvector.

## Agent HTTP API: `POST /runs`

The only route besides a `GET /healthz` (no auth, for probes). Auth:
`Authorization: Bearer <AGENT_SERVICE_TOKEN>` in constant time; empty token
refuses everything (401 `{code:"unauthorized"}`).

Request body (snake_case):

```jsonc
{
  "turn_id": "uuid",
  "conversation_id": "uuid",
  "member": { "id": "uuid", "role": "moderator" | "admin" },
  "mode": "new" | "resume",
  "question": "the turn's question, already checked and cleaned by the server",
  "subject": { "kind": "ticket" | "report_case" | "account", "id": "uuid" },   // optional
  "agent_config": { ... },          // as today; the agent validates it (400 bad_request)
  "skill": { "id": "uuid", "name": "...", "prompt": "..." },                    // optional
  "history": [HistoryTurn],         // mode new: prior terminal turns, oldest first (server sends at most 20)
  "state": { ... },                 // mode resume: the last checkpoint the server stored, as the agent wrote it
  "steers": [{ "steer_id": "uuid", "text": "..." }],  // resume: every steer of the turn not yet read, oldest first
  "answers": "text",                // resume after ask_user: the member's answers as the model reads them
  "documents": [{ "document_id": "uuid", "latest_version": 2 }],  // the conversation's documents
  "control_after": 123              // the input seq the segment reads pause/stop/steer after
}
```

`HistoryTurn`:

```jsonc
{
  "status": "SUCCEEDED" | "FAILED" | "CANCELLED" | "TIMED_OUT",
  "question": "...",
  "entries": [                       // in the order they happened
    { "kind": "input", "text": "..." },   // a read steer or the answers text
    { "kind": "tool", "tool_use_id": "...", "name": "...", "input": {}, "status": "success" | "error", "content": [ ... ] }
  ],
  "answer": "the terminal answer text, if any"
}
```

The agent builds Strands messages from it as `ConversationContextService` does
today (user texts, complete tool pairs, terminal answer, the "[Previous run
X: …]" note when not SUCCEEDED, the window and char budget, bounded tool
text). Only tool calls that ended `success` or `failed` are sent.

Refusals before the stream starts: 401 `unauthorized`, 400 `bad_request`
(malformed body or `agent_config`), 503 `agent_unavailable` (a kill switch is
off). Otherwise `200` with `Content-Type: application/x-ndjson`: one JSON
object per line, written as the run goes, flushed per line.

### Stream lines

Every line has `kind`.

- `{"kind":"event","type":"<event type>","body":{...}}`: one turn event,
  exactly the types and bodies of today. The server gives it the next seq.
  `text.delta` is still merged by the agent (about 120 ms or 400 characters).
- `{"kind":"checkpoint","state":{...}}`: before each model call. The server
  stores it on the turn while the turn is running.
- `{"kind":"tool_call", "id", "tool_use_id", "tool", "label", "source",
  "input", "status", "output", "content", "output_spilled", "latency_ms",
  "attempts", "attempt_errors", "timing", "finished_at"}`: a tool call row as
  it changes (pending, running, then its end). The server upserts by
  `(turn_id, tool_use_id)` and never moves a finished row back to pending or
  running. Tool use ids longer than 64 characters are hashed by the agent as
  today. Lines with a `call_id` in an event come after the row's first line.
- `{"kind":"document","document_id","version","title","sections"}`: a
  `write_document`. A new document has `version` 1 and an id the agent made;
  a new version of an existing one is `latest_version + 1` (the agent counts
  its own writes in the segment). The server inserts it; there is only one
  running turn per conversation, so no race.
- `{"kind":"end", "status", "error_code", "answer", "blocks", "sources",
  "usage", "latency_ms", "wrote", "state", "event"}`: the last line.
  `status` is `SUCCEEDED`, `FAILED`, `TIMED_OUT`, `PAUSED` or
  `AWAITING_INPUT`. `usage` is the run totals `{input_tokens, output_tokens,
  cache_read_tokens, cache_write_tokens, cost_usd, first_token_ms, provider}`.
  `answer` is the terminal text (the answer's text blocks joined, or the
  failure text of `FAILURE_ANSWERS`), `sources` the cited ones (as today),
  `latency_ms` the run time of all segments so far. `event` is the closing
  event `{type, body}`: `turn.finished` (body as today, `continuable` worked
  out as if the turn is the latest), `turn.paused` or `clarify`. The server
  updates the turn and appends the event in one transaction, only while the
  turn is still `running`.

The agent writes `step.*`, `tool.*`, `usage`, `turn.started` and the rest as
events exactly as today. It no longer writes `turn.resumed` (the server
does, see below).

### Control polling

The agent polls `GET {origin of MCP_SERVER_URL}/agent/turns/{turn_id}/control?after=<seq>`
with `Authorization: Bearer <AGENT_MCP_TOKEN>` about every second while a
segment runs (and does not wait for it before the first model call). It
answers `{"items":[{"seq":124,"kind":"pause"|"stop"|"steer","steer_id":"…","text":"…"}],"running":true}`.
The agent starts at `control_after`, moves its cursor to the last seq it got,
and treats pause, stop and steer as the Redis watch did. `running:false`
(the turn was deleted, swept or ended) aborts the segment as a stop would; the
server then ignores what follows. A failed poll is retried on the next tick.
Steers are deduplicated by `steer_id` against `state.pending_steers` and the
request's `steers`.

The run state's `control_cursor` is gone; pause and stop sent before the
segment started are not delivered because the server sets `control_after` to
the newest input seq when it starts the segment.

## Server: flows

- **Ask** (`POST .../conversations/{id}/turns`): checks the agent, budget,
  rate limit and input as today (the rate limit and input guard move here:
  30 a minute per member across questions and steers; empty is
  `bad_request`, over 2000 characters `input_rejected`; zero-width and
  control characters and HTML tags are removed). In one transaction it locks
  the conversation, refuses a closed one or one with an unfinished turn, and
  inserts the `running` turn (ordinal, question, agent, model alias,
  deadline, title of the conversation if it has none, `last_activity_at`).
  Then it starts the run (POST /runs) and waits for the response status (10 s
  at most). A refusal or no answer deletes the new turn and returns the
  error (503 `agent_unavailable` and so on); 200 returns 202
  `{conversation_id, turn_id}` and the stream is read in the background, on
  this replica, with a context not bound to the request (deadline + 60 s).
- **Reading a run's stream**: each line is applied in order, in a short
  transaction each; each event takes `event_seq + 1`, and the transaction
  `pg_notify('agent_turn', '<turn_id>')`. A `steer.read` event marks that
  steer's input `read_at`. If the stream ends without an `end` line, or the
  read fails, and the turn is still `running`: it is closed `failed` with
  `agent_stuck`, `wrote` from the turn (true if the agent sent any
  checkpoint with `wrote`, any tool call or any step event), the
  `agent_stuck` failure text as answer, and a `turn.finished` event.
- **Pause / stop**: the turn must be `running`; insert an input row.
- **Steer**: rate limit and input guard; `running` inserts a `steer` input
  row (`resumed:false`); `paused` inserts the row and continues the turn
  (`resumed:true`).
- **Continue / input / steer on paused**: lock the turn; check the status
  (and for `failed`/`timed_out` that it is continuable: the latest turn,
  `wrote`, error code continuable); set `running`, `run_started_at`, the
  deadline, clear `finished_at` and `error_code`, clear `answer`, `blocks`
  for a failed one; for input store the answers row (`read_at` now) and
  clear `state.pending_ask`. Then start the run in mode `resume` with the
  state, unread steers, answers text, documents and `control_after`. A
  refusal puts the turn back as it was. On success append `turn.resumed
  {by}` and return.
- **End**: `paused` or `awaiting_input` → `cancelled` with `turn.finished
  {status:"CANCELLED", outcome:"stopped", continuable:false, sources}`.
- **Events SSE** (`GET .../turns/{id}/events`): replays `agent_turn_events`
  after `Last-Event-ID` / `?after=`, then follows: one `LISTEN agent_turn`
  per replica fans rings out to the open streams of that turn, which read
  the rows after their last seq. Every 15 s without events: a `: keep-alive`
  comment and a read of the table. The stream ends after `turn.finished`,
  `turn.paused` or `clarify`, or 10 s after the turn stopped running with
  nothing new. Same wire format as today (`id: <seq>`, `event: <type>`,
  `data: {seq,type,at,...body}`).
- **Sweep**: at start and every minute, turns `running` past
  `run_started_at + deadline_ms + 30 s` close as `failed` `agent_stuck`
  with `turn.finished` (continuable when `wrote`).
- **Turn view, conversation view, tool call, document, skills, stats**: the
  shapes in the agent README's HTTP API section, built from the tables
  (`outcomeOf`, `isContinuable`, `eventStatus` and the failure texts ported
  to Go).

## Agent: what goes

`prisma/`, `docker/` (its compose, `litellm-config.yaml`, `init-db`),
`src/db`, `src/retrieval`, `src/llm/embedding.service.ts`, `src/stats`,
`src/sweep`, `src/conversation`, `src/documents`, `src/skills`,
`turn-actions`, `turn-stream`, `run-bus`, `redis-run-bus`, the Redis control
service, the console member headers, the input guard and the rate limiter,
`ioredis`, `@prisma/client`, `prisma`, `pg`. Config loses `POSTGRES_*`,
`DATABASE_URL`, `REDIS_URL`, `EMBEDDING_MODEL_ID`, `RETRIEVAL_CONTEXT_CHARS`,
`DOCUMENT_CHUNK_CHARS`, `AGENT_MEMORY_*`, `AGENT_SWEEP_INTERVAL_MS`,
`AGENT_HISTORY_TURNS`. The Dockerfile drops Prisma. `npm run chat` posts one
`/runs` request and prints the lines.

## Infra

Compose and the chart drop the agent's database (CNPG role and Database
`agent`, its secret, `agent-db-*`, `agent-migrate-*`, the init container),
Redis (`templates/redis.yaml`, its NetworkPolicy, `redis-dev`/`redis-prod`
and their volumes) and the settings above from `infra/stack/env/agent.env`.
The agent's NetworkPolicy keeps server → agent:3000 and agent →
server-mcp:9090 (the control endpoint is on that listener).
