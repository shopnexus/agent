import type { MessageData } from '@strands-agents/sdk';
import type { HistoryTurn } from '../run/run-request';
import { boundedToolUseId } from '../agent/tool-call-tracker';

/**
 * Turns the prior terminal turns the server sends (oldest first) into SDK
 * history: the question and inputs as user text, complete tool pairs, the
 * terminal answer, and a note on a run that did not succeed. Newest turns are
 * kept first, whole, within the message window and the character budget.
 */
export class ConversationContextService {
  build(turns: HistoryTurn[], maxMessages: number, maxChars = 60_000): MessageData[] {
    const selected: MessageData[][] = [];
    let used = 0, chars = 0;
    for (const turn of [...turns].reverse()) {
      const group = turnMessages(turn);
      const size = JSON.stringify(group).length;
      if (used + group.length > maxMessages || chars + size > maxChars) break;
      if (group.length) { selected.push(group); used += group.length; chars += size; }
    }
    return selected.reverse().flat();
  }
}

type ToolEntry = Extract<HistoryTurn['entries'][number], { kind: 'tool' }>;

function turnMessages(turn: HistoryTurn): MessageData[] {
  const group: MessageData[] = [];
  if (turn.question.trim()) group.push({ role: 'user', content: [{ text: turn.question }] });
  // A tool use id seen twice cannot be paired safely; such calls are left out.
  const counts = new Map<string, number>();
  for (const e of turn.entries) if (e.kind === 'tool') counts.set(e.tool_use_id, (counts.get(e.tool_use_id) ?? 0) + 1);
  let pairs: ToolEntry[] = [];
  const flush = () => {
    if (!pairs.length) return;
    group.push({ role: 'assistant', content: pairs.map(p => ({ toolUse: { toolUseId: boundedToolUseId(p.tool_use_id), name: p.name, input: (p.input ?? {}) as any } })) });
    group.push({ role: 'user', content: pairs.map(p => ({ toolResult: { toolUseId: boundedToolUseId(p.tool_use_id), status: p.status, content: resultContent(p.content) } })) });
    pairs = [];
  };
  for (const entry of turn.entries) {
    if (entry.kind === 'tool') { if (counts.get(entry.tool_use_id) === 1) pairs.push(entry); continue; }
    flush();
    if (entry.text.trim()) group.push({ role: 'user', content: [{ text: entry.text }] });
  }
  flush();
  if (turn.answer?.trim()) group.push({ role: 'assistant', content: [{ text: turn.answer }] });
  if (turn.status !== 'SUCCEEDED') group.push({ role: 'assistant', content: [{ text: `[Previous run ${turn.status}: unfinished work must not be treated as verified completion.]` }] });
  return group;
}

/** Only bounded text and JSON evidence is replayed; never reasoning or attachments. */
function resultContent(raw: unknown[] | undefined): Array<{ text: string }> {
  const content = (raw ?? []).flatMap((item: any) => typeof item?.text === 'string' ? [{ text: bound(item.text) }]
    : item?.json !== undefined ? [{ text: bound(JSON.stringify(item.json)) }] : []);
  return content.length ? content : [{ text: '[Output omitted]' }];
}

function bound(text: string): string {
  return text.length > 12_000 ? text.slice(0, 10_000) + '\n[Truncated restored tool output]\n' + text.slice(-2_000) : text;
}
