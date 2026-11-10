# New Database Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Replace the old session/memory runtime with the new conversation/block/retrieval database.
**Architecture:** SQL bootstrap is authoritative. Prisma maps it; repositories isolate lifecycle, typed transcript and actor retrieval. Fresh agents replay verified prior blocks and write completed tool events incrementally.
**Tech Stack:** NestJS, TypeScript, Prisma, PostgreSQL/pgvector, Strands, LiteLLM.
**Spec:** docs/superpowers/specs/2026-11-11-new-database-refactor-design.md

## Execution status (2026-11-11)

- Schema/runtime/retrieval/API/docs implemented; `npm test`, build and Prisma validation pass.
- Schema source-text test replaced by Prisma validation/generation and opt-in SQL integration (see ledger).
- Real PostgreSQL test is **SKIPPED**, awaiting an explicit disposable `TEST_DATABASE_URL`; no database operation or live model call performed.
- Physical deletion of retired helper/registry/migration denied by tool permissions; production imports/providers removed, legacy migration is a no-op. These cleanup items remain pending permission.
- Independent review complete: both Important findings fixed with RED→GREEN regressions; full offline suite/build/Prisma validation pass after fixes. Retrieval index tuning deferred pending database measurements. No commit/push.

## Global Constraints
- Fresh database only; no compatibility APIs or data migration.
- Preserve guardrails and trusted gateway actor identity.
- No raw chain-of-thought, no unverified draft rendering.
- No database reset, volume deletion, live model calls, commit or push.
- SQL owns specialized constraints/indexes. Embeddings use 1024 dimensions and reject zero/nonfinite vectors.

## Review Focus
- Concurrent requests: one unfinished turn, conflict rather than parallel execution (task 2).
- Late tool callbacks: update audit but never reopen completed turn (task 3).
- Replayed incomplete history: no orphan tool result or false completed action (task 2).
- Foreign/superseded/expired retrieval: filtered before candidate selection (task 4).
- Current input and terminal answer: no duplicate input or rejected draft (task 3).

### Task 1: Authoritative schema
**Files:** prisma/schema.prisma, prisma/migrations/*, test/schema-contract-test.ts.
**Interfaces:** Prisma Actor, Conversation, Turn, Message, MessageBlock, ToolCall, Retrieval; enums match bootstrap exactly.
- [ ] Add schema contract test: no sessions/user_memories; all seven tables and enum labels are mapped.
- [ ] Run `npx ts-node test/schema-contract-test.ts`; expect failure on old schema.
- [ ] Map SQL models, composite relations, BIGINT and enum names. Replace obsolete fresh-database migration with SQL baseline.
- [ ] Run schema test, `npx prisma validate`, `npx prisma generate`; expect success.

### Task 2: Conversation lifecycle and history
**Files:** src/conversation/conversation.service.ts, src/db/conversation.repository.ts, src/db/turn.repository.ts, src/memory/conversation-context.service.ts, test/conversation-test.ts.
**Interfaces:** ConversationService.newConversation(actorId, context), assertOwnedConversation(actorId,id), listConversations(actorId); TurnRepository.startTurn({conversationId,userText,modelId}), finishTurn({turnId,status,answer,latencyMs,errorCode?}), getRecentMessages(conversationId,actorId,limit,beforeOrdinal?).
- [ ] Add tests for ownership, unavailable conversation, ordered terminal replay, incomplete pairs, failed-turn marker, ordinal and conflict propagation.
- [ ] Run new test and establish red result.
- [ ] Implement authorized conversation CRUD; start under conversation row lock, allocate MAX ordinal+1, persist USER block; finish with final verified block and lifecycle metadata. Use message_blocks as replay source, not tool_calls.
- [ ] Run tests; expect pass. Remove old SessionService/Repository once consumers are migrated.

### Task 3: Incremental guarded execution
**Files:** src/agent/agent.service.ts, src/agent/tool-call-tracker.ts, src/agent/agent.controller.ts, src/agent/system-prompt.ts, src/cli.ts, src/demo.ts, src/app.module.ts, src/guardrails/*, test/helpers/agent-scope-harness.ts, test/*scope*, test/tool-call-tracker-test.ts.
**Interfaces:** chat(actorId,conversationId,userText,ctx) returns {actorId,conversationId,answer}; tracker writes logical tool event by (turnId,toolUseId), bound to existing turn before invoke.
- [ ] Adapt tests to running-turn lifecycle; assert one current input, guarded final only, late event audit without second terminal response.
- [ ] Run focused tests; establish failures.
- [ ] Integrate lifecycle before model, incremental tool blocks plus audit transaction, stable event IDs, cancellation/timeout finalization and usage. Replace session API/metadata with conversation everywhere. Remove obsolete verified-transcript helper and dynamic-tool registry if unused.
- [ ] Run timeout, ownership, scope, tool tracker and CLI test commands; expect pass.

### Task 4: Actor retrieval
**Files:** src/retrieval/*, src/memory/memory-client.ts, src/llm/embedding.service.ts, test/retrieval-test.ts, test/memory-*-test.ts.
**Interfaces:** RetrievalService.saveMemory({actorId,kind,content,...}), supersedeMemory({actorId,previousMemoryId,content,...}), searchMemory(actorId,query,limit?,origin?), ingestDocument({actorId,documentId,text,...}). Existing memory tool names remain, payload uses kind/content not factKey/category.
- [ ] Add tests for vector validation, actor/active SQL filters, exact current correction, origin/kind metadata, citation-preserving chunk ingestion and invalid input.
- [ ] Run tests and establish red result.
- [ ] Implement repository hybrid semantic/FTS/trigram reciprocal rank search and versioned correction; service validation/chunking; update tool schemas and prompts. Remove old memory types/repository/service.
- [ ] Run retrieval and memory tool tests; expect pass.

### Task 5: Cleanup and verification
**Files:** package.json, README.md, docs/memory.md, docs/manual-memory-test-scenarios.md, docs/agent-harness-overview.md, mock-mcp/server.js, mock-mcp/webview.html, test/database-integration-test.ts.
- [ ] Add opt-in integration test using explicit TEST_DATABASE_URL to assert new schema, lifecycle constraints, atomic tool persistence and actor-filtered hybrid retrieval; no automatic destructive bootstrap.
- [ ] Update API and SQL examples, fresh-schema setup, crash recovery caveat and test scripts. Retain historical design docs only as history.
- [ ] Search source, tests and active docs for old sessionId/sessions/user_memories/factKey/category contracts and remove obsolete usage.
- [ ] Run `npm run build`, all offline test scripts and integration script in skip mode. Record exact failures or skipped external verification.
- [ ] Independent read-only review of changed runtime; fix confirmed findings and rerun affected tests.
