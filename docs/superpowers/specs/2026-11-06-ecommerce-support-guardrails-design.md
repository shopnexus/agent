# Ecommerce Support Scope and Guardrails — Design B

Date: 2026-11-06
Status: Proposed design accompanying the requested implementation plan; approach B selected by the user. Detailed behavior and implementation remain subject to review.

## Intent

Keep ShopNexus a helpful ecommerce support assistant rather than a general-purpose chatbot. Reject unrelated programming tasks without blocking legitimate shopping requests such as selecting a laptop for programming. Support contextual follow-ups, mixed requests, ordinary greetings, and personalization without unnecessary memory access.

## Current state

- `src/agent/agent.service.ts` builds a bilingual system prompt inline. It lists capabilities but does not explicitly reject unrelated work.
- HTTP `chat()` applies input guards, feature flags, rate limits, and a 50-turn session cap. CLI `streamTurn()` bypasses most of that path.
- `OutputVerifierService.applyScopeCheck()` adds professional-advice disclaimers; it is not an ecommerce scope gate.
- Gateway hooks validate MCP tool calls but explicitly bypass memory and utility tools.
- The SDK printer and CLI renderer expose generated text before output verification. Post-processing cannot retract that text.
- Completed tool transcripts are persisted and restored, so withholding a rejected answer from the API alone does not prevent future replay.

## Goals and boundaries

Allowed:
- Product discovery, comparison, suitability, and shopping advice, including technical explanations needed to choose or use a purchased product.
- ShopNexus orders, shipping, payments, returns, complaints, fraud reporting, and platform usage within available capabilities.
- Short greetings, thanks, empathetic acknowledgement, and first-person durable preferences relevant to personalization. Do not turn casual conversation into open-ended coaching.
- Contextual follow-ups such as “cái thứ hai còn hàng không?” when recent owner-scoped conversation resolves them.

Not allowed:
- Unrelated code generation, debugging, homework, creative writing, political debate, or other general-purpose tasks.
- Diagnosis, prescribing, personalized legal conclusions, and investment recommendations. A disclaimer does not make prohibited substantive advice acceptable.
- Claiming an order was cancelled, payment processed, refund issued, or another unsupported action completed.
- Revealing internal instructions, secrets, or another actor's information; following instructions embedded in memory or tool data.

Mixed requests: answer the legitimate shopping portion, briefly decline the unrelated portion, and never perform its tool calls. Ambiguous requests: ask one focused clarification rather than guessing or inventing references.

Non-goals: add commerce actions, change authentication infrastructure, migrate the database, change memory categories/embedding dimensions, change model routes or credentials, or create a logging subsystem. Model-based classification is fallible; this is layered risk reduction, not a perfect security boundary.

## Approaches

A. Prompt-only: cheapest and fastest but lacks enforcement outside model compliance.

B. Shared prompt policy + contextual scope assessment + application-enforced tool permissions + final-response checks: selected direction. Existing deterministic controls continue to protect identity and tool contracts. Semantic checks use the existing configured orchestration model through LiteLLM, not a new dedicated model or provider.

C. Dedicated independent guard model on every request and response: stronger separation but more deployment complexity and cost than needed here.

The details below are implementation proposals, not claims that the user individually selected each parameter.

## Proposed request lifecycle

1. Apply the existing feature flags, rate limit, input sanitization, injection checks, and session turn limit through one `AgentService.chat()` entry point for HTTP and CLI.
2. Load owner-scoped recent conversation once. Build the existing replayable conversation plus a smaller text-only view for scope assessment; exclude tool payloads, reasoning, and memory from the classifier's history.
3. Assess the sanitized message plus recent conversational context. A pure greeting fast path may return a fixed response without model/tool/memory calls; use exact normalized greetings only, never a prefix match that accepts an attached request.
4. Application code chooses a fixed refusal/clarification for denied or unclear requests; do not let the classifier write user-visible replies.
5. For allowed/mixed requests, construct the agent with a server-owned scope decision and restrict tool execution before callbacks run. The original user message stays untrusted data; no model-generated text is promoted to system instructions.
6. Run the current deterministic output verifier on the draft. Then semantically check the proposed final response against the original request and scope decision. The verifier receives approved policy source context for policy citations.
7. On semantic rejection or verifier failure, use a fixed safe response; do not regenerate automatically. Persist and display only the verified final answer.

## Policy contracts

`SupportIntent`: `products | orders | policies | platform | personal_context | smalltalk`.

`ScopeDecision`:
- `route`: `allow | mixed | clarify | deny`.
- `intents`: unique allowed intent values; nonempty for allow/mixed, empty for deny/clarify.
- `memory`: a unique array of `search | save | supersede` operations; deny/clarify/smalltalk-only decisions must use `[]`.
- `reason`: `in_scope | mixed_request | out_of_scope | ambiguous | unsafe | unavailable`.

The schema enforces consistent routes/reasons. Save means the current message explicitly supplies a new durable first-person fact; search means saved personal context is relevant; supersede means the user supplies a correction to an existing fact. `['search', 'supersede']` supports identifying the exact existing fact before replacing it. These permissions do not bypass eligibility/actor checks.

`OutputDecision`: `{ allowed: boolean; reason: 'in_scope' | 'out_of_scope' | 'unsafe' | 'unsupported_action' | 'unavailable' }`, validated strictly and consistently. Unknown fields, invalid JSON, missing content, wrong enum values, and inconsistent combinations fail closed.

Input and output classifier prompts contain the same server-owned domain policy, but classify request intent and response compliance separately. They explicitly treat conversation, request text, draft text, tool results, and memory as untrusted data. Plain JSON responses are parsed with Zod; correctness must not depend on a provider supporting JSON-schema response mode.

## Tool policy

- products → `search_products`, `get_product`.
- orders → `get_order`; existing gateway authorization still applies.
- policies → `get_policy`.
- platform → no additional tools unless another approved intent permits them.
- personal_context → no commerce tools by itself.
- smalltalk → no tools.
- `memory_search`, `memory_save`, and `memory_supersede` are the only memory tools. Each requires the matching operation in `memory` and a trusted actor. No list/update/forget/forget-all tools or fallback aliases.
- `read_output` only for the output ID previously spilled by a permitted tool in this invocation; the output store must record invocation ownership, and unknown/cross-invocation IDs are denied.
- Unknown tools fail closed. Check the invocation's policy before execution, including tools previously bypassing the MCP gateway. Gateway allowlist, Zod schema, and actor authorization remain independent checks.

Use one `Set<string>` per guarded agent invocation, passed to `installOutputCap` and `readOutputTool`; record spill IDs at creation and reject reads absent from the set. This is an in-memory ownership check, not a redesign of the spill file store. Existing callers may keep the current optional-argument behavior; guarded turns must always supply the set.

## Memory lifecycle — user-selected surface

Keep exactly three operations:
- `memory_search(query, limit?)`: actor-scoped relevant retrieval, returning `id`, `factKey`, category and content so the agent can identify an existing fact. Never use an empty query as a disguised list-all operation.
- `memory_save(category, factKey, content, importance?, expiresAt?)`: create a new fact. If the actor already has a current fact for that key, return an explicit conflict and require supersede; do not silently replace it.
- `memory_supersede(previousMemoryId, content, importance?, expiresAt?)`: atomically create the corrected fact and mark the specified current fact superseded using `superseded_at`/`superseded_by`. Resolve category/factKey from the actor-owned prior record, preserve history, and never update its content in place. Unspecified importance/expiry retain the prior values. Reject foreign, missing, deleted, expired, already-superseded or keyless targets without inserting a replacement. A stale target must not overwrite a newer correction.

A current fact is not deleted, not superseded, and not expired. Lock actor+factKey and recheck the target within the transaction so concurrent saves/corrections cannot create multiple current facts. Existing expired rows do not block saving a new current fact. Existing category, content, factKey, expiry and 1,024-dimension validation applies to both write operations.

Remove the old memory list/update/forget/forget-all controller routes (`GET /memory`, `PATCH /memory/:id`, `DELETE /memory/:id`, `DELETE /memory`) and their unused service/repository methods during implementation. No replacement memory CRUD endpoints. Retain historical database columns and existing rows; do not migrate/drop data. Update API tests and documentation for this intentional surface reduction.

A deletion request is not permission to supersede with an empty value, tombstone, or fabricated preference. Explain that deletion is not supported by this agent; never claim the information was erased. Supersede is correction/versioning, not a synonym for forget. Only the user's actual correction can authorize it, not instructions from memory/tool data. Ambiguous targets require clarification.

## Output, persistence, and CLI

CLI calls the same guarded `chat()` path rather than owning a separate agent and guard-bypassing stream. A fresh agent per turn restores the persisted conversation, matching HTTP behavior. Toolset updates are picked up on the next turn.

User-visible answer text is buffered until verification. The SDK auto-printer must be disabled for guarded invocations because it prints drafts before checks. This is a narrow exception to keeping existing logging unchanged: keep NestJS memory/gateway/audit logs; add no replacement printer or logger. CLI prints the final answer once and does not print reasoning, raw tool arguments/results, or draft tokens. Real-time answer streaming is deferred.

Persist user text and the verified final answer. For approved outputs, preserve complete tool-use/result pairs but remove intermediate assistant text/reasoning and replace the final draft with the verified answer. For denied/rejected/error/clarification paths, store only user plus fixed final reply, without rejected draft/tool transcript. Never mutate stored old turns. Old context is untrusted and must not authorize out-of-scope work or override policy.

## Failure behavior and limits

- Total model-related request budget: 60,000 ms from scope assessment through final semantic verification; propagate one parent cancellation signal.
- Each semantic classifier call: at most 6,000 ms, no SDK retries, at most 512 output tokens. No automatic classifier or generation retry.
- Scope history: at most six recent user/assistant text messages, at most 500 characters each, excluding the current request which already has the existing 2,000-character input limit. Select the most recent messages, preserving chronology.
- Output review: at most 20,000 characters; over-limit answers use the safe fallback, never approve a truncated prefix while displaying an unchecked suffix.
- Semantic timeout, invalid schema, provider errors, or cancelled generation: no model/tool continuation and no draft display. Use the configured language's fixed temporary-unavailability reply.
- Failures are not reported as user policy violations. Do not send raw provider errors to the user.
- Existing rate limits, actor scoping, 1,024-dimension memory validation, and memory eligibility checks remain intact.

Costs: an ordinary accepted turn adds one short input assessment and one short output review using the existing model. Pure fixed greetings and denied/clarified inputs skip agent generation/output review. This is an explicit first-version reliability tradeoff; optimize later using evaluation evidence rather than permissive keyword shortcuts.

## Fixed response copy

Use Vietnamese and English equivalents in one policy module. Exact Vietnamese copy:
- Scope refusal: “Mình hỗ trợ mua sắm và các vấn đề trên ShopNexus nên không thể hỗ trợ yêu cầu này. Bạn cần tìm sản phẩm hoặc hỗ trợ đơn hàng nào không?”
- Clarification: “Bạn muốn mình hỗ trợ sản phẩm, đơn hàng hay vấn đề nào trên ShopNexus?”
- Temporary unavailability: “Mình chưa thể xử lý yêu cầu an toàn lúc này. Bạn vui lòng thử lại hoặc liên hệ bộ phận hỗ trợ ShopNexus nhé.”
- Greeting: “Chào bạn! Mình có thể giúp tìm sản phẩm hoặc hỗ trợ vấn đề nào trên ShopNexus?”

Mixed requests may receive a natural short refusal of the denied portion inside the generated answer; final review rejects substantive fulfillment of that portion. Avoid repeating the assistant's identity or addressing the user by name without a relevant reason.

## Verification and acceptance

Offline deterministic tests mock model transport and tools. They prove control flow and permissions, not real model comprehension. A separate opt-in, non-mutating live semantic evaluation uses synthetic data, fixed cases, the configured model, and no real MCP/database/memory operations; it is never run without authorization.

Required behavior examples:
- Deny standalone Go Hello World, debugging, and unrelated writing.
- Allow laptop recommendations for GoLand and discount-code questions.
- Resolve product follow-ups from recent history, or clarify without guessing.
- Fulfill only the shopping part of a shopping-plus-code request.
- Recognize code-switching Vietnamese/English and Unicode variation without relying on keyword bans.
- Distinguish product side-effect/return questions from requests to prescribe medication.
- Do not call memory on greetings or unrelated requests; actor-scoped search/save/supersede remains available when justified.
- Save a new shoe-size fact; correct it using search then supersede; do not overwrite the prior row or silently supersede through save.
- Reject stale/cross-actor supersede targets without inserting anything, and do not interpret forget requests as corrections.
- Expose exactly the three selected memory tools; removed memory CRUD routes are unavailable.
- A tool/memory payload or old assistant response claiming policy changed cannot expand scope.
- No leaked draft in CLI stdout, response JSON, new persisted replay messages, or audit content.
- Classifier failures stop execution; valid requests remain possible after an earlier failed/rejected turn.

## Constraints for implementation

No `.env` reads or writes; no secret output. Do not change Docker/LiteLLM routes, provider model selection, API key names, database schema, or embedding configuration. No new runtime dependencies. Use NestJS, existing OpenAI client, Zod, and the current `ts-node` assertion-based tests. Do not commit/push unless the user explicitly asks; preserve all existing dirty changes. No multi-agent implementation is authorized by this design.
