import type { MessageData } from '@strands-agents/sdk';

/** Past this share of the context window the run compacts before its next model call. */
export const COMPACT_AT = 0.8;
const TRANSCRIPT_CHARS = 120_000;
const TOOL_RESULT_CHARS = 1500;

export type Summarize = (transcript: string) => Promise<string>;

/** A rough token count: four characters a token. */
export function estimateTokens(messages: MessageData[]): number {
  return Math.ceil(JSON.stringify(messages).length / 4);
}

/**
 * Where the kept tail starts: the last assistant message, so the latest tool
 * round stays as it is with its results. The summary goes before it as a user
 * message. -1 when the older part holds no assistant message: nothing to fold.
 */
export function compactionCut(messages: MessageData[]): number {
  let cut = -1;
  for (let i = messages.length - 1; i > 0; i--) if (messages[i].role === 'assistant') { cut = i; break; }
  if (cut <= 0 || !messages.slice(0, cut).some(m => m.role === 'assistant')) return -1;
  return cut;
}

/** The folded messages as plain text for the summariser; tool results are cut short. */
export function transcriptOf(messages: MessageData[]): string {
  const lines: string[] = [];
  for (const m of messages) {
    for (const b of (m.content ?? []) as Array<Record<string, any>>) {
      if (typeof b.text === 'string') lines.push(`${m.role === 'user' ? 'Member' : 'Agent'}: ${b.text}`);
      else if (b.toolUse) lines.push(`Agent called ${b.toolUse.name} ${JSON.stringify(b.toolUse.input ?? {}).slice(0, 500)}`);
      else if (b.toolResult) {
        const text = (b.toolResult.content ?? []).map((c: any) => typeof c.text === 'string' ? c.text : c.json !== undefined ? JSON.stringify(c.json) : '').join(' ');
        lines.push(`Tool result (${b.toolResult.status}): ${text.slice(0, TOOL_RESULT_CHARS)}`);
      }
    }
  }
  const all = lines.join('\n');
  return all.length > TRANSCRIPT_CHARS ? all.slice(all.length - TRANSCRIPT_CHARS) : all;
}

/** The messages after compaction: one user message with the summary and the question, then the kept tail. */
export function compacted(messages: MessageData[], cut: number, summary: string, question: string): MessageData[] {
  const head: MessageData = { role: 'user', content: [{ text:
    `Summary of the earlier conversation and work (older messages were folded to save room):\n${summary.trim()}\n\nThe member's current question: ${question}` }] } as MessageData;
  return [head, ...messages.slice(cut)];
}

export const SUMMARY_PROMPT =
  'Summarise this console conversation and the agent\'s work so far for the agent to continue from. ' +
  'Keep every record id, number, finding and open question; keep source numbers [n] as they are. Plain text, at most 300 words.';
