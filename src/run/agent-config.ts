import { z } from 'zod';
import { config } from '../config';
import { AgentError } from '../http/agent-error';

/**
 * The console agent a turn runs as, sent by server with each turn. server is
 * the only source: the agent stores it on the turn's run state and nowhere else.
 */
const schema = z.object({
  id: z.string().min(1).max(64).optional(),
  name: z.string().min(1).max(120).optional(),
  /** The LiteLLM alias, used only on the wire. */
  alias: z.string().min(1).max(128).optional(),
  instructions: z.string().max(20000).optional(),
  instructions_version: z.number().int().min(0).optional(),
  /** Allowed MCP tool names; absent means every read-only tool. */
  tools: z.array(z.string().min(1).max(128)).max(200).optional(),
  limits: z.object({
    deadline_s: z.number().int().min(10).max(300).optional(),
    max_model_calls: z.number().int().min(1).max(200).optional(),
    context_window: z.number().int().min(4000).max(2_000_000).optional(),
    tool_timeout_s: z.number().min(1).max(300).optional(),
    tool_attempts: z.number().int().min(1).max(5).optional(),
    max_tokens: z.number().int().min(256).max(64000).optional(),
  }).partial().optional(),
}).strip();

export type AgentConfig = z.infer<typeof schema>;

export interface ResolvedLimits {
  deadline_ms: number; max_model_calls: number; context_window: number;
  tool_timeout_ms: number; tool_attempts: number; max_tokens?: number;
}

export function parseAgentConfig(value: unknown): AgentConfig {
  if (value === undefined || value === null) return {};
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw AgentError.badRequest();
  return parsed.data;
}

/** The limits a run uses: agent_config's, else this service's defaults. */
export function limitsOf(agent: AgentConfig): ResolvedLimits {
  const l = agent.limits ?? {};
  return {
    deadline_ms: l.deadline_s ? l.deadline_s * 1000 : config.agent.turn_deadline_ms,
    max_model_calls: l.max_model_calls ?? config.agent.max_model_calls,
    context_window: l.context_window ?? config.agent.context_window,
    tool_timeout_ms: l.tool_timeout_s ? Math.round(l.tool_timeout_s * 1000) : config.agent.tool_timeout_ms,
    tool_attempts: l.tool_attempts ?? config.agent.tool_attempts,
    max_tokens: l.max_tokens,
  };
}
