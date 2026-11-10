# Ecommerce Support Scope and Guardrails Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enforce ShopNexus ecommerce support scope consistently across HTTP and CLI without blocking legitimate shopping context or exposing unchecked answers.

**Architecture:** Shared bilingual policy drives the system prompt, strictly validated semantic input/output decisions, and deterministic per-turn tool permissions. Existing application authorization and output checks remain authoritative; HTTP and CLI use one buffered, guarded turn pipeline. Semantic checks use the existing LiteLLM model through the installed OpenAI client, not a new provider.

**Tech Stack:** TypeScript, NestJS, Strands SDK, OpenAI client, Zod, Prisma, Node assertions and `ts-node`; no new runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-11-06-ecommerce-support-guardrails-design.md` — selected approach B; detailed design and this plan await user review before implementation.

## Global Constraints

- No `.env` reads or writes; no secret output.
- Do not change Docker/LiteLLM routes, provider model selection, API key names, database schema, or embedding configuration.
- No new runtime dependencies.
- Total model-related request budget: 60,000 ms from scope assessment through final semantic verification; propagate one parent cancellation signal.
- Each semantic classifier call: at most 6,000 ms, no SDK retries, at most 512 output tokens.
- Scope history: at most six recent user/assistant text messages, at most 500 characters each; retain the existing 2,000-character current-input limit.
- Output review: at most 20,000 characters; over-limit answers use the safe fallback, never approve a truncated prefix while displaying an unchecked suffix.
- Keep NestJS memory/gateway/audit logs; add no replacement printer or logger. Disable only draft auto-printing on guarded invocations and buffer CLI answer text.
- Existing rate limits, actor scoping, 1,024-dimension memory validation, and memory eligibility checks remain intact.
- Keep exactly `memory_search`, `memory_save`, and `memory_supersede`. Remove memory list/update/forget/forget-all APIs and unused methods; preserve historical rows/schema. Save creates a new fact; supersede explicitly versions an existing actor-owned current fact.
- Do not commit/push unless the user explicitly asks; preserve all existing dirty changes. No multi-agent implementation is authorized by this design.

## Review Focus

1. A short follow-up after a code question must not inherit permission from an older shopping turn; Task 2 pins context selection and Task 7 tests real semantic cases.
2. A mixed request may contain harmless product terminology around an unrelated coding task; Tasks 3–5 enforce the accepted portion and Task 7 exercises model judgments.
3. A rejected draft can escape through CLI stdout, SDK auto-printing, or saved assistant preambles; Tasks 3 and 6 assert delivery/persistence boundaries.
4. Concurrent users, stale supersede targets or stale `read_output` IDs must not overwrite corrections or gain each other's data; Tasks 4–5 test ownership and locked rechecks.
5. A late classifier result after timeout must not start tools, overwrite the fallback, or poison the next turn; Tasks 2–3 test cancellation and recovery.

## File Structure

Create:
- `src/guardrails/support-policy.ts`: bilingual domain policy, fixed reply copy, Zod decision schemas, pure tool-permission mapping and bounded scope-history selection.
- `src/agent/system-prompt.ts`: extracted `buildSystemPrompt` with explicit ecommerce-only behavior and server-owned scope constraints.
- `src/guardrails/scope.service.ts`: input assessment and final semantic review; no tools, persistence, or reply generation.
- `src/memory/memory-search.ts`, `src/memory/memory-supersede.ts`: actor-bound search and explicit correction tools.
- `test/memory-tools-test.ts`: exact three-tool surface, corrections, removed API routes and ownership checks.
- `src/agent/verified-transcript.ts`: preserve successful tool pairs while removing unapproved assistant text; fixed-response transcript construction.
- `test/support-policy-test.ts`, `test/system-prompt-test.ts`, `test/scope-service-test.ts`, `test/agent-scope-test.ts`, `test/tool-scope-test.ts`, `test/cli-guardrails-test.ts`.
- `test/helpers/agent-scope-harness.ts`: mocked collaborators/agent factory for deterministic pipeline tests.
- `src/cli-renderer.ts`: final verified reply rendering only; no model delta renderer.
- `test/fixtures/support-scope-cases.ts`: typed semantic evaluation cases.
- `test/scope-live-eval.ts`: explicitly opt-in, synthetic model-only semantic evaluation.

Modify:
- `src/llm/llm.service.ts`: bounded plain-JSON classification transport via existing LiteLLM credentials/model.
- `src/agent/agent.service.ts`: shared guards, one cancellation budget, scope-controlled preparation, verified persistence, no raw draft/error delivery.
- `src/agent/output-cap.ts`: optional invocation-owned spill ID set.
- `src/memory/types.ts`, `src/memory/memory-save.ts`, `src/memory/memory.service.ts`, `src/memory/memory.repository.ts`: search metadata, create-only save, explicit atomic supersede, removal of list/update/delete operations and the search-only MemoryManager adapter.
- `src/agent/agent.controller.ts`: remove all four memory CRUD endpoints; retain chat/session endpoints unchanged.
- `test/memory-service-test.ts`, `test/memory-repository-test.ts`: replace obsolete overwrite/update/list/delete assertions with the selected three-operation lifecycle.
- `docs/memory.md`: document only the selected memory operations and versioning semantics.
- `src/guardrails/output-verifier.service.ts`: distinguish professional-advice warnings from actual domain scope enforcement; preserve existing rules.
- `src/app.module.ts`: register `ScopeService`.
- `src/cli.ts`: call `AgentService.chat()` and display the verified reply once.
- `package.json`: focused offline scripts plus opt-in live evaluation script.
- `README.md`, `docs/agent-harness-overview.md`: scope, failure behavior, latency, buffering and validation commands.

No standalone logging file, new database table, or provider configuration file is needed.

## Shared Interfaces

Defined in `support-policy.ts`:

```ts
export type SupportIntent = 'products' | 'orders' | 'policies' | 'platform' | 'personal_context' | 'smalltalk';
export interface ScopeDecision {
  route: 'allow' | 'mixed' | 'clarify' | 'deny';
  intents: SupportIntent[];
  memory: Array<'search' | 'save' | 'supersede'>;
  reason: 'in_scope' | 'mixed_request' | 'out_of_scope' | 'ambiguous' | 'unsafe' | 'unavailable';
}
export interface OutputDecision {
  allowed: boolean;
  reason: 'in_scope' | 'out_of_scope' | 'unsafe' | 'unsupported_action' | 'unavailable';
}
export type SupportLocale = 'vi' | 'en';
export interface ScopeRequest {
  message: string;
  history: import('@strands-agents/sdk').MessageData[];
  locale: SupportLocale;
}
export interface ScopeReviewRequest extends ScopeRequest {
  decision: ScopeDecision;
  answer: string;
}
```

Other signatures are pinned in each owning task. Do not change existing HTTP `ChatReply` or request DTOs.

---

### Task 1: Shared domain policy and explicit system prompt

**Files:** Create `src/guardrails/support-policy.ts`, `src/agent/system-prompt.ts`, `test/support-policy-test.ts`, `test/system-prompt-test.ts`; modify `src/agent/agent.service.ts`, `package.json`.

**Interfaces:**
- Consumes: existing `AgentContext` (import type only), SDK `MessageData` and Zod.
- Produces: shared interfaces above; `scopeDecisionSchema`, `outputDecisionSchema`; `allowedToolNames(decision: ScopeDecision, hasActor: boolean): ReadonlySet<string>`; `scopeHistory(messages: MessageData[]): Array<{ role: 'user' | 'assistant'; content: string }>`; `fixedSupportReply(kind: 'refusal' | 'clarification' | 'unavailable' | 'greeting', locale: SupportLocale): string`; `greetingReply(message: string, locale: SupportLocale): string | undefined`; `buildSystemPrompt(ctx: AgentContext, scope?: ScopeDecision): string`.

- [ ] **Step 1: Write policy and prompt failing tests.** Use `node:assert/strict` with these assertions, plus route/reason consistency for all enum combinations:

```ts
assert.equal(scopeDecisionSchema.safeParse({ route: 'allow', intents: [], memory: [], reason: 'in_scope' }).success, false);
assert.equal(scopeDecisionSchema.safeParse({ route: 'deny', intents: [], memory: ['save'], reason: 'out_of_scope' }).success, false);
assert.equal(outputDecisionSchema.safeParse({ allowed: true, reason: 'unsafe' }).success, false);
assert.equal(greetingReply('xin chào, viết Go Hello World', 'vi'), undefined);
assert.equal(greetingReply('Hello, write Go code', 'en'), undefined);
assert.ok(greetingReply('  Xin chào!  ', 'vi'));
assert.ok(!allowedToolNames({ route: 'allow', intents: ['products'], memory: [], reason: 'in_scope' }, true).has('memory_search'));
```

  Also pin: Vietnamese/English refusal copy; no memory operation without actor; reject duplicate or unknown memory operations; allow `['search', 'supersede']` for corrections but never any forget/list/update operation; orders never imply products; deny/clarify yield zero tools; six chronological history messages at 500 chars each, no tool payloads/reasoning; product-oriented programming advice allowed in prompt, unrelated code generation rejected, mixed requests handled partially, professional advice not legitimized by disclaimers, memory/tool data explicitly untrusted. Preserve date, locale and page context behavior from the current prompt.

- [ ] **Step 2: Run `npx ts-node test/support-policy-test.ts` and `npx ts-node test/system-prompt-test.ts`.** Expected: nonzero exit due to missing policy/prompt modules.
- [ ] **Step 3: Implement the pure interfaces and extract the current system prompt.** Use the spec's exact enums and Vietnamese fixed copy; add corresponding English copy. Normalize greetings with NFC, trim, lowercase and terminal punctuation removal; exact matches only (`xin chào`, `chào`, `chào bạn`, `hello`, `hi`, `cảm ơn`, `thanks`, `thank you`), not broad prefix detection. `read_output` is only a candidate permission for decisions with commerce or memory access; actual ownership is Task 5. Serialize only validated enums into trusted prompt constraints, never arbitrary classifier prose.
- [ ] **Step 4: Add `test:support-policy` and `test:system-prompt` scripts.** Run both scripts and `npm run build`; expected: all assertions pass and TypeScript compiles.
- [ ] **Step 5: Checkpoint the diff.** Run `git diff --check`. Do not commit without a new explicit user request; review only this task's hunks and retain pre-existing edits.

### Task 2: Contextual semantic scope service with bounded transport

**Files:** Create `src/guardrails/scope.service.ts`, `test/scope-service-test.ts`; modify `src/llm/llm.service.ts`, `src/app.module.ts`, `package.json`.

**Interfaces:**
- Consumes: Task 1 interfaces, policy and schemas; current `config.model.id` and `config.litellm`.
- Produces: `LlmService.classifyJson(messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>, signal: AbortSignal): Promise<string>`; `ScopeService.assess(request: ScopeRequest, signal: AbortSignal): Promise<ScopeDecision>`; `ScopeService.review(request: ScopeReviewRequest, signal: AbortSignal): Promise<OutputDecision>`.

- [ ] **Step 1: Write failing tests with mocked transport.** Pin valid input/output parsing; unknown field and malformed JSON rejection; prose/code-fenced output rejection; incompatible route/reason combinations; zero tools in classifier requests; the configured existing model/base URL; 512 max tokens, `maxRetries: 0`, 6,000-ms timeout, parent abort propagation. A genuine explicit out-of-scope decision stays `out_of_scope`; transport/schema failures return `unavailable`, never masquerading as a policy violation.

```ts
assert.deepEqual(await scope.assess(request, signal), { route: 'deny', intents: [], memory: [], reason: 'unavailable' }); // malformed mocked JSON
assert.deepEqual(await scope.review({ ...request, decision, answer: 'x'.repeat(20001) }, signal), { allowed: false, reason: 'unavailable' });
assert.equal(transportCalls, 0); // isolated over-limit output test
```

  Test a late resolution after abort, six-message history limits, omission of tool data, current-message separation, and that an earlier shopping turn does not mechanically whitelist a later coding request. These are prompt/transport assertions; do not claim mocks prove semantic comprehension.
- [ ] **Step 2: Run `npx ts-node test/scope-service-test.ts`.** Expected: fails because the new transport/service does not exist.
- [ ] **Step 3: Implement bounded transport and the service.** Reuse the installed OpenAI client, never provider keys directly. Add no provider-specific JSON-schema mode requirement. Send the policy as system content and JSON-serialized untrusted request/history/answer as user data. Combine the parent signal with a 6-second deadline; do not return a successful decision after cancellation. Catch transport/parse/schema errors into unavailable decisions without logging payloads. Register `ScopeService` in `AppModule`.
- [ ] **Step 4: Add `test:scope-service`; run it and `npm run build`.** Expected: all transport/parsing/cancellation assertions pass without live requests.
- [ ] **Step 5: Checkpoint via `git diff --check`; no commit unless explicitly authorized.**

### Task 3: One guarded HTTP turn and safe replay persistence

**Files:** Create `src/agent/verified-transcript.ts`, `test/helpers/agent-scope-harness.ts`, `test/agent-scope-test.ts`; modify `src/agent/agent.service.ts`, `src/guardrails/output-verifier.service.ts`, `package.json`.

**Interfaces:**
- Consumes: Tasks 1–2; existing input guard, rate limiter, repositories, verifier, `invokeWithTimeout` and `TurnToolInfo`.
- Produces: existing `AgentService.chat(actorId, sessionId, userText, ctx): Promise<ChatReply>` as the sole guarded user-facing entry; `verifiedTranscript(userText: string, answer: string, messages: MessageData[], keepToolPairs: boolean): MessageData[]`; optional `cancelSignal?: AbortSignal` as fifth argument of `invokeWithTimeout` while preserving its existing first four arguments.
- Test harness: `makeAgentScopeHarness(options?: { scope?: ScopeDecision; output?: OutputDecision; draft?: string })` returns `{ service: AgentService, calls: { generated: number; persisted: Array<{ outputText: string; messages: MessageData[] }>; assessed: number; reviewed: number }, agent: Agent }` with all external I/O stubbed; allow individual stub methods to be overridden per case.

- [ ] **Step 1: Write failing pipeline tests.** Assert deny/clarify/unavailable/greeting paths never prepare or invoke an agent, never call memory, and persist the selected fixed reply. Allowed requests retain existing guards and ground-check context; mixed decisions reach generation with explicit scope constraints. Do not classify a length/injection/rate/feature/session rejection. Reject a scope-invalid final answer; never send raw provider errors to users. Model calls share the one 60-second deadline. Parent cancellation/late resolution must not proceed to generation or persistence of a draft; next valid turn still succeeds.

```ts
const h = makeAgentScopeHarness({ scope: { route: 'deny', intents: [], memory: [], reason: 'out_of_scope' } });
const reply = await h.service.chat('actor-a', 'session-a', 'Viết Go Hello World', { actorId: 'actor-a' });
assert.equal(h.calls.generated, 0);
assert.equal(reply.answer, fixedSupportReply('refusal', 'vi'));
assert.equal(h.calls.persisted[0]?.outputText, reply.answer);
```

  Test `verifiedTranscript`: successful tool-use/result pairs survive in order; all reasoning/intermediate assistant text is removed; exactly one final verified assistant answer remains. Rejected drafts persist only user plus fallback. No old stored turn is mutated. Define fixtures with paired SDK message blocks, not orphaned mock tool results.
- [ ] **Step 2: Run `npx ts-node test/agent-scope-test.ts`.** Expected: assertions fail against the missing scope gates/transcript helper.
- [ ] **Step 3: Refactor the guarded pipeline, not the public DTO.** Load history once, pass it to assessment and preparation, and use a server-owned decision. Keep the existing feature/rate/session policies. Start one parent abort budget before assessment, propagate it into generation and review, clear timers in `finally`. Keep persistence best-effort and outside model cancellation; persist only the chosen final result. Run deterministic verification before semantic review and append any fixed PII warning last. Rename the misleading private professional-advice scope helper to `applyProfessionalAdviceDisclaimer` without weakening its existing checks; substantive unsafe advice remains the semantic review's responsibility.
- [ ] **Step 4: Wire `verifiedTranscript` into persistence and disable SDK draft printing on the guarded path.** Preserve a safe fixed reply for verifier/provider errors; do not treat a fixed disclaimer as approval. Add `test:agent-scope` and run it, `npm run test:agent-timeout`, and `npm run build`. Expected: pass; no regression in deadline cancellation.
- [ ] **Step 5: Checkpoint via `git diff --check`; no commit unless explicitly authorized.**

### Task 4: Exactly three memory operations and explicit versioned correction

**Files:** Create `src/memory/memory-search.ts`, `src/memory/memory-supersede.ts`, `test/memory-tools-test.ts`; modify `src/memory/types.ts`, `src/memory/memory-save.ts`, `src/memory/memory.service.ts`, `src/memory/memory.repository.ts`, `src/agent/agent.service.ts`, `src/agent/agent.controller.ts`, `src/agent/system-prompt.ts`, `test/memory-service-test.ts`, `test/memory-repository-test.ts`, `docs/memory.md`, `package.json`.

**Interfaces:**
- Consumes: existing `UserMemory`, categories, actor resolution, content/factKey/expiry validation and 1,024-dimensional embeddings; Task 1 memory-operation array.
- Produces: `memorySearchTool(memory: MemoryService, actorId: string)` and `memorySupersedeTool(memory: MemoryService, actorId: string)`, alongside existing `memorySaveTool`. Search tool input remains `{ query: string; limit?: number }` with nonempty query; return structured relevant hits with `id`, `factKey`, category and content. Extend `SearchHit` with `factKey: string | null` and select it in both semantic/lexical CTEs and the fused result.
- Export `MemorySaveInput` from `src/memory/types.ts` with `{ actorId: string; category: MemoryCategory; factKey: string; content: string; importance?: number; sourceTurnId?: string; expiresAt?: Date }`. Preserve `MemoryService.saveMemory(params: MemorySaveInput): Promise<UserMemory>`, but make it create-only. Export `MemorySupersedeInput` with `{ actorId: string; previousMemoryId: string; content: string; importance?: number; expiresAt?: Date }`; add `MemoryService.supersedeMemory(params: MemorySupersedeInput): Promise<UserMemory>`.
- Repository: replace implicit `replaceMemory` with `insertMemory(params: MemorySaveInput & { embedding: number[] }): Promise<UserMemory>`; add `findCurrentMemory(actorId: string, id: string): Promise<UserMemory | null>` and `supersedeMemory(params: MemorySupersedeInput & { embedding: number[] }): Promise<UserMemory>`. Both service and repository import only the shared parameter interfaces from `types.ts`.

- [ ] **Step 1: Write failing memory lifecycle/tool tests.** Assert exactly search/save/supersede registration, actor binding, focused nonempty search and returned IDs/keys. Save a new fact; saving an existing current key returns conflict without superseding/inserting. Supersede creates a new row linked from the old one, preserving old content/category/key/history; unspecified importance/expiry retain old values. Reject missing/foreign/deleted/expired/superseded/keyless targets and stale concurrent corrections with no replacement insertion. Apply all existing privacy/content/dimension checks to both writes. Expired rows do not block a new save. Assert no list/update/forget methods or tool aliases, and inspect Nest route metadata to ensure the four memory CRUD routes are gone while chat/session routes remain.
- [ ] **Step 2: Run `npx ts-node test/memory-tools-test.ts`, `npm run test:memory-service`, and `npm run test:memory-repository`.** Expected: new lifecycle/registration assertions fail against the existing implicit replacement and missing supersede tool.
- [ ] **Step 3: Implement create-only save and atomic supersede.** Use the existing supported-scalar advisory lock pattern on actor+factKey; verify the current target again under the transaction lock before insertion. Keep the existing row immutable except supersession metadata; insert the new version and link old→new atomically. The service may pre-read the actor-owned target for validation/embedding, but this never replaces the locked repository recheck. Update old SQL/mocks/assertions rather than retaining an unused compatibility `replaceMemory` API.
- [ ] **Step 4: Expose only the three tools and remove old surfaces.** Replace `MemoryManager`/`createManager` and its search-only store adapter with explicit actor-bound search/save/supersede tools. Remove obsolete memory initialization in agent preparation. Remove `GET /memory`, `PATCH /memory/:id`, `DELETE /memory/:id`, `DELETE /memory`, unused controller imports, and list/update/forget service/repository methods. Keep database columns/history untouched. Prompt says corrections use search then supersede; ambiguous targets require clarification; forget requests must never become empty/tombstone supersede operations. Report tool failures as failures, not successful save/correction.
- [ ] **Step 5: Add `test:memory-tools`, update `docs/memory.md`, and run the new script plus all three existing memory scripts and `npm run build`.** Expected: pass; SQL tests assert lock-before-recheck-before-write and rollback paths. Mocked tests are not proof of live PostgreSQL concurrency; do not claim a real database race test ran.
- [ ] **Step 6: Checkpoint via `git diff --check`; no commit unless explicitly authorized.**

### Task 5: Enforce invocation tool permissions and isolate spilled output

**Files:** Modify `src/agent/agent.service.ts`, `src/agent/output-cap.ts`; create `test/tool-scope-test.ts`; modify `package.json`.

**Interfaces:**
- Consumes: `allowedToolNames`, the validated per-turn scope decision and existing `GatewaySession` authorization.
- Produces: `prepareAgent(actorId: string, sessionId?: string, ctx?: AgentContext, scope?: ScopeDecision, initialMessages?: MessageData[])` retains its existing return shape. Missing scope denies all tools; guarded `chat()` always supplies it. `installOutputCap(agent: Agent, cap: number, ownedOutputIds?: Set<string>): void`; `readOutputTool(ownedOutputIds?: ReadonlySet<string>)` retains its existing inferred SDK-tool return type.

- [ ] **Step 1: Write failing hook/tool tests.** Exercise registered SDK hooks with mock tools and prove denied callbacks are not executed. Products permit only search/detail; orders still require current gateway authorization; unknown tools blocked; empty memory-operation array/absent actor blocked; `['search']` permits only memory_search; `['save']` permits only memory_save; `['search', 'supersede']` permits target lookup and correction but not save. Removed list/update/forget/forget-all names are always denied. A malicious prior assistant/tool/memory string cannot change the server-owned permission set.

  For `read_output`, invoke cap hook with an oversized synthetic permitted result, capture the newly owned spill ID, and read it successfully. An independent second agent/set, a fabricated ID, and a stale prior-turn ID must fail before file contents are returned. A mixed request's out-of-scope tool callback must never run. Clean up only synthetic spill files created by the tests.
- [ ] **Step 2: Run `npx ts-node test/tool-scope-test.ts`.** Expected: fails against permissive memory/utility bypass and global spill reads.
- [ ] **Step 3: Enforce permissions before all tool callbacks.** Filter advertised tools where practical and always enforce again in the hook. Use SDK `event.cancel` for denied calls; do not merely log and continue. Retain MCP gateway validation and loop detection for allowed commerce tools. Create a fresh ownership set per prepared guarded agent, pass it to spill capture and read tool, and check membership in the read callback as well as permissions at the hook. Preserve default optional-argument behavior for other callers without using it in guarded turns.
- [ ] **Step 4: Add `test:tool-scope`; run it, `npm run test:agent-scope`, `npx ts-node test/guardrails-test.ts`, and `npm run build`.** Expected: all pass; existing authorization tests still pass.
- [ ] **Step 5: Checkpoint via `git diff --check`; no commit unless explicitly authorized.**

### Task 6: CLI parity and verified-only display

**Files:** Modify `src/cli.ts`, `src/agent/agent.service.ts`; create `src/cli-renderer.ts`, `test/cli-guardrails-test.ts`; modify `package.json`.

**Interfaces:**
- Consumes: existing `AgentService.chat()` and `ChatReply`.
- Produces: `writeChatReply(reply: ChatReply, write: (text: string) => void): void` in `src/cli-renderer.ts`; CLI calls `chat(actorId, sessionId, msg, { actorId })` for every non-command message. Remove the unused internal `streamTurn()` API after checking its only caller remains CLI.

- [ ] **Step 1: Write failing CLI tests.** Capture a fake write sink; a deferred guarded turn must emit no draft/answer before resolution, and only its verified answer once afterward. A denied-code request renders a refusal with zero tool calls. Two successive turns use the same actor/session, restoring persisted history. Verify rate/length/injection/turn-limit rejection through the same path as HTTP. No SDK auto-printer, reasoning, or raw tool arguments/results escape the path.
- [ ] **Step 2: Run `npx ts-node test/cli-guardrails-test.ts`.** Expected: fails due to missing final-reply renderer/shared path.
- [ ] **Step 3: Replace independent CLI streaming with awaited guarded chat.** Keep prompt, exit behavior, identity and session creation; remove live delta rendering, snapshot/rebuild code and unused `ToolsetRegistry` imports. A fresh prepared agent obtains the latest toolset each turn. Render only the final verified `ChatReply.answer`; do not add logger/pretty-printer features. Keep existing NestJS logger settings and business logs.
- [ ] **Step 4: Add `test:cli-guardrails`; run it, `npm run test:agent-scope`, and `npm run build`.** Expected: one safe answer per turn, no raw draft output.
- [ ] **Step 5: Checkpoint via `git diff --check`; no commit unless explicitly authorized.**

### Task 7: Semantic evaluation fixtures, regression suite, and operator documentation

**Files:** Create `test/fixtures/support-scope-cases.ts`, `test/scope-live-eval.ts`; extend Task 2–6 tests; modify `package.json`, `README.md`, `docs/agent-harness-overview.md`.

**Interfaces:**
- Consumes: `ScopeService` and policy types; no live MCP, embedding, memory or DB.
- Produces: `SupportScopeCase { id: string; message: string; history: MessageData[]; expectedRoute: ScopeDecision['route']; expectedIntents: SupportIntent[]; expectedMemory: ScopeDecision['memory'] }`; exported `supportScopeCases: SupportScopeCase[]`. Output-review fixtures use `{ id, request: ScopeReviewRequest, expectedAllowed: boolean }`.
- Scripts: `test:scope` runs the seven focused offline test scripts; `eval:scope:live` executes the opt-in evaluator only when `process.env.RUN_SCOPE_LIVE_EVAL === '1'`.

- [ ] **Step 1: Add deterministic regression fixtures and assertions.** Include standalone Go code/debugging/homework; laptop for GoLand; discount codes; product-spec explanation; recent product follow-up; ambiguous pronoun; explicit name recall; explicit durable preference save; correction requiring `['search', 'supersede']`; forget requests receiving an honest unsupported reply with no memory writes; greeting without memory; shopping-plus-code; shipping complaint; medication-return policy versus prescribing; Vietnamese/English mixed language; malicious tool/memory/old assistant instructions; historical coding topic followed by “tiếp tục đi”; valid recovery after rejection. Define exact expected route/intent/memory per case; no wildcard pass criteria. Add final-review cases rejecting substantive Go code, unsupported refunds, unsafe prescribing, and mixed answers that fulfill the denied portion; accept legitimate product terminology and short refusals.
- [ ] **Step 2: Run the targeted offline scripts.** Expected: added tests expose any missing bounds/policy/control-flow behavior; semantic fixtures are data, not mocked proof of model quality.
- [ ] **Step 3: Implement the opt-in evaluator.** Construct only `LlmService`/`ScopeService` with synthetic fixtures, never bootstrap `AppModule`. Default invocation exits nonzero with an enablement message before client initialization. Enabled evaluation prints case IDs, expected/actual enums and aggregate pass counts, not prompts, answers, secrets or credentials. Run serially with a maximum of 40 total semantic calls and stop on transport failure; exit nonzero on any expectation mismatch. Keep model/provider unchanged. The authorization gate is in addition to, not a replacement for, asking the user before running paid/external evaluation.
- [ ] **Step 4: Update README/overview.** Document scope boundaries, mixed requests, failure replies, per-turn extra model calls, 60-second total budget, 6-second classifier limits, CLI buffered answers, existing historical context treatment and model fallibility. Record live evaluation as not run until authorized; do not claim the model is validated from offline mocks.
- [ ] **Step 5: Run complete offline verification.**

```bash
npm run build
npm run test:scope
npm run test:memory
npm run test:memory-service
npm run test:memory-repository
npm run test:session-ownership
npm run test:agent-timeout
npx ts-node test/guardrails-test.ts
git diff --check
```

Expected: all commands exit zero, including real assertion counts. Inspect the guardrails runner's summary because its existing custom assertion helper may print failures without a nonzero exit; fix test exit propagation within the test file if necessary, not by suppressing failures. Do not run `eval:scope:live`, launch the application, or call production tools without authorization.

- [ ] **Step 6: Report results and checkpoint.** Report exact tests run, failures and skipped live semantic evaluation. Identify only task-owned changed hunks; preserve pre-existing dirty changes. No commit/push unless explicitly authorized. An execution-stage independent review, if selected by the user, happens after this verification.

## Self-review (planning only)

- Policy, prompt, contextual decisions, mixed handling, memory gating, tool isolation, buffered delivery, safe replay, failure copy and budgets each have an owning task.
- Review Focus items map to explicit tests above; semantic competence is reserved for opt-in live evaluation.
- All later references use the signatures pinned in Shared Interfaces/owning task blocks; HTTP DTO/model/provider/DB remain unchanged.
- The narrow draft-printer/CLI behavior change is explicitly called out in the design; it is necessary for verified-only display, not a new logging project.
- This document is a plan, not implementation or test execution. Detailed design and execution method require user review before building.
