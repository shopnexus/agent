import { Injectable } from '@nestjs/common';
import { Agent, SlidingWindowConversationManager, type AgentResult } from '@strands-agents/sdk';
import { LlmService } from '../llm/llm.service';
import { MemoryService } from '../memory/memory.service';
import { McpService } from '../mcp/mcp.service';
import { installOutputCap, readOutputTool } from './output-cap';
import { webSearchEnabled, webSearchTool } from '../tools/web-search';
import { config } from '../config';

export interface ChatReply {
  actorId: string;
  sessionId: string;
  answer: string;
}

// `AgentResult` is exported, so import it by name. The constructor config type
// (`tools`) is NOT exported, so derive it from the public constructor signature.
type AgentTools = NonNullable<NonNullable<ConstructorParameters<typeof Agent>[0]>['tools']>;

/**
 * One chat turn:
 *   load durable facts (Memory) -> build the tool set (MCP / tools)
 *   -> run the Strands agent loop -> persist the turn (Memory).
 *
 * Memory is keyed by actor so facts span sessions.
 * The Strands Agent owns the tool-use loop.
 */
@Injectable()
export class AgentService {
  constructor(
    private readonly llm: LlmService,
    private readonly memory: MemoryService,
    private readonly mcp: McpService,
  ) {}

  /** Stateless single turn (HTTP): fresh agent, wait for the final answer. */
  async chat(actorId: string, sessionId: string, userText: string): Promise<ChatReply> {
    const agent = await this.prepareAgent(actorId);
    const result = await agent.invoke(userText, invokeOptions());
    const answer = finalText(result) || '(no response)';
    await this.memory.saveTurn(actorId, sessionId, userText, answer);
    return { actorId, sessionId, answer };
  }

  /**
   * Build a ready-to-use agent (tools + output cap + memory injection). Reuse
   * one instance across a CLI session to keep in-session conversation history;
   * HTTP callers build a fresh one per request.
   */
  async prepareAgent(actorId: string): Promise<Agent> {
    // Memory manager gives both a `search_memory` tool (active recall) and
    // auto-injection of a relevant <memory> block each turn.
    const memory = this.memory.createManager(actorId);
    const tools: AgentTools = [
      readOutputTool(),
      this.mcp.installTool(),
      ...(webSearchEnabled() ? [webSearchTool()] : []),
      ...memory.getTools(),
      ...this.mcp.getTools(),
    ];
    const agent = new Agent({
      model: this.llm.getModel(),
      systemPrompt: buildSystemPrompt(),
      tools,
      // Bound history growth: tool-heavy turns add many messages, so keep only
      // the most recent window (and trim old tool results within it).
      conversationManager: new SlidingWindowConversationManager({
        windowSize: config.agent.conversation_window,
        shouldTruncateResults: true,
      }),
    });
    // Bound any single tool result before it enters context.
    installOutputCap(agent, config.agent.tool_output_cap);
    // Wire injection (and extraction hooks) onto this agent instance.
    await memory.initAgent(agent);
    return agent;
  }

  /** Stream one turn on an existing agent (CLI): yield raw events, then persist. */
  async *streamTurn(agent: Agent, actorId: string, sessionId: string, userText: string) {
    let result: AgentResult | undefined;
    for await (const event of agent.stream(userText, invokeOptions())) {
      if (event.type === 'agentResultEvent') result = event.result;
      yield event;
    }
    const answer = (result && finalText(result)) || '(no response)';
    await this.memory.saveTurn(actorId, sessionId, userText, answer);
  }
}

/** Shared invoke/stream options (turn cap when configured). */
function invokeOptions() {
  const turns = config.agent.max_turns;
  return turns > 0 ? { limits: { turns } } : undefined;
}

/** Pull the final assistant text out of the agent result's last message. */
function finalText(result: AgentResult): string {
  const blocks = result.lastMessage?.content ?? [];
  return blocks
    .filter((b) => b.type === 'textBlock')
    .map((b) => b.text ?? '')
    .join('')
    .trim();
}

/**
 * Grounding system prompt, rebuilt each turn. It pins the real current time and
 * runtime, and tells the model to trust those + tool results over its training
 * priors — the fix for the model guessing a stale year / fabricating facts.
 * Per-user data is NOT here; memory arrives as a separate injected block.
 */
function buildSystemPrompt(): string {
  const now = new Date();
  const when = new Intl.DateTimeFormat('en-US', {
    dateStyle: 'full',
    timeStyle: 'short',
  }).format(now);

  return [
    `You are a helpful assistant running on Amazon Bedrock AgentCore ` +
      `(model ${config.model.id}, region ${config.aws_region}).`,
    '',
    `Current date & time: ${when} (ISO ${now.toISOString()}).`,
    'Your training data has a cutoff and may be out of date. Treat the time above ' +
      'and tool results as ground truth — never infer the current year or date ' +
      'from memory.',
    '',
    'Use the tools available to you (discover them from your tool definitions) ' +
      'whenever they help — prefer a tool over guessing for anything computational, ' +
      'time-sensitive, external, or previously stated by the user.',
    '',
    'Do not fabricate facts, URLs, API names, versions, or numbers. If you are ' +
      'unsure and no tool can settle it, say you do not know. Be concise.',
  ].join('\n');
}

