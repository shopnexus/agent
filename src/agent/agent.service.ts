import { Injectable, Logger } from '@nestjs/common';
import { Agent, SlidingWindowConversationManager, type AgentResult, type MessageData, BeforeToolCallEvent, AfterToolCallEvent } from '@strands-agents/sdk';
import { LlmService } from '../llm/llm.service';
import { RetrievalService } from '../retrieval/retrieval.service';
import { McpService } from '../mcp/mcp.service';
import { TurnRepository } from '../db/turn.repository';
import { ConversationService } from '../conversation/conversation.service';
import { installOutputCap, readOutputTool } from './output-cap';
import { memorySearchTool, memorySaveTool, memorySupersedeTool } from '../memory/memory-client';
import { config } from '../config';
import { buildSystemPrompt } from './system-prompt';
import type { MemoryWriteEffect } from './memory-outcome';
import { installMemoryExecution } from './memory-execution';
import { installToolCallTracker, type ToolCallTracker } from './tool-call-tracker';
import { ScopeService } from '../guardrails/scope.service';
import { ScopeDecision, scopeDecisionSchema, outputDecisionSchema, fixedSupportReply, greetingReply, allowedToolNames } from '../guardrails/support-policy';
import { ToolGatewayService, GatewaySession, ToolGatewayError } from '../guardrails/tool-gateway.service';
import { AuditLogService } from '../guardrails/audit-log.service';
import { LoopDetector, LoopDetectedError } from '../guardrails/loop-detector';
import { OutputVerifierService } from '../guardrails/output-verifier.service';
import { InputGuardService } from '../guardrails/input-guard.service';
import { RateLimiterService } from '../guardrails/rate-limiter.service';
import { FeatureFlags } from '../guardrails/feature-flags';
import { randomUUID } from 'crypto';
import { ConversationContextService } from '../memory/conversation-context.service';
import { withTraceContext, traceContext, attachTurnId } from '../observability/trace-context';
import { errorDetails } from '../observability/error-details';
/** Caller-supplied context that grounds the agent to the current user session. */

export interface TurnToolInfo {
  toolNumbers: number[];
  calledTools: string[];
  policySources: string[];
  memoryWrites?: MemoryWriteEffect[];
  toolCalls?: ToolCallTracker;
}

export interface AgentContext {
  /** Reply language. Defaults to Vietnamese. */
  locale?: 'vi' | 'en';
  /** ID of the listing the user is currently viewing, if any. */
  listingId?: string;
  /** Display title of that listing, used for grounding without a tool call. */
  listingTitle?: string;
  /** Which page the user is on, for focused assistance. */
  page?: 'product' | 'cart' | 'order' | 'home';
  actorId?: string;
}

export interface ChatReply {
  actorId: string;
  conversationId: string;
  answer: string;
}

/**
 * One chat turn:
 *   build the tool set (MCP / memory tools / utilities)
 *   -> run the Strands agent loop -> persist the completed turn to DB.
 *
 * Long-term memory is actor-scoped and accessed through explicit tools; no memory is injected automatically.
 * The Strands Agent owns the tool-use loop.
 */
@Injectable()
export class AgentService {
  private readonly log = new Logger(AgentService.name);

  constructor(
    private readonly llm: LlmService,
    private readonly memory: RetrievalService,
    private readonly mcp: McpService,
    private readonly turns: TurnRepository,
    private readonly conversationContext: ConversationContextService,
    private readonly conversations: ConversationService,
    private readonly gateway: ToolGatewayService,
    private readonly audit: AuditLogService,
    private readonly verifier: OutputVerifierService,
    private readonly inputGuard: InputGuardService,
    private readonly rateLimiter: RateLimiterService,
    private readonly scope: ScopeService,
  ) {}

  /** Stateless single turn (HTTP): fresh agent, wait for the final answer. */
  async chat(
    actorId: string,
    conversationId: string,
    userText: string,
    ctx: AgentContext = {},
  ): Promise<ChatReply> {
    return withTraceContext({trace_id:randomUUID(),conversation_id:conversationId},async()=>{
      const started=Date.now();
      this.log.log(JSON.stringify({event:'chat_started',...traceContext()}));
      try {
        const reply=await this.chatTurn(actorId,conversationId,userText,ctx);
        this.log.log(JSON.stringify({event:'chat_completed',...traceContext(),duration_ms:Date.now()-started}));
        return reply;
      } catch(error) {
        this.log.error(JSON.stringify({event:'chat_failed',...traceContext(),duration_ms:Date.now()-started,...errorDetails(error)}));
        throw error;
      }
    });
  }

  private async chatTurn(actorId:string,conversationId:string,userText:string,ctx:AgentContext):Promise<ChatReply> {
    let currentStage='preflight';
    const runStage=async<T>(stage:string,action:()=>T|Promise<T>):Promise<T>=>{
      currentStage=stage;
      const started=Date.now();
      this.log.log(JSON.stringify({event:'stage_started',...traceContext(),stage}));
      try {
        const result=await action();
        this.log.log(JSON.stringify({event:'stage_completed',...traceContext(),stage,duration_ms:Date.now()-started}));
        return result;
      } catch(error) {
        this.log.error(JSON.stringify({event:'stage_failed',...traceContext(),stage,duration_ms:Date.now()-started,...errorDetails(error)}));
        throw error;
      }
    };
    await runStage('ownership',()=>this.conversations.assertOwnedConversation(actorId, conversationId));
    const userType = ctx.actorId ? 'authenticated' : 'anonymous';

    // 0. Kill switch check
    if (!FeatureFlags.isAgentEnabled) {
      return {
        actorId,
        conversationId,
        answer: 'Hệ thống trợ lý ảo ShopNexus đang tạm thời bảo trì để nâng cấp. Xin lỗi vì sự bất tiện này.',
      };
    }

    // 1. Rate limiter check (30 requests/minute per actor)
    const rateCheck = this.rateLimiter.consume(`actor:${actorId}`);
    if (!rateCheck.allowed) {
      this.audit.write({
        trace_id: randomUUID(),
        conversation_id: conversationId,
        actor_id: actorId,
        user_type: userType,
        event: 'rate_limited',
        status: 'blocked',
        block_reason: 'RATE_LIMIT_EXCEEDED',
        ts: new Date().toISOString(),
      });
      return {
        actorId,
        conversationId,
        answer: 'Bạn đang gửi tin nhắn quá nhanh. Vui lòng đợi một lát rồi thử lại nhé.',
      };
    }

    // 2. Input Guard check (length, sanitization, injection classifier, scrape detection, PII)
    const guardResult = this.inputGuard.check(userText, conversationId, actorId, userType);
    if (!guardResult.allowed) {
      return {
        actorId,
        conversationId,
        answer: guardResult.userFacingMessage || 'Yêu cầu không hợp lệ.',
      };
    }
    const cleanUserText = guardResult.sanitizedText;

    // 3. Fallback mode if LLM is kill-switched
    if (!FeatureFlags.isLlmEnabled) {
      return {
        actorId,
        conversationId,
        answer: 'Trợ lý thông minh đang ở chế độ rút gọn. Bạn có thể sử dụng thanh tìm kiếm trực tiếp trên trang web ShopNexus.',
      };
    }

    // 4. Enforce 50 turns/session limit
    const turnCount = await runStage('turn_count',()=>this.turns.getTurnCount(conversationId));
    if (turnCount >= 50) {
      return {
        actorId,
        conversationId,
        answer: 'Phiên trò chuyện đã đạt giới hạn. Vui lòng bắt đầu phiên mới để tiếp tục.',
      };
    }

    const turn = await runStage('start_turn',()=>this.turns.startTurn({conversationId, actorId, userText: cleanUserText, modelId: config.model.id}));
    attachTurnId(turn.id);
    const start = Date.now();
    let status: 'SUCCEEDED' | 'FAILED' | 'TIMED_OUT' | 'CANCELLED' = 'SUCCEEDED';
    let expired = false;
    let invocationResult: AgentResult | undefined;
    const locale = ctx.locale ?? 'vi';
    const controller = new AbortController();
    const timer = setTimeout(() => { expired = true; controller.abort(); }, 60_000);
    let answer = fixedSupportReply('unavailable', locale);
    let messages: MessageData[] = [];
    let keepToolPairs = false;
    let turnToolInfo: TurnToolInfo | undefined;
    try {
      const chosen = await abortable(async () => {
        const greeting = greetingReply(cleanUserText, locale);
        if (greeting) return { answer: greeting, messages: [] as MessageData[], keepToolPairs: false };
        const history = await runStage('history',async()=>this.conversationContext.build(
          await this.turns.getRecentMessages(conversationId, actorId, config.agent.history_turns, turn.ordinal),
          config.agent.conversation_window,
          config.agent.history_chars,
        ));
        controller.signal.throwIfAborted();
        const request = { message: cleanUserText, history, locale };
        const decision = await runStage('assess',async()=>scopeDecisionSchema.parse(await this.scope.assess(request, controller.signal)));
        controller.signal.throwIfAborted();
        if (decision.reason === 'unavailable') status = 'FAILED';
        if (decision.route === 'deny' || decision.route === 'clarify') {
          const kind = decision.route === 'clarify' ? 'clarification' : decision.reason === 'unavailable' ? 'unavailable' : 'refusal';
          return { answer: fixedSupportReply(kind, locale), messages: [] as MessageData[], keepToolPairs: false };
        }
        const { agent, toolInfo } = await runStage('prepare_agent',()=>this.prepareAgent(actorId, conversationId, ctx, decision, history, {turnId:turn.id, signal:controller.signal}));
        turnToolInfo = toolInfo;
        installMemoryExecution(agent, allowedToolNames(decision, !!ctx.actorId), toolInfo.memoryWrites ?? []);
        controller.signal.throwIfAborted();
        const messageStartIndex = agent.messages.length;
        const remaining = 60_000 - (Date.now() - start);
        if (remaining <= 0) throw new Error('Yêu cầu hết thời gian');
        const result = await runStage('generation',()=>invokeWithTimeout(agent, cleanUserText, remaining, invokeOptions(), controller.signal));
        invocationResult = result;
        if (result.stopReason === 'cancelled') status = 'CANCELLED';
        if (!['endTurn', 'stopSequence'].includes(result.stopReason)) throw new Error('Incomplete agent run');
        controller.signal.throwIfAborted();
        if (allowedToolNames(decision, !!ctx.actorId).has('memory_save') &&
            !toolInfo.memoryWrites?.some(write => write.operation === 'save' && write.status === 'completed')) {
          throw new Error('Required memory save did not complete');
        }
        if (toolInfo.memoryWrites?.some(write => write.status !== 'completed')) {
          throw new Error('A memory write did not complete successfully');
        }
        const rawAnswer = finalText(result);
        if (!rawAnswer || rawAnswer.length > 20_000) throw new Error('Invalid answer length');
        const verified = await runStage('verify',()=>this.verifier.verify(rawAnswer, toolInfo));
        if (verified.rulesTriggered.includes('verifier_error_fallback')) throw new Error('Verification failed');
        if (verified.rulesTriggered.length) this.audit.write({
          trace_id: randomUUID(), conversation_id: conversationId, actor_id: actorId, user_type: userType,
          event: 'output_modified', status: verified.modified ? 'modified' : 'ok',
          block_reason: verified.rulesTriggered.join(', '), ts: new Date().toISOString(),
        });
        const review = await runStage('review',async()=>outputDecisionSchema.parse(await this.scope.review({ ...request, decision, answer: verified.text, memoryWrites: (toolInfo.memoryWrites ?? []).map(({ operation, status }) => ({ operation, status })) }, controller.signal)));
        controller.signal.throwIfAborted();
        if (review.reason === 'unavailable') status = 'FAILED';
        if (!review.allowed) return {
          answer: fixedSupportReply(review.reason === 'unavailable' ? 'unavailable' : 'refusal', locale),
          messages: [] as MessageData[], keepToolPairs: false,
        };
        return { answer: verified.text, messages: [] as MessageData[], keepToolPairs: true };
      }, controller.signal);
      answer = chosen.answer;
      messages = chosen.messages;
      keepToolPairs = chosen.keepToolPairs;
      if (keepToolPairs && guardResult.hasPiiWarning) answer += `\n\n${guardResult.hasPiiWarning}`;
    } catch(error) {
      status = expired ? 'TIMED_OUT' : invocationResult?.stopReason === 'cancelled' ? 'CANCELLED' : 'FAILED';
      const localReason=error instanceof Error && ['Incomplete agent run','Required memory save did not complete','A memory write did not complete successfully','Invalid answer length','Verification failed','Yêu cầu hết thời gian'].includes(error.message)?error.message:undefined;
      this.log.error(JSON.stringify({event:'turn_failed',...traceContext(),stage:currentStage,status,reason:localReason,...errorDetails(error)}));
      controller.abort();
      this.audit.write({ trace_id: randomUUID(), conversation_id: conversationId, actor_id: actorId,
        user_type: userType, event: 'turn_error', status: 'error', block_reason: 'GUARDED_TURN_FAILED', ts: new Date().toISOString() });
    } finally { clearTimeout(timer); }
    if (turnToolInfo?.toolCalls) {
      try { await runStage('tool_audit_flush',()=>turnToolInfo!.toolCalls!.flush()); }
      catch {
        status = 'FAILED';
        answer = fixedSupportReply('unavailable', locale);
        keepToolPairs = false;
      }
    }
    const usage = invocationResult?.metrics?.latestAgentInvocation?.usage;
    await runStage('finish_turn',()=>this.turns.finishTurn({turnId:turn.id,status,answer,latencyMs:Date.now()-start,
      errorCode:status === 'SUCCEEDED' ? undefined : 'GUARDED_TURN_FAILED',stopReason:invocationResult?.stopReason,
      inputTokens:usage?.inputTokens,outputTokens:usage?.outputTokens}));
    this.log.log(JSON.stringify({event:'turn_completed',...traceContext(),status,duration_ms:Date.now()-start,
      tool_pairs_retained:keepToolPairs,tool_count:turnToolInfo?.calledTools.length ?? 0}));
    return { actorId, conversationId, answer };
  }

  /** Build a fresh scope-restricted agent; callers provide owner-scoped restored history. */
  async prepareAgent(actorId: string, conversationId = 'default', ctx: AgentContext = {}, scope?: ScopeDecision, initialMessages?: MessageData[], run?: {turnId:string;signal:AbortSignal}): Promise<{ agent: Agent; toolNumbers: number[]; toolInfo: TurnToolInfo }> {
    // Long-term memory is available only when a user identity is supplied by the caller.
    // In production this value must come from verified authentication middleware.
    const permitted = scope ? allowedToolNames(scope, !!ctx.actorId) : new Set<string>();
    const ownedOutputIds = new Set<string>();
    const candidates = [
      readOutputTool(ownedOutputIds),
      ...(ctx.actorId ? [memorySearchTool(this.memory, ctx.actorId), memorySaveTool(this.memory, ctx.actorId, run?.turnId), memorySupersedeTool(this.memory, ctx.actorId)] : []),
      ...this.mcp.getTools(),
    ];
    const tools = candidates.filter(candidate => permitted.has(candidate.name));
    const history = initialMessages ?? this.conversationContext.build(
      await this.turns.getRecentMessages(conversationId, actorId, config.agent.history_turns),
      config.agent.conversation_window,
          config.agent.history_chars,
    );
    const agent = new Agent({
      model: this.llm.getModel(),
      messages: history,
      systemPrompt: buildSystemPrompt(ctx, scope),
      printer: false,
      tools,
      // Bound history growth: tool-heavy turns add many messages, so keep only
      // the most recent window (and trim old tool results within it).
      conversationManager: new SlidingWindowConversationManager({
        windowSize: config.agent.conversation_window,
        shouldTruncateResults: true,
      }),
    });
    // Bound any single tool result before it enters context.
    installOutputCap(agent, config.agent.tool_output_cap, ownedOutputIds);

    // Build gateway session from context
    const gwSession: GatewaySession = {
      conversationId,
      actorId,
      userType: ctx.actorId ? 'authenticated' : 'anonymous',
    };

    // Create loop detector per agent instance
    const loopDetector = new LoopDetector();

    const toolInfo: TurnToolInfo = {
      toolNumbers: [],
      calledTools: [],
      policySources: [],
      memoryWrites: [],
      toolCalls: run ? installToolCallTracker(agent, this.turns, { turnId:run.turnId, signal:run.signal, conversationId, ownedOutputIds }) : undefined,
    };

    // Gateway hook: intercept every tool call before execution
    const NON_MCP_TOOLS = new Set(['read_output', 'memory_search', 'memory_save', 'memory_supersede']);
    agent.addHook(BeforeToolCallEvent, async (event) => {
      const name = event.toolUse?.name;
      const input = (event.toolUse?.input ?? {}) as Record<string, unknown>;

      if (run?.signal.aborted || !name || !permitted.has(name)) {
        event.cancel = 'Tool is not permitted for this turn.';
        return;
      }
      if (name === 'read_output' && (typeof input.id !== 'string' || !ownedOutputIds.has(input.id))) {
        event.cancel = 'Output is not owned by this invocation.';
        return;
      }
      if (NON_MCP_TOOLS.has(name)) {
        toolInfo.calledTools.push(name);
        if (name === 'memory_save' || name === 'memory_supersede') toolInfo.memoryWrites!.push({
          toolUseId: event.toolUse.toolUseId,
          operation: name === 'memory_save' ? 'save' : 'supersede', status: 'pending',
        });
        return;
      }
      try {
        loopDetector.record(name, input);
        // Semantic permissions never bypass deterministic gateway authorization.
        await this.gateway.validate(name, input, gwSession);
        toolInfo.calledTools.push(name);
      } catch (e) {
        if (e instanceof LoopDetectedError) {
          this.audit.write({
            trace_id: randomUUID(),
            conversation_id: conversationId,
            actor_id: actorId,
            user_type: gwSession.userType,
            event: 'loop_detected',
            tool: name,
            status: 'blocked',
            block_reason: e.message,
            ts: new Date().toISOString(),
          });
          event.cancel = 'Lỗi hệ thống: vòng lặp công cụ bị phát hiện. Vui lòng thử lại.';
          return;
        }
        event.cancel = e instanceof ToolGatewayError ? e.reason : 'Tool authorization is unavailable.';
      }
    });

    // Collect numeric values & sources from tool results for output grounding verification
    agent.addHook(AfterToolCallEvent, (event) => {
      const effect = toolInfo.memoryWrites?.find(write => write.toolUseId === event.toolUse.toolUseId);
      if (effect) effect.status = event.result.status === 'success' ? 'completed' : 'uncertain';
      const content = ((event.result?.content ?? []) as Array<{ text?: string; json?: unknown }>);
      const text = content
        .map((b) => b.text ?? (b.json ? JSON.stringify(b.json) : ''))
        .join(' ');
      const NUMBER_RE = /\b(\d{1,3}(?:[.,]\d{3})*(?:[.,]\d+)?|\d+)\b/g;
      let m: RegExpExecArray | null;
      while ((m = NUMBER_RE.exec(text)) !== null) {
        const val = parseFloat(m[1].replace(/,/g, ''));
        if (!isNaN(val) && val > 100) toolInfo.toolNumbers.push(val);
      }
      for (const item of content) {
        if (item && typeof item === 'object' && item.json && typeof item.json === 'object') {
          const json = item.json as Record<string, unknown>;
          if (typeof json.source === 'string') {
            toolInfo.policySources.push(json.source);
          }
        }
      }
    });

    return { agent, toolNumbers: toolInfo.toolNumbers, toolInfo };
  }



}
export function invokeWithTimeout(agent:Agent,userText:string,timeoutMs:number,options?:Parameters<Agent['invoke']>[1],cancelSignal?:AbortSignal):Promise<AgentResult> {
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(new Error('Yêu cầu hết thời gian')),timeoutMs);
  const abort=()=>controller.abort(cancelSignal?.reason);
  cancelSignal?.addEventListener('abort',abort,{once:true});if(cancelSignal?.aborted)abort();
  return abortable(()=>agent.invoke(userText,{...(options ?? {}),cancelSignal:controller.signal}),controller.signal)
    .finally(()=>{clearTimeout(timer);cancelSignal?.removeEventListener('abort',abort);});
}
async function abortable<T>(work:()=>Promise<T>,signal:AbortSignal):Promise<T> {
  signal.throwIfAborted();let abort!:()=>void;
  const cancelled=new Promise<never>((_,reject)=>{abort=()=>reject(signal.reason ?? new Error('Turn cancelled'));signal.addEventListener('abort',abort,{once:true});});
  try {const result=await Promise.race([Promise.resolve().then(work),cancelled]);signal.throwIfAborted();return result;}
  finally {signal.removeEventListener('abort',abort);}
}
function invokeOptions() {const turns=config.agent.max_turns;return turns>0?{limits:{turns}}:undefined;}
function finalText(result:AgentResult):string {return (result.lastMessage?.content ?? []).filter(b=>b.type==='textBlock').map(b=>b.text ?? '').join('').trim();}
