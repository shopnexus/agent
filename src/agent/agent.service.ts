import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { TurnRepository } from '../db/turn.repository';
import { ActorRepository } from '../db/actor.repository';
import { SkillRepository } from '../db/skill.repository';
import type { Subject } from '../db/conversation.repository';
import { ConversationService } from '../conversation/conversation.service';
import { ConversationContextService } from '../memory/conversation-context.service';
import type { ConsoleMember } from '../console/console-member';
import { AuditLogService } from '../guardrails/audit-log.service';
import { InputGuardService } from '../guardrails/input-guard.service';
import { RateLimiterService } from '../guardrails/rate-limiter.service';
import { FeatureFlags } from '../guardrails/feature-flags';
import { AgentError } from '../http/agent-error';
import { config } from '../config';
import { withTraceContext, traceContext, attachTurnId } from '../observability/trace-context';
import { errorDetails } from '../observability/error-details';
import { limitsOf, parseAgentConfig } from '../run/agent-config';
import { newRunState } from '../run/run-state';
import { TurnRunner } from '../run/turn-runner';

export { FAILURE_ANSWERS } from '../run/failure';
export { invokeWithTimeout } from './invoke';

export interface TurnAccepted { conversation_id: string; turn_id: string }
export interface AskBody { text?: unknown; agent_config?: unknown; skill_id?: unknown; attachments?: unknown }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Opens a console member's turn and hands it to the runner:
 *   check access and input -> open a RUNNING turn under the conversation lock
 *   with its run state -> answer 202 while the run goes on in the background.
 * The agent has no tool that changes data.
 */
@Injectable()
export class AgentService {
  private readonly log = new Logger(AgentService.name);

  constructor(
    private readonly turns: TurnRepository,
    private readonly actors: ActorRepository,
    private readonly skills: SkillRepository,
    private readonly conversationContext: ConversationContextService,
    private readonly conversations: ConversationService,
    private readonly audit: AuditLogService,
    private readonly inputGuard: InputGuardService,
    private readonly rateLimiter: RateLimiterService,
    private readonly runner: TurnRunner,
  ) {}

  async ask(member: ConsoleMember, conversationId: string, body: AskBody): Promise<TurnAccepted> {
    return withTraceContext({ trace_id: randomUUID(), conversation_id: conversationId }, async () => {
      this.log.log(JSON.stringify({ event: 'turn_requested', ...traceContext() }));
      try {
        const accepted = await this.open(member, conversationId, body ?? {});
        this.log.log(JSON.stringify({ event: 'turn_accepted', ...traceContext() }));
        return accepted;
      } catch (error) {
        this.log.warn(JSON.stringify({ event: 'turn_refused', ...traceContext(),
          ...(error instanceof AgentError ? { error_code: error.code } : errorDetails(error)) }));
        throw error;
      }
    });
  }

  private async open(member: ConsoleMember, conversationId: string, body: AskBody): Promise<TurnAccepted> {
    const conversation = await this.conversations.assertVisible(member, conversationId);
    if (conversation.status !== 'active') throw AgentError.closed();
    if (!FeatureFlags.isAgentEnabled || !FeatureFlags.isLlmEnabled) throw AgentError.unavailable();
    if (typeof body.text !== 'string') throw AgentError.badRequest();
    const agentConfig = parseAgentConfig(body.agent_config);
    let skill: { id: string; name: string; prompt: string } | undefined;
    if (body.skill_id !== undefined && body.skill_id !== null) {
      if (typeof body.skill_id !== 'string' || !UUID.test(body.skill_id)) throw AgentError.badRequest();
      const found = await this.skills.find(body.skill_id);
      if (!found) throw AgentError.badRequest();
      skill = { id: found.id, name: found.name, prompt: found.prompt };
    }

    if (!this.rateLimiter.consume(`member:${member.id}`).allowed) {
      this.audit.write({ trace_id: randomUUID(), conversation_id: conversationId, actor_id: member.id, role: member.role,
        event: 'rate_limited', status: 'blocked', block_reason: 'RATE_LIMIT_EXCEEDED', ts: new Date().toISOString() });
      throw new AgentError('rate_limited', 429);
    }
    const guard = this.inputGuard.check(body.text, conversationId, member.id, member.role);
    if (!guard.allowed) throw guard.blockedReason === 'EMPTY_INPUT' ? AgentError.badRequest() : new AgentError('input_rejected', 400);

    await this.actors.upsert(member.id, 'vi');
    const subject: Subject | undefined = conversation.subjectKind && conversation.subjectId
      ? { kind: conversation.subjectKind, id: conversation.subjectId } : undefined;
    // Every prior turn is terminal here (an unfinished one makes startTurn refuse).
    const history = this.conversationContext.build(
      await this.turns.getRecentMessages(conversationId, config.agent.history_turns),
      config.agent.conversation_window, config.agent.history_chars);
    const state = newRunState({ member, conversation_id: conversationId, subject, agent_config: agentConfig,
      question: guard.sanitizedText, skill, messages: history });
    const turn = await this.turns.startTurn({ conversationId, memberId: member.id, userText: guard.sanitizedText,
      modelId: agentConfig.alias || config.model.id, agentId: agentConfig.id, agentName: agentConfig.name,
      deadlineMs: limitsOf(agentConfig).deadline_ms, state });
    attachTurnId(turn.id);
    this.runner.launch(turn.id, state, { kind: 'new' });
    return { conversation_id: conversationId, turn_id: turn.id };
  }
}
