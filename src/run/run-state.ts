import type { MessageData } from '@strands-agents/sdk';
import type { AgentConfig } from './agent-config';
import type { Source } from './citations';
import type { ClarifyQuestion } from './answer-blocks';
import type { ConsoleMember, Subject } from './run-request';

export interface RunStep { id: string; title: string; started_at: number; finished_at?: number; summary?: string }

/** Run totals. input_tokens is uncached input: the prompt less cache reads and writes. */
export interface RunUsage { input_tokens: number; output_tokens: number; cache_read_tokens?: number; cache_write_tokens?: number; cost_usd: number; first_token_ms?: number; provider?: string }

/**
 * Everything a later segment needs to continue a turn, sent to the server as
 * checkpoints and back in a resume request: the SDK messages as they stood, the
 * turn's sources, steps and counters, and the member, subject and agent config.
 */
export interface RunState {
  v: 1;
  member: ConsoleMember;
  conversation_id: string;
  subject?: Subject;
  agent_config: AgentConfig;
  question: string;
  /** Skill prompt added to the system prompt, if the turn was asked with one. */
  skill?: { id: string; name: string; prompt: string };
  messages: MessageData[];
  sources: Source[];
  steps: RunStep[];
  model_calls: number;
  usage: RunUsage;
  /** Running time of the segments so far. */
  elapsed_ms: number;
  /** True once the run wrote something: a step, a tool call, text or an answer. */
  wrote: boolean;
  pending_ask?: ClarifyQuestion[];
  /** Updates received that the model has not seen yet. */
  pending_steers?: Array<{ steer_id: string; text: string }>;
  last_provider?: string;
  context_used?: number;
}

/** The state a new turn starts with. */
export function newRunState(init: Pick<RunState, 'member' | 'conversation_id' | 'subject' | 'agent_config' | 'question' | 'skill' | 'messages'>): RunState {
  return { v: 1, ...init, sources: [], steps: [], model_calls: 0, usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, cost_usd: 0 },
    elapsed_ms: 0, wrote: false };
}

export const INTERRUPTED_TOOL = 'This call was interrupted before it returned; its outcome is unknown. Check before repeating it.';
export const CONTINUE_TEXT = 'Continue from where your text stopped, without repeating it.';
const CANCEL_TEXTS = new Set(['Cancelled by user', 'Turn cancelled']);

function blocks(message: MessageData): Array<Record<string, any>> {
  return (message.content ?? []) as Array<Record<string, any>>;
}

/**
 * Messages as they should be stored when a run stops: the SDK's own cancel
 * message is dropped, and a tool use without a result gets an "interrupted"
 * result so the history stays valid.
 */
export function messagesForSave(messages: MessageData[]): MessageData[] {
  const out = messages.map(m => structuredClone(m));
  const last = out.at(-1);
  if (last?.role === 'assistant') {
    const content = blocks(last);
    if (content.length && content.every(b => typeof b.text === 'string' && CANCEL_TEXTS.has(b.text))) out.pop();
  }
  const tail = out.at(-1);
  if (tail?.role === 'assistant') {
    const uses = blocks(tail).filter(b => b.toolUse).map(b => b.toolUse.toolUseId as string);
    if (uses.length) out.push({ role: 'user', content: uses.map(toolUseId => ({ toolResult: { toolUseId, status: 'error', content: [{ text: INTERRUPTED_TOOL }] } })) } as MessageData);
  }
  return out;
}

/**
 * Messages to continue from: a history that ends on assistant text gets a
 * user message asking the model to go on. That message lives only in the
 * model's context.
 */
export function messagesForResume(messages: MessageData[]): MessageData[] {
  const out = messagesForSave(messages);
  if (out.at(-1)?.role === 'assistant') out.push({ role: 'user', content: [{ text: CONTINUE_TEXT }] } as MessageData);
  return out;
}
