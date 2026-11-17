import { Injectable, Logger } from '@nestjs/common';
import { Agent, SlidingWindowConversationManager, BeforeToolCallEvent, type AgentResult, type MessageData } from '@strands-agents/sdk';
import { randomUUID } from 'crypto';
import { LlmService } from '../llm/llm.service';
import { ConsoleRetryStrategy, isBudgetError } from '../llm/budget';
import { McpService, McpSession } from '../mcp/mcp.service';
import { TurnRepository, TurnSource } from '../db/turn.repository';
import { ActorRepository } from '../db/actor.repository';
import type { Subject } from '../db/conversation.repository';
import { ConversationService } from '../conversation/conversation.service';
import { ConversationContextService } from '../memory/conversation-context.service';
import type { ConsoleMember } from '../console/console-member';
import { installOutputCap, readOutputTool } from './output-cap';
import { installToolCallTracker, type ToolCallTracker } from './tool-call-tracker';
import { installSourceCollector } from './sources';
import { buildSystemPrompt } from './system-prompt';
import { AuditLogService } from '../guardrails/audit-log.service';
import { LoopDetector, LoopDetectedError } from '../guardrails/loop-detector';
import { InputGuardService } from '../guardrails/input-guard.service';
import { RateLimiterService } from '../guardrails/rate-limiter.service';
import { FeatureFlags } from '../guardrails/feature-flags';
import { AgentError } from '../http/agent-error';
import { config } from '../config';
import { withTraceContext, traceContext, attachTurnId } from '../observability/trace-context';
import { errorDetails } from '../observability/error-details';

export interface TurnReply {
  conversation_id: string;
  turn_id: string;
  answer: string;
  sources: TurnSource[];
}

type TerminalStatus = 'SUCCEEDED' | 'FAILED' | 'CANCELLED' | 'TIMED_OUT';
type Failure = 'agent_timeout' | 'agent_budget' | 'agent_unavailable';

/** The answer stored on a turn that did not succeed, shown in the conversation. */
export const FAILURE_ANSWERS: Record<Failure | 'agent_stuck', string> = {
  agent_timeout: 'Quá thời gian trả lời. Hãy hỏi lại.',
  agent_budget: 'Hết hạn mức hôm nay.',
  agent_unavailable: 'Agent đang không trả lời được. Hãy thử lại sau.',
  agent_stuck: 'Lượt hỏi bị gián đoạn. Hãy hỏi lại.',
};
const FAILURE_ERRORS: Record<Failure, () => AgentError> = {
  agent_timeout: AgentError.timeout,
  agent_budget: AgentError.budget,
  agent_unavailable: AgentError.unavailable,
};

/** What prepareAgent hands the turn: the agent and the turn's tool bookkeeping. */
export interface PreparedAgent {
  agent: Agent;
  sources: () => TurnSource[];
  toolCalls?: ToolCallTracker;
}

/**
 * One console member's question, buffered:
 *   check access and input -> open a RUNNING turn under the conversation lock
 *   -> connect to server2's MCP as the member -> run the Strands loop with the
 *   read-only tools -> finish the turn with the answer and its sources.
 * The agent has no tool that changes data.
 */
@Injectable()
export class AgentService {
  private readonly log = new Logger(AgentService.name);

  constructor(
    private readonly llm: LlmService,
    private readonly mcp: McpService,
    private readonly turns: TurnRepository,
    private readonly actors: ActorRepository,
    private readonly conversationContext: ConversationContextService,
    private readonly conversations: ConversationService,
    private readonly audit: AuditLogService,
    private readonly inputGuard: InputGuardService,
    private readonly rateLimiter: RateLimiterService,
  ) {}

  async ask(member: ConsoleMember, conversationId: string, text: unknown): Promise<TurnReply> {
    return withTraceContext({ trace_id: randomUUID(), conversation_id: conversationId }, async () => {
      const started = Date.now();
      this.log.log(JSON.stringify({ event: 'turn_requested', ...traceContext() }));
      try {
        const reply = await this.askTurn(member, conversationId, text);
        this.log.log(JSON.stringify({ event: 'turn_answered', ...traceContext(), duration_ms: Date.now() - started }));
        return reply;
      } catch (error) {
        this.log.warn(JSON.stringify({ event: 'turn_refused', ...traceContext(), duration_ms: Date.now() - started,
          ...(error instanceof AgentError ? { error_code: error.code } : errorDetails(error)) }));
        throw error;
      }
    });
  }

  private async askTurn(member: ConsoleMember, conversationId: string, text: unknown): Promise<TurnReply> {
    const conversation = await this.conversations.assertVisible(member, conversationId);
    if (conversation.status !== 'active') throw AgentError.closed();
    if (!FeatureFlags.isAgentEnabled || !FeatureFlags.isLlmEnabled) throw AgentError.unavailable();
    if (typeof text !== 'string') throw AgentError.badRequest();

    if (!this.rateLimiter.consume(`member:${member.id}`).allowed) {
      this.audit.write({ trace_id: randomUUID(), conversation_id: conversationId, actor_id: member.id, role: member.role,
        event: 'rate_limited', status: 'blocked', block_reason: 'RATE_LIMIT_EXCEEDED', ts: new Date().toISOString() });
      throw new AgentError('rate_limited', 429);
    }
    const guard = this.inputGuard.check(text, conversationId, member.id, member.role);
    if (!guard.allowed) throw guard.blockedReason === 'EMPTY_INPUT' ? AgentError.badRequest() : new AgentError('input_rejected', 400);

    await this.actors.upsert(member.id, 'vi');
    const turn = await this.turns.startTurn({ conversationId, memberId: member.id, userText: guard.sanitizedText, modelId: config.model.id });
    attachTurnId(turn.id);
    const subject: Subject | undefined = conversation.subjectKind && conversation.subjectId
      ? { kind: conversation.subjectKind, id: conversation.subjectId } : undefined;
    return this.runTurn(member, conversationId, turn, guard.sanitizedText, subject);
  }

  /** Runs an opened turn to its terminal state; never leaves it RUNNING unless the process dies. */
  private async runTurn(member: ConsoleMember, conversationId: string, turn: { id: string; ordinal: number }, userText: string, subject?: Subject): Promise<TurnReply> {
    const start = Date.now();
    const deadline = config.agent.turn_deadline_ms;
    const controller = new AbortController();
    let expired = false;
    const timer = setTimeout(() => { expired = true; controller.abort(new Error('Turn deadline')); }, deadline);
    let status: TerminalStatus = 'SUCCEEDED';
    let failure: Failure | undefined;
    let answer = '';
    let sources: TurnSource[] = [];
    let result: AgentResult | undefined;
    let prepared: PreparedAgent | undefined;
    let session: McpSession | undefined;
    let opening: Promise<McpSession> | undefined;
    try {
      const run = async () => {
        const history = this.conversationContext.build(
          await this.turns.getRecentMessages(conversationId, config.agent.history_turns, turn.ordinal),
          config.agent.conversation_window, config.agent.history_chars);
        controller.signal.throwIfAborted();
        opening = this.mcp.openSession(member.id);
        session = await opening;
        controller.signal.throwIfAborted();
        prepared = this.prepareAgent(member, conversationId, session, history, { turnId: turn.id, signal: controller.signal, subject });
        const remaining = deadline - (Date.now() - start);
        if (remaining <= 0) throw new Error('Turn deadline');
        result = await invokeWithTimeout(prepared.agent, userText, remaining, invokeOptions(), controller.signal);
        if (!['endTurn', 'stopSequence'].includes(result.stopReason)) throw new Error('Incomplete agent run');
        const text = finalText(result);
        if (!text || text.length > 20_000) throw new Error('Invalid answer length');
        return text;
      };
      answer = await abortable(run, controller.signal);
      sources = prepared?.sources() ?? [];
    } catch (error) {
      // invokeWithTimeout's own timer can fire a millisecond before the turn's, so its
      // "Turn deadline" abort counts as the deadline whatever the clock reads.
      if (Date.now() - start >= deadline || isDeadline(error)) expired = true;
      failure = expired ? 'agent_timeout' : isBudgetError(error) ? 'agent_budget' : 'agent_unavailable';
      status = expired ? 'TIMED_OUT' : 'FAILED';
      controller.abort();
      this.log.error(JSON.stringify({ event: 'turn_failed', ...traceContext(), status, error_code: failure, ...errorDetails(error) }));
      this.audit.write({ trace_id: randomUUID(), conversation_id: conversationId, actor_id: member.id, role: member.role,
        event: 'turn_error', status: 'error', block_reason: failure, ts: new Date().toISOString() });
    } finally {
      clearTimeout(timer);
      // A connection that opens after the deadline is closed when it arrives.
      if (session) await (session as McpSession).close();
      else if (opening) void (opening as Promise<McpSession>).then(s => s.close(), () => {});
    }
    const tracker = (prepared as PreparedAgent | undefined)?.toolCalls;
    if (tracker) {
      try { await tracker.flush(); }
      catch {
        if (!failure) { status = 'FAILED'; failure = 'agent_unavailable'; }
      }
    }
    if (failure) { answer = FAILURE_ANSWERS[failure]; sources = []; }
    const usage = (result as AgentResult | undefined)?.metrics?.latestAgentInvocation?.usage;
    await this.turns.finishTurn({ turnId: turn.id, status, answer, sources, latencyMs: Date.now() - start,
      errorCode: failure, stopReason: (result as AgentResult | undefined)?.stopReason,
      inputTokens: usage?.inputTokens, outputTokens: usage?.outputTokens });
    this.log.log(JSON.stringify({ event: 'turn_completed', ...traceContext(), status, duration_ms: Date.now() - start, source_count: sources.length }));
    if (failure) throw FAILURE_ERRORS[failure]();
    return { conversation_id: conversationId, turn_id: turn.id, answer, sources };
  }

  /** A fresh agent bound to this turn's MCP session; only its read-only tools and read_output run. */
  prepareAgent(member: ConsoleMember, conversationId: string, session: Pick<McpSession, 'tools' | 'labels'>, history: MessageData[],
    run?: { turnId: string; signal: AbortSignal; subject?: Subject }): PreparedAgent {
    const ownedOutputIds = new Set<string>();
    const tools = [readOutputTool(ownedOutputIds), ...session.tools];
    const permitted = new Set(tools.map(t => t.name));
    const agent = new Agent({
      model: this.llm.getModel(),
      messages: history,
      systemPrompt: buildSystemPrompt({ role: member.role, subject: run?.subject }),
      printer: false,
      tools,
      retryStrategy: new ConsoleRetryStrategy(),
      conversationManager: new SlidingWindowConversationManager({
        windowSize: config.agent.conversation_window,
        shouldTruncateResults: true,
      }),
    });
    const sources = installSourceCollector(agent, session.labels);
    installOutputCap(agent, config.agent.tool_output_cap, ownedOutputIds);
    const toolCalls = run ? installToolCallTracker(agent, this.turns, { turnId: run.turnId, signal: run.signal, conversationId, ownedOutputIds }) : undefined;
    const loopDetector = new LoopDetector();
    agent.addHook(BeforeToolCallEvent, (event) => {
      const name = event.toolUse?.name;
      const input = (event.toolUse?.input ?? {}) as Record<string, unknown>;
      if (run?.signal.aborted || !name || !permitted.has(name)) { event.cancel = 'Tool is not permitted for this turn.'; return; }
      if (name === 'read_output' && (typeof input.id !== 'string' || !ownedOutputIds.has(input.id))) {
        event.cancel = 'Output is not owned by this invocation.';
        return;
      }
      try { loopDetector.record(name, input); }
      catch (e) {
        if (!(e instanceof LoopDetectedError)) throw e;
        this.audit.write({ trace_id: randomUUID(), conversation_id: conversationId, actor_id: member.id, role: member.role,
          event: 'loop_detected', tool: name, status: 'blocked', block_reason: e.message, ts: new Date().toISOString() });
        event.cancel = 'Tool loop detected: the same call was repeated. Answer with what you have.';
      }
    });
    return { agent, sources, toolCalls };
  }
}

/** True for the abort both deadline timers raise, possibly wrapped as a cause by the SDK. */
function isDeadline(error: unknown): boolean {
  for (let e = error, depth = 0; e instanceof Error && depth < 5; e = (e as { cause?: unknown }).cause, depth++) {
    if (e.message === 'Turn deadline') return true;
  }
  return false;
}

export function invokeWithTimeout(agent: Agent, userText: string, timeoutMs: number, options?: Parameters<Agent['invoke']>[1], cancelSignal?: AbortSignal): Promise<AgentResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('Turn deadline')), timeoutMs);
  const abort = () => controller.abort(cancelSignal?.reason);
  cancelSignal?.addEventListener('abort', abort, { once: true }); if (cancelSignal?.aborted) abort();
  return abortable(() => agent.invoke(userText, { ...(options ?? {}), cancelSignal: controller.signal }), controller.signal)
    .finally(() => { clearTimeout(timer); cancelSignal?.removeEventListener('abort', abort); });
}
async function abortable<T>(work: () => Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted(); let abort!: () => void;
  const cancelled = new Promise<never>((_, reject) => { abort = () => reject(signal.reason ?? new Error('Turn cancelled')); signal.addEventListener('abort', abort, { once: true }); });
  try { const result = await Promise.race([Promise.resolve().then(work), cancelled]); signal.throwIfAborted(); return result; }
  finally { signal.removeEventListener('abort', abort); }
}
function invokeOptions() { const turns = config.agent.max_turns; return turns > 0 ? { limits: { turns } } : undefined; }
function finalText(result: AgentResult): string { return (result.lastMessage?.content ?? []).filter(b => b.type === 'textBlock').map(b => b.text ?? '').join('').trim(); }
