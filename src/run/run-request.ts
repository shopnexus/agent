import { z } from 'zod';
import { AgentError } from '../http/agent-error';
import { parseAgentConfig, type AgentConfig } from './agent-config';
import type { RunState } from './run-state';

export type ConsoleRole = 'moderator' | 'admin';
/** The console member the server runs the segment for. */
export interface ConsoleMember { id: string; role: ConsoleRole }
export type SubjectKind = 'ticket' | 'report_case' | 'account';
export interface Subject { kind: SubjectKind; id: string }

const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i).transform(s => s.toLowerCase());

const historyEntry = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('input'), text: z.string() }),
  z.object({
    kind: z.literal('tool'), tool_use_id: z.string().min(1), name: z.string().min(1).max(128),
    input: z.unknown().optional(), status: z.enum(['success', 'error', 'failed']).transform(v => v === 'success' ? 'success' as const : 'error' as const), content: z.array(z.unknown()).optional(),
  }),
]);

const historyTurn = z.object({
  status: z.enum(['SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT']),
  question: z.string(),
  entries: z.array(historyEntry).default([]),
  answer: z.string().nullish(),
});
export type HistoryTurn = z.infer<typeof historyTurn>;

const steer = z.object({ steer_id: z.string().min(1).max(64), text: z.string() });

const body = z.object({
  turn_id: uuid,
  conversation_id: uuid,
  member: z.object({ id: uuid, role: z.enum(['moderator', 'admin']) }),
  mode: z.enum(['new', 'resume']),
  question: z.string(),
  subject: z.object({ kind: z.enum(['ticket', 'report_case', 'account']), id: uuid }).nullish(),
  agent_config: z.unknown().optional(),
  skill: z.object({ id: z.string().min(1), name: z.string(), prompt: z.string() }).nullish(),
  history: z.array(historyTurn).max(50).default([]),
  state: z.record(z.string(), z.unknown()).nullish(),
  steers: z.array(steer).default([]),
  answers: z.string().nullish(),
  documents: z.array(z.object({ document_id: z.string().min(1), latest_version: z.number().int().min(1) })).default([]),
  control_after: z.number().int().min(0).default(0),
});

/** The state a resumed segment needs at least; the rest is the agent's own checkpoint. */
const resumeState = z.object({
  v: z.literal(1),
  question: z.string(),
  messages: z.array(z.unknown()),
  sources: z.array(z.unknown()),
  steps: z.array(z.unknown()),
  usage: z.object({ input_tokens: z.number(), output_tokens: z.number(), cost_usd: z.number() }).passthrough(),
}).passthrough();

export interface RunRequest {
  turn_id: string;
  conversation_id: string;
  member: ConsoleMember;
  mode: 'new' | 'resume';
  question: string;
  subject?: Subject;
  /** Present only when the request carried one. */
  agent_config?: AgentConfig;
  skill?: { id: string; name: string; prompt: string };
  history: HistoryTurn[];
  state?: RunState;
  steers: Array<{ steer_id: string; text: string }>;
  answers?: string;
  documents: Array<{ document_id: string; latest_version: number }>;
  control_after: number;
}

/** Checks a `POST /runs` body; anything malformed is 400 bad_request. */
export function parseRunRequest(value: unknown): RunRequest {
  const parsed = body.safeParse(value);
  if (!parsed.success) throw AgentError.badRequest();
  const b = parsed.data;
  const agentConfig = b.agent_config === undefined || b.agent_config === null ? undefined : parseAgentConfig(b.agent_config);
  let state: RunState | undefined;
  if (b.mode === 'resume') {
    if (!resumeState.safeParse(b.state).success) throw AgentError.badRequest();
    state = b.state as unknown as RunState;
  } else if (!b.question.trim()) throw AgentError.badRequest();
  return {
    turn_id: b.turn_id, conversation_id: b.conversation_id, member: b.member, mode: b.mode, question: b.question,
    subject: b.subject ?? undefined, agent_config: agentConfig, skill: b.skill ?? undefined, history: b.history,
    state, steers: b.steers, answers: b.answers ?? undefined, documents: b.documents, control_after: b.control_after,
  };
}
