import type { MessageData } from '@strands-agents/sdk';

/** Fresh safe replay data; never mutates historical turns or retains draft text. */
export function verifiedTranscript(userText: string, answer: string, messages: MessageData[], keepToolPairs: boolean): MessageData[] {
  const output: MessageData[] = [{ role: 'user', content: [{ text: userText }] }];
  if (keepToolPairs) {
    for (let i = 0; i + 1 < messages.length; i++) {
      const call = messages[i];
      const result = messages[i + 1];
      if (call.role !== 'assistant' || result.role !== 'user') continue;
      const uses = call.content.filter(block => 'toolUse' in block);
      const results = result.content.filter(block => 'toolResult' in block);
      const ids = uses.map(block => 'toolUse' in block ? block.toolUse.toolUseId : '');
      const resultIds = results.map(block => 'toolResult' in block ? block.toolResult.toolUseId : '');
      if (!ids.length || new Set(ids).size !== ids.length || ids.length !== resultIds.length || !ids.every(id => resultIds.includes(id))) continue;
      output.push(structuredClone({ role: 'assistant', content: uses }), structuredClone({ role: 'user', content: results }));
      i++;
    }
  }
  output.push({ role: 'assistant', content: [{ text: answer }] });
  return output;
}
