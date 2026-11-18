import { Injectable, Logger } from '@nestjs/common';
import {
  Agent, AfterModelCallEvent, AfterToolCallEvent, BeforeModelCallEvent, BeforeToolCallEvent, BeforeToolsEvent,
  ContentBlockEvent, ContextWindowOverflowError, Message, ModelStreamUpdateEvent, NullConversationManager, TextBlock,
  ToolResultBlock, toolResultContentFromData, type AgentResult, type MessageData, type Model, type Tool,
} from '@strands-agents/sdk';
import { randomUUID } from 'node:crypto';
import { LlmService } from '../llm/llm.service';
import { ConsoleRetryStrategy, isBudgetError } from '../llm/budget';
import { liteLlmFetch, type LiteLlmResponse, type PromptUsage } from '../llm/litellm-fetch';
import { McpService, type McpSession } from '../mcp/mcp.service';
import { TurnRepository } from '../db/turn.repository';
import { DocumentRepository } from '../db/document.repository';
import { AuditLogService } from '../guardrails/audit-log.service';
import { LoopDetector, LoopDetectedError } from '../guardrails/loop-detector';
import { installOutputCap, readOutputTool } from '../agent/output-cap';
import { installToolCallTracker, type ToolCallTracker } from '../agent/tool-call-tracker';
import { buildRunPrompt, buildSystemPrompt } from '../agent/system-prompt';
import { invokeWithTimeout } from '../agent/invoke';
import { errorDetails } from '../observability/error-details';
import { config } from '../config';
import { traceContext, withTraceContext } from '../observability/trace-context';
import { limitsOf, type ResolvedLimits } from './agent-config';
import { citedNumbers, dropUnknownMarkers, SourceBook, sourceHeader, type Source } from './citations';
import { COMPACT_AT, compacted, compactionCut, estimateTokens, SUMMARY_PROMPT, transcriptOf, type Summarize } from './compaction';
import { eventStatus, isContinuable, outcomeOf, type FailureCode } from './events';
import { FAILURE_ANSWERS } from './failure';
import { OUTPUT_TOOLS, outputTools, type OutputHost } from './output-tools';
import { messagesForResume, messagesForSave, type RunState, type RunStep } from './run-state';
import { compareIds } from './run-bus';
import { isTransientToolError, retryDelayMs, TimedTool, ToolClock, ToolTimeoutError } from './tool-retry';
import { TurnControlService, type ControlWatch } from './turn-control.service';
import { RunEmitter, TurnEventService } from './turn-events.service';
import type { AnswerBlock } from './answer-blocks';

/** Thrown from a hook before a model call to end the SDK run without making the call. */
class RunSignal extends Error {
  constructor(readonly kind: 'pause' | 'ask' | 'answer' | 'limit') { super(`run signal: ${kind}`); this.name = 'RunSignal'; }
}
function findSignal(error: unknown): RunSignal | undefined {
  for (let e = error, depth = 0; e && depth < 5; e = (e as { cause?: unknown }).cause, depth++) if (e instanceof RunSignal) return e;
  return undefined;
}
function causedBy(error: unknown, type: new (...args: any[]) => Error): boolean {
  for (let e = error, depth = 0; e && depth < 5; e = (e as { cause?: unknown }).cause, depth++) if (e instanceof type) return true;
  return false;
}

/** One tool call's attempts in this segment. */
interface ToolCallRun { attempts: number; batchAt: number; cancelled?: boolean; started?: boolean; label?: string; errors?: Array<{ attempt: number; error: string; at: string }> }

export interface SteerInput { steer_id: string; text: string }
export type RunMode =
  | { kind: 'new' }
  | { kind: 'resume'; steers?: SteerInput[]; answers?: string };

/** What prepare hands the run: the agent and its MCP session's labels. */
interface Prepared { agent: Agent; tracker: ToolCallTracker; labels: ReadonlyMap<string, string> }

type Ending =
  | { kind: 'succeeded'; blocks: AnswerBlock[] }
  | { kind: 'paused'; reason: 'member' | 'stop_now' }
  | { kind: 'ask' }
  | { kind: 'failed'; status: 'FAILED' | 'TIMED_OUT'; code: FailureCode };

const sleep = (ms: number, signal: AbortSignal) => new Promise<void>(resolve => {
  const done = () => { clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); };
  const timer = setTimeout(done, ms);
  signal.addEventListener('abort', done, { once: true });
});

/**
 * Runs a turn's segments on this replica: from a new question, or continuing a
 * paused, failed or waiting turn from its saved state. One segment:
 *   open MCP as the member -> run the Strands loop with the read-only tools and
 *   the output tools, publishing events as it goes, reading control messages
 *   before each model call -> end as an answer, a pause, questions for the
 *   member or a failure, saving the state to continue from.
 */
@Injectable()
export class TurnRunner {
  private readonly log = new Logger(TurnRunner.name);
  private readonly active = new Map<string, Promise<void>>();

  constructor(
    private readonly llm: LlmService,
    private readonly mcp: McpService,
    private readonly turns: TurnRepository,
    private readonly events: TurnEventService,
    private readonly control: TurnControlService,
    private readonly documents: DocumentRepository,
    private readonly audit: AuditLogService,
  ) {}

  /** Runs a segment in the background; the caller has made the turn RUNNING. */
  launch(turnId: string, state: RunState, mode: RunMode): void {
    // The request's trace carries on into the run it started.
    const run = withTraceContext({ trace_id: traceContext().trace_id ?? randomUUID(), conversation_id: state.conversation_id, turn_id: turnId },
      () => this.segment(turnId, state, mode))
      .catch(error => this.log.error(JSON.stringify({ event: 'turn_run_crashed', turn_id: turnId, ...errorDetails(error) })))
      .finally(() => this.active.delete(turnId));
    this.active.set(turnId, run);
  }

  /** Resolves when every segment running on this replica has ended (tests, shutdown). */
  async idle(): Promise<void> {
    while (this.active.size) await Promise.allSettled([...this.active.values()]);
  }

  /** Overridable for tests: summarises the folded messages with the run's model. */
  protected async summarize(model: Model, transcript: string): Promise<string> {
    const agent = new Agent({ model, printer: false, tools: [], systemPrompt: SUMMARY_PROMPT, conversationManager: new NullConversationManager() });
    const result = await agent.invoke(transcript);
    return finalText(result);
  }

  private async segment(turnId: string, state: RunState, mode: RunMode): Promise<void> {
    const started = Date.now();
    const limits = limitsOf(state.agent_config);
    const emitter = this.events.emitter(turnId);
    const controller = new AbortController();
    const book = new SourceBook(state.sources);
    const clock = new ToolClock();
    const calls = new Map<string, ToolCallRun>();
    // Updates read from the control stream but not yet given to the model were kept on the state.
    const steers: SteerInput[] = [...(state.pending_steers ?? []), ...(mode.kind === 'resume' ? mode.steers ?? [] : [])];
    state.pending_steers = undefined;
    const stepsDone = () => state.steps.filter(s => s.finished_at).length;
    let deadlineHit = false, stopNow = false, pauseRequested = false;
    let pending: 'answer' | 'ask' | undefined;
    let answer: AnswerBlock[] | undefined;
    let segmentCalls = 0;
    let lastHeaders: LiteLlmResponse | undefined;
    let usage: { inputTokens: number; outputTokens: number } | undefined;
    let promptUsage: PromptUsage | undefined;
    let callStartedAt = 0, firstTokenAt: number | undefined, reasoningStartedAt: number | undefined;
    let result: AgentResult | undefined;
    let failure: unknown;
    let session: McpSession | undefined;
    let prepared: Prepared | undefined;
    let watch: ControlWatch | undefined;

    if (mode.kind === 'new') {
      emitter.emit('turn.started', { agent: { id: state.agent_config.id ?? null, name: state.agent_config.name ?? null },
        model: state.agent_config.alias ?? null, deadline_s: Math.round(limits.deadline_ms / 1000) });
    }
    await this.events.keep(turnId);
    const timer = setTimeout(() => { deadlineHit = true; controller.abort(new Error('Turn deadline')); }, limits.deadline_ms);

    // Pause and stop count only when sent after this segment began; steering is read from where the run stopped.
    const freshAfter = mode.kind === 'new' ? '0-0' : await this.control.cursor(turnId);
    watch = this.control.watch(turnId, state.control_cursor, (message, id) => {
      state.control_cursor = id;
      if (message.type === 'steer') { steers.push({ steer_id: message.steer_id, text: message.text }); return; }
      if (compareIds(id, freshAfter) <= 0) return;
      if (message.type === 'stop') {
        if (stopNow) return;
        stopNow = true;
        emitter.emit('turn.pausing', { steps_done: stepsDone(), reason: 'stop_now' });
        controller.abort(new Error('Stop now'));
      } else if (!pauseRequested) {
        pauseRequested = true;
        emitter.emit('turn.pausing', { steps_done: stepsDone(), reason: 'member' });
      }
    });

    const closeStep = (summary: string) => {
      const step = state.steps.find(s => !s.finished_at);
      if (!step) return undefined;
      step.finished_at = Date.now(); step.summary = summary;
      emitter.emit('step.finished', { step_id: step.id, summary, duration_ms: step.finished_at - step.started_at });
      return step.id;
    };
    const openStep = (): RunStep | undefined => state.steps.find(s => !s.finished_at);

    const host: OutputHost = {
      beginStep: title => {
        closeStep('');
        const step: RunStep = { id: `step-${state.steps.length + 1}`, title, started_at: Date.now() };
        state.steps.push(step); state.wrote = true;
        emitter.emit('step.started', { step_id: step.id, title });
        return step.id;
      },
      endStep: summary => closeStep(summary),
      answer: async blocks => {
        for (const b of blocks) {
          if (b.type === 'document_ref' && !(await this.documents.exists(state.conversation_id, b.document_id, b.version))) {
            return `Document ${b.document_id} version ${b.version} is not in this chat.`;
          }
        }
        answer = blocks.map(b => b.type === 'text' ? { ...b, markdown: dropUnknownMarkers(b.markdown, book) } : b)
          .filter(b => b.type !== 'text' || b.markdown.trim());
        pending = 'answer'; state.wrote = true;
        return undefined;
      },
      writeDocument: async input => {
        const written = await this.documents.write({ conversationId: state.conversation_id, turnId, memberId: state.member.id,
          title: input.title, sections: input.sections, documentId: input.document_id });
        if (!written) return `Document ${input.document_id} is not in this chat.`;
        state.wrote = true;
        return written;
      },
      askUser: questions => { state.pending_ask = questions; if (pending !== 'answer') pending = 'ask'; },
    };

    try {
      session = await this.mcp.openSession(state.member.id);
      controller.signal.throwIfAborted();
      const model = this.llm.createModel({ alias: state.agent_config.alias, user: state.member.id, maxTokens: limits.max_tokens,
        fetch: liteLlmFetch({ signal: controller.signal, onResponse: info => { lastHeaders = info; }, onUsage: u => { promptUsage = u; },
          onWait: until => emitter.emit('rate.waiting', { until: until.toISOString() }) }) });
      const messages = mode.kind === 'new' ? state.messages : messagesForResume(state.messages);
      if (mode.kind === 'resume' && mode.answers) messages.push({ role: 'user', content: [{ text: mode.answers }] } as MessageData);
      prepared = this.prepare({ state, turnId, session, model, messages, host, signal: controller.signal, limits, clock, calls, book, emitter });
      const { agent } = prepared;

      agent.addHook(BeforeModelCallEvent, async () => {
        if (pending) throw new RunSignal(pending);
        if (pauseRequested) throw new RunSignal('pause');
        if (segmentCalls >= limits.max_model_calls) throw new RunSignal('limit');
        state.messages = agent.messages.map(m => m.toJSON());
        state.sources = book.sources;
        // The checkpoint holds updates not yet in its messages, so a run continued from it reads them.
        await this.turns.checkpoint(turnId, { ...state, pending_steers: steers.length ? [...steers] : undefined });
        while (steers.length) {
          const steer = steers.shift()!;
          agent.messages.push(new Message({ role: 'user', content: [new TextBlock(`Update from the member: ${steer.text}`)] }));
          await this.turns.addUserBlock(turnId, steer.text, { steer_id: steer.steer_id });
          emitter.emit('steer.read', { steer_id: steer.steer_id, step_id: openStep()?.id ?? null, step_number: state.steps.length + 1 });
        }
        if ((state.context_used ?? 0) > COMPACT_AT * limits.context_window) await this.compact(agent, model, state, emitter);
        segmentCalls++; state.model_calls++;
        callStartedAt = Date.now(); firstTokenAt = undefined; usage = undefined; promptUsage = undefined;
      }, { order: -100 });

      agent.addHook(ModelStreamUpdateEvent, event => {
        const e = event.event as { type: string; delta?: { type: string; text?: string }; usage?: { inputTokens?: number; outputTokens?: number } };
        if (e.type === 'modelMetadataEvent' && e.usage) usage = { inputTokens: e.usage.inputTokens ?? 0, outputTokens: e.usage.outputTokens ?? 0 };
        if (e.type !== 'modelContentBlockDeltaEvent' || !e.delta) return;
        firstTokenAt ??= Date.now();
        if (e.delta.type === 'textDelta' && e.delta.text) emitter.textDelta(e.delta.text);
        if (e.delta.type === 'reasoningContentDelta') reasoningStartedAt ??= Date.now();
      });

      agent.addHook(ContentBlockEvent, event => {
        const block = event.contentBlock as { type: string; text?: string };
        if (block.type === 'reasoningBlock' && block.text) {
          const from = reasoningStartedAt ?? callStartedAt;
          reasoningStartedAt = undefined;
          emitter.emit('thinking', { summary: block.text.replace(/\s+/g, ' ').trim().slice(0, 280), duration_ms: Date.now() - from });
        }
        if (block.type === 'textBlock' && block.text?.trim()) state.wrote = true;
      });

      // Runs before the retry strategy (default order): usage, the context meter and provider switches.
      agent.addHook(AfterModelCallEvent, event => {
        if (!event.stopData) return;
        const info = lastHeaders;
        const provider = info?.provider;
        if (provider && ((state.last_provider && state.last_provider !== provider) || (info.attempted_fallbacks > 0))) {
          emitter.emit('model.switched', { from_provider: state.last_provider ?? null, to_provider: provider,
            reason: info.attempted_fallbacks > 0 ? `fallback after ${info.attempted_fallbacks} failed attempt(s)` : 'rotation' });
        }
        if (provider) state.last_provider = provider;
        // prompt_tokens counts cache reads and writes; input_tokens is what was neither.
        const prompt = promptUsage?.prompt_tokens ?? usage?.inputTokens ?? 0, output = usage?.outputTokens ?? promptUsage?.completion_tokens ?? 0;
        const cacheRead = promptUsage?.cache_read_tokens ?? 0, cacheWrite = promptUsage?.cache_write_tokens ?? 0;
        const input = Math.max(0, prompt - cacheRead - cacheWrite);
        const firstTokenMs = firstTokenAt ? firstTokenAt - callStartedAt : undefined;
        state.usage.input_tokens += input; state.usage.output_tokens += output;
        state.usage.cache_read_tokens = (state.usage.cache_read_tokens ?? 0) + cacheRead;
        state.usage.cache_write_tokens = (state.usage.cache_write_tokens ?? 0) + cacheWrite;
        state.usage.cost_usd += info?.cost_usd ?? 0;
        state.usage.first_token_ms ??= firstTokenMs;
        if (provider) state.usage.provider = provider;
        emitter.emit('usage', { input_tokens: input, output_tokens: output, cache_read_tokens: cacheRead, cache_write_tokens: cacheWrite, cost_usd: info?.cost_usd ?? null, provider: provider ?? null,
          first_token_ms: firstTokenMs ?? null });
        state.context_used = prompt + output;
        emitter.emit('context.meter', { used_tokens: state.context_used, window_tokens: limits.context_window });
      }, { order: -50 });

      const userText = mode.kind === 'new' ? state.question : [];
      const remaining = limits.deadline_ms - (Date.now() - started);
      result = await invokeWithTimeout(agent, userText, Math.max(1, remaining), undefined, controller.signal);
    } catch (error) {
      failure = error;
    } finally {
      clearTimeout(timer);
      await watch?.stop();
      if (session) await session.close();
    }

    // Tool rows must be written before the turn closes: a finished turn refuses new calls.
    let persistence: unknown;
    try { await prepared?.tracker.flush(); } catch (error) { persistence = error; }
    if (prepared) state.messages = messagesForSave(prepared.agent.messages.map(m => m.toJSON()));
    state.sources = book.sources;
    state.elapsed_ms += Date.now() - started;
    if (steers.length) state.pending_steers = steers;

    const ending = this.ending({ result, failure, answer, signal: findSignal(failure), stopNow, deadlineHit, wrote: state.wrote, persistence, book });
    if (ending.kind === 'failed') {
      this.log.error(JSON.stringify({ event: 'turn_failed', ...traceContext(), status: ending.status, error_code: ending.code, ...errorDetails(failure ?? persistence) }));
      this.audit.write({ trace_id: randomUUID(), conversation_id: state.conversation_id, actor_id: state.member.id, role: state.member.role,
        event: 'turn_error', status: 'error', block_reason: ending.code, ts: new Date().toISOString() });
    }
    await this.end(turnId, state, ending, emitter, closeStep);
    await emitter.flush();
    this.log.log(JSON.stringify({ event: 'turn_segment_ended', ...traceContext(), ending: ending.kind, duration_ms: Date.now() - started, source_count: state.sources.length }));
  }

  private ending(r: { result?: AgentResult; failure?: unknown; answer?: AnswerBlock[]; signal?: RunSignal; stopNow: boolean; deadlineHit: boolean; wrote: boolean; persistence?: unknown; book: SourceBook }): Ending {
    if (r.persistence) return { kind: 'failed', status: 'FAILED', code: 'agent_failed' };
    if (r.answer?.length) return { kind: 'succeeded', blocks: r.answer };
    if (r.signal?.kind === 'ask') return { kind: 'ask' };
    if (r.stopNow) return { kind: 'paused', reason: 'stop_now' };
    if (r.deadlineHit || isDeadline(r.failure)) return { kind: 'failed', status: 'TIMED_OUT', code: 'agent_timeout' };
    if (r.signal?.kind === 'pause') return { kind: 'paused', reason: 'member' };
    if (r.signal?.kind === 'limit') return { kind: 'failed', status: 'FAILED', code: 'agent_limit' };
    if (r.failure) {
      if (isBudgetError(r.failure)) return { kind: 'failed', status: 'FAILED', code: 'agent_budget' };
      if (causedBy(r.failure, ContextWindowOverflowError)) return { kind: 'failed', status: 'FAILED', code: 'agent_context' };
      return { kind: 'failed', status: 'FAILED', code: r.wrote ? 'agent_failed' : 'agent_unavailable' };
    }
    const stop = r.result?.stopReason;
    if (stop === 'endTurn' || stop === 'stopSequence') {
      const text = dropUnknownMarkers(finalText(r.result!), r.book).trim();
      if (text && text.length <= 20_000) return { kind: 'succeeded', blocks: [{ type: 'text', markdown: text }] };
    }
    if (stop === 'maxTokens' || stop === 'limit') return { kind: 'failed', status: 'FAILED', code: 'agent_limit' };
    return { kind: 'failed', status: 'FAILED', code: r.wrote ? 'agent_failed' : 'agent_unavailable' };
  }

  /** Writes the segment's end: the turn's status first, then the event, so a reader that sees it can act on it. */
  private async end(turnId: string, state: RunState, ending: Ending, emitter: RunEmitter, closeStep: (summary: string) => string | undefined) {
    const usage = { inputTokens: state.usage.input_tokens, outputTokens: state.usage.output_tokens,
      cacheReadTokens: state.usage.cache_read_tokens ?? 0, cacheWriteTokens: state.usage.cache_write_tokens ?? 0, costUsd: state.usage.cost_usd,
      firstTokenMs: state.usage.first_token_ms, provider: state.usage.provider };
    if (ending.kind === 'paused' || ending.kind === 'ask') {
      const status = ending.kind === 'ask' ? 'AWAITING_INPUT' : 'PAUSED';
      await emitter.flush();
      if (!(await this.turns.suspend(turnId, status, state, usage, state.elapsed_ms))) return;
      if (ending.kind === 'ask') emitter.emit('clarify', { questions: state.pending_ask ?? [] });
      else emitter.emit('turn.paused', { steps_done: state.steps.filter(s => s.finished_at).length, reason: ending.reason });
      return;
    }
    if (ending.kind === 'succeeded') {
      closeStep('');
      for (const block of ending.blocks) emitter.emit('block', { block });
      state.pending_ask = undefined;
    }
    await emitter.flush();
    const sources = ending.kind === 'succeeded' ? citedSources(state.sources, ending.blocks) : state.sources;
    const status = ending.kind === 'succeeded' ? 'SUCCEEDED' as const : ending.status;
    const code = ending.kind === 'failed' ? ending.code : undefined;
    const answer = ending.kind === 'succeeded'
      ? ending.blocks.filter(b => b.type === 'text').map(b => (b as { markdown: string }).markdown).join('\n\n')
      : FAILURE_ANSWERS[code!];
    const closed = await this.turns.finishTurn({ turnId, status, answer, sources, blocks: ending.kind === 'succeeded' ? ending.blocks : [],
      latencyMs: state.elapsed_ms, errorCode: code, ...usage, state });
    if (!closed) return;
    emitter.emit('turn.finished', { status: eventStatus(status, code), outcome: outcomeOf(status, code), ...(code ? { failure: code } : {}),
      continuable: isContinuable(status, code, state.wrote, true), sources });
  }

  /** Folds older messages into a summary before the next model call. */
  private async compact(agent: Agent, model: Model, state: RunState, emitter: RunEmitter) {
    const messages = agent.messages.map(m => m.toJSON());
    const cut = compactionCut(messages);
    if (cut <= 0) return;
    const before = state.context_used ?? estimateTokens(messages);
    emitter.emit('context.compacting', { before_tokens: before });
    let summary = '';
    try { summary = (await this.summarize(model, transcriptOf(messages.slice(0, cut)))).trim(); }
    catch (error) { this.log.warn(JSON.stringify({ event: 'context_compaction_failed', ...traceContext(), ...errorDetails(error) })); }
    if (!summary) { emitter.emit('context.compacted', { summary: '', before_tokens: before, after_tokens: before }); return; }
    const next = compacted(messages, cut, summary, state.question);
    agent.messages.splice(0, agent.messages.length, ...next.map(m => Message.fromMessageData(m)));
    const after = estimateTokens(next);
    state.context_used = after;
    emitter.emit('context.compacted', { summary, before_tokens: before, after_tokens: after });
  }

  /** A fresh agent bound to this segment: the allowed MCP tools with a time limit, read_output and the output tools. */
  private prepare(p: {
    state: RunState; turnId: string; session: McpSession; model: Model; messages: MessageData[]; host: OutputHost; signal: AbortSignal;
    limits: ResolvedLimits; clock: ToolClock; calls: Map<string, ToolCallRun>; book: SourceBook; emitter: RunEmitter;
  }): Prepared {
    const { state, turnId, session, model, messages, host, signal, limits, clock, calls, book: sources, emitter } = p;
    const ownedOutputIds = new Set<string>();
    const allow = state.agent_config.tools ? new Set(state.agent_config.tools) : undefined;
    const mcpTools = (session.tools as unknown as Tool[]).filter(t => !allow || allow.has(t.name)).map(t => new TimedTool(t, limits.tool_timeout_ms, clock));
    const tools: Tool[] = [readOutputTool(ownedOutputIds) as unknown as Tool, ...(outputTools(host) as unknown as Tool[]), ...mcpTools];
    const permitted = new Set(tools.map(t => t.name));
    const labels = session.labels;
    const agent = new Agent({
      model,
      messages,
      systemPrompt: buildRunPrompt(buildSystemPrompt({ role: state.member.role, subject: state.subject }),
        { instructions: state.agent_config.instructions, skill: state.skill }),
      printer: false,
      tools,
      retryStrategy: new ConsoleRetryStrategy(),
      conversationManager: new NullConversationManager(),
    });
    installOutputCap(agent, config.agent.tool_output_cap, ownedOutputIds);
    const tracker = installToolCallTracker(agent, this.turns, { turnId, signal, conversationId: state.conversation_id, ownedOutputIds,
      skip: name => OUTPUT_TOOLS.has(name),
      meta: id => {
        const call = calls.get(id), run = clock.get(id);
        return { attempts: call?.attempts ?? 1, timing: timingOf(call?.batchAt, run), attemptErrors: call?.errors ?? [], label: call?.label };
      } });
    const loopDetector = new LoopDetector();

    agent.addHook(BeforeToolsEvent, event => {
      const now = Date.now();
      for (const block of event.message.content) if (block.type === 'toolUseBlock' && !calls.has(block.toolUseId)) calls.set(block.toolUseId, { attempts: 0, batchAt: now });
    });
    agent.addHook(BeforeToolCallEvent, event => {
      const name = event.toolUse?.name;
      const call = calls.get(event.toolUse.toolUseId) ?? { attempts: 0, batchAt: Date.now() };
      calls.set(event.toolUse.toolUseId, call);
      call.attempts++;
      const input = (event.toolUse?.input ?? {}) as Record<string, unknown>;
      if (signal.aborted || !name || !permitted.has(name)) { event.cancel = 'Tool is not permitted for this turn.'; call.cancelled = true; return; }
      if (name === 'read_output' && (typeof input.id !== 'string' || !ownedOutputIds.has(input.id))) {
        event.cancel = 'Output is not owned by this invocation.'; call.cancelled = true; return;
      }
      if (OUTPUT_TOOLS.has(name) || call.attempts > 1) return;
      try { loopDetector.record(name, input); }
      catch (e) {
        if (!(e instanceof LoopDetectedError)) throw e;
        this.audit.write({ trace_id: randomUUID(), conversation_id: state.conversation_id, actor_id: state.member.id, role: state.member.role,
          event: 'loop_detected', tool: name, status: 'blocked', block_reason: e.message, ts: new Date().toISOString() });
        emitter.emit('guardrail', { rule: 'loop_stopped', detail: `${name} was called again with the same input` });
        event.cancel = 'Tool loop detected: the same call was repeated. Answer with what you have.';
        call.cancelled = true;
      }
    });
    // After the tracker (order 100) has the row id.
    agent.addHook(BeforeToolCallEvent, event => {
      const name = event.toolUse.name, call = calls.get(event.toolUse.toolUseId);
      if (OUTPUT_TOOLS.has(name) || !call || call.started) return;
      call.started = true;
      emitter.emit('tool.started', { call_id: tracker.callId(event.toolUse.toolUseId) ?? null, step_id: state.steps.find(s => !s.finished_at)?.id ?? null,
        tool: name, label: labels.get(name) ?? name, input: preview(event.toolUse.input) });
    }, { order: 200 });

    // First of the after-hooks: retry, sources from the whole result, then the output cap (-100) and the tracker (100).
    agent.addHook(AfterToolCallEvent, async event => {
      const name = event.toolUse.name, id = event.toolUse.toolUseId;
      if (OUTPUT_TOOLS.has(name)) return;
      const call = calls.get(id) ?? { attempts: 1, batchAt: Date.now() };
      const text = resultText(event.result);
      call.label ??= labels.get(name) ?? name;
      if (event.result.status === 'error' && !call.cancelled) {
        (call.errors ??= []).push({ attempt: call.attempts, error: text.slice(0, 500), at: new Date().toISOString() });
      }
      if (event.result.status === 'error' && !call.cancelled && !signal.aborted && call.attempts < limits.tool_attempts
          && (causedBy(event.error, ToolTimeoutError) || isTransientToolError(text))) {
        const wait = retryDelayMs(call.attempts);
        emitter.emit('tool.retry', { call_id: tracker.callId(id) ?? null, attempt: call.attempts + 1, error: text.slice(0, 300),
          next_in_ms: wait, timeout_ms: limits.tool_timeout_ms });
        await sleep(wait, signal);
        if (!signal.aborted) { event.retry = true; return; }
      }
      const status = call.cancelled ? 'skipped' : event.result.status === 'success' ? 'success' : 'failed';
      let found: Source[] = [];
      if (status === 'success' && labels.has(name)) {
        found = sources.add(name, tracker.callId(id) ?? id, event.result.content ?? [], { input: event.toolUse.input, label: labels.get(name) });
        state.sources = sources.sources;
        const header = sourceHeader(found);
        if (header) {
          event.result = new ToolResultBlock({ toolUseId: event.result.toolUseId, status: event.result.status,
            content: [toolResultContentFromData({ text: header }), ...event.result.content] });
        }
      }
      state.wrote = true;
      const run = clock.get(id);
      emitter.emit('tool.finished', { call_id: tracker.callId(id) ?? null, status, duration_ms: run?.ended ? run.ended - run.started : 0,
        timing: timingOf(call.batchAt, run, text), result_summary: summaryOf(status, text, found.length),
        source_ids: found.map(s => s.n), sources: found });
    }, { order: -200 });
    return { agent, tracker, labels };
  }
}

/** True for the abort both deadline timers raise, possibly wrapped as a cause by the SDK. */
function isDeadline(error: unknown): boolean {
  for (let e = error, depth = 0; e instanceof Error && depth < 5; e = (e as { cause?: unknown }).cause, depth++) {
    if (e.message === 'Turn deadline') return true;
  }
  return false;
}

export function finalText(result: AgentResult): string {
  return (result.lastMessage?.content ?? []).filter(b => b.type === 'textBlock').map(b => (b as TextBlock).text ?? '').join('').trim();
}

function resultText(result: ToolResultBlock): string {
  return (result.content ?? []).map(c => {
    const b = c as { text?: unknown; json?: unknown };
    return typeof b.text === 'string' ? b.text : b.json !== undefined ? JSON.stringify(b.json) : '';
  }).join(' ');
}

function preview(input: unknown): unknown {
  const text = JSON.stringify(input ?? {});
  return text.length <= 2000 ? input : { truncated: true, preview: text.slice(0, 2000) };
}

function summaryOf(status: string, text: string, sourceCount: number): string {
  if (status === 'skipped') return text.slice(0, 160) || 'Skipped';
  if (status === 'failed') return `Failed: ${text.replace(/\s+/g, ' ').slice(0, 160)}`;
  if (sourceCount) return `${sourceCount} record${sourceCount === 1 ? '' : 's'}`;
  return text.replace(/\s+/g, ' ').slice(0, 160);
}

/**
 * queued: from the model asking to the call starting; server: the call itself;
 * db: what server reports in the result (`_meta.timing.db_ms` or `timing.db_ms`), else null;
 * return: from the call's end to the result being recorded.
 */
function timingOf(batchAt: number | undefined, run: { started: number; ended?: number } | undefined, text?: string) {
  let db: number | null = null;
  if (text) {
    const m = /"db_ms"\s*:\s*(\d+(?:\.\d+)?)/.exec(text);
    if (m) db = Number(m[1]);
  }
  return {
    queued: run && batchAt ? Math.max(0, run.started - batchAt) : null,
    server: run?.ended ? run.ended - run.started : null,
    db,
    return: run?.ended ? Math.max(0, Date.now() - run.ended) : null,
  };
}

/** The sources an answer cites, by their [n] in its text (table cells included); every source when it cites none. */
function citedSources(sources: Source[], blocks: AnswerBlock[]): Source[] {
  const texts: string[] = [];
  const collect = (v: unknown) => { if (typeof v === 'string') texts.push(v); else if (Array.isArray(v)) v.forEach(collect); else if (v && typeof v === 'object') Object.values(v).forEach(collect); };
  collect(blocks);
  const cited = citedNumbers(texts);
  return cited.size ? sources.filter(s => cited.has(s.n)) : sources;
}
