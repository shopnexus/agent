import type { MessageData } from '@strands-agents/sdk';

export interface StoredBlock {
  ordinal: number; kind: string; isTerminal: boolean; text?: string | null;
  toolUseId?: string | null; toolName?: string | null; payload?: unknown;
}
export interface StoredConversationTurn {
  ordinal: number; status: string;
  messages: Array<{ ordinal: number; role: string; blocks: StoredBlock[] }>;
}

/** Translate the database transcript to SDK history. Audit rows are never replay data. */
export class ConversationContextService {
  build(turns: StoredConversationTurn[], maxMessages: number, maxChars = 60_000): MessageData[] {
    const selected: MessageData[][] = [];
    let used = 0, chars = 0;
    for (const turn of [...turns].sort((a, b) => b.ordinal - a.ordinal)) {
      const group: MessageData[] = [];
      const assistantBlocks = turn.messages.filter(m => m.role === 'ASSISTANT').flatMap(m => m.blocks);
      const uses = assistantBlocks.filter(b => b.kind === 'TOOL_USE' && b.toolUseId && b.toolName);
      const results = assistantBlocks.filter(b => b.kind === 'TOOL_RESULT' && b.toolUseId);
      for (const message of [...turn.messages].sort((a, b) => a.ordinal - b.ordinal)) {
        const ordered = [...message.blocks].sort((a, b) => a.ordinal - b.ordinal);
        if (message.role === 'USER') {
          const text = ordered.filter(b => b.kind === 'TEXT' && b.text).map(b => ({ text: b.text! }));
          if (text.length) group.push({ role: 'user', content: text });
          continue;
        }
        const pairs = ordered.filter(b => b.kind === 'TOOL_USE' && b.toolUseId && b.toolName && uses.filter(u => u.toolUseId === b.toolUseId).length === 1 && results.filter(r => r.toolUseId === b.toolUseId).length === 1);
        if (pairs.length) {
          group.push({ 
            role: 'assistant', 
            content: pairs.map(b => ({ toolUse: { toolUseId: b.toolUseId!, name: b.toolName!, input: b.payload as any } })) });
          group.push({
            role: 'user', content: pairs.map(b => {
              const payload = results.find(r => r.toolUseId === b.toolUseId)!.payload as any;
              const raw = Array.isArray(payload?.content) ? payload.content : [{ text: 'Tool result unavailable' }];
              // Replay only bounded textual/JSON evidence; never reasoning or attachments.
              const content = raw.flatMap((item: any) => typeof item?.text === 'string' ? [{ text: bound(item.text) }]
                : item?.json !== undefined ? [{ text: bound(JSON.stringify(item.json)) }] : []);
              return { toolResult: { toolUseId: b.toolUseId!, status: payload?.status === 'success' ? 'success' as const : 'error' as const, content: content.length ? content : [{ text: '[Output omitted]' }] } };
            })
          });
        }
        const terminal = ordered.filter(b => b.kind === 'TEXT' && b.isTerminal && b.text).map(b => ({ text: b.text! }));
        if (terminal.length) group.push({ role: 'assistant', content: terminal });
      }
      if (turn.status !== 'SUCCEEDED') group.push({ role: 'assistant', content: [{ text: `[Previous run ${turn.status}: unfinished work must not be treated as verified completion.]` }] });
      const size = JSON.stringify(group).length;
      if (used + group.length > maxMessages || chars + size > maxChars) break;
      if (group.length) { selected.push(group); used += group.length; chars += size; }
    }
    return selected.reverse().flat();
  }
}
function bound(text: string): string {
  return text.length > 12_000 ? text.slice(0, 10_000) + '\n[Truncated restored tool output]\n' + text.slice(-2_000) : text;
}
