import type { MessageData } from '@strands-agents/sdk';

export interface StoredConversationTurn {
  turnIndex: number;
  messages: MessageData[];
}

/** Rebuilds bounded, replayable history from completed transcript turns. */
export class ConversationContextService {
  build(turns: StoredConversationTurn[], maxMessages: number): MessageData[] {
    const result: MessageData[] = [];
    const selected: MessageData[][] = [];
    let used = 0;
    const groups = [...turns].sort((a, b) => b.turnIndex - a.turnIndex);
    for (const turn of groups) {
      const sanitized = turn.messages.map(sanitizeMessage).filter((message): message is MessageData => Boolean(message));
      if (!sanitized.length) continue;
      // Keep a whole turn together so tool-use/result exchanges are never orphaned.
      if (used + sanitized.length > maxMessages) break;
      selected.push(sanitized);
      used += sanitized.length;
    }
    for (const group of selected.reverse()) result.push(...group);
    return result;
  }
}

function sanitizeMessage(message: MessageData): MessageData | undefined {
  const content = message.content.filter((block) => !('reasoning' in block));
  const omitted: string[] = [];
  const kept = content.filter((block) => {
    for (const kind of ['image', 'document', 'audio', 'video'] as const) {
      if (kind in block) {
        omitted.push(kind);
        return false;
      }
    }
    return true;
  });
  if (omitted.length) kept.push({ text: `[Attachment omitted from restored context: ${[...new Set(omitted)].join(', ')}]` });
  if (kept.length === 0) return undefined;
  return { role: message.role, content: kept, trackingId: message.trackingId };
}
