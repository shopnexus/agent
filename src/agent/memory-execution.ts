import { Agent, InvokeModelStage } from '@strands-agents/sdk';
import type { MemoryWriteEffect } from './memory-outcome';

/** Never interpret text resembling an action as an executable tool call. */
function exposesMemoryProtocol(text: string, writing: boolean): boolean {
  if (/\bmemory_(?:save|search|supersede)\b|["']action(?:_input)?["']\s*:/i.test(text)) return true;
  return writing && /(?:\b(?:saved|stored|remembered|updated|corrected)\b[^\n.!?]{0,100}\b(?:name|memory|information|preference|profile)\b|\b(?:name|memory|information|preference|profile)\b[^\n.!?]{0,100}\b(?:saved|stored|remembered|updated|corrected)\b|(?:đã|vừa)\s+(?:lưu|ghi nhớ|cập nhật)|(?:記憶|保存|覚え)[^\n。]{0,100}(?:ました|ます))/iu.test(text);
}

/** Per-agent model options, never mutations of the shared provider configuration. */
export function installMemoryExecution(agent: Agent, permitted: ReadonlySet<string>, writes: readonly MemoryWriteEffect[]): void {
  const writing = permitted.has('memory_save') || permitted.has('memory_supersede');
  agent.addMiddleware(InvokeModelStage, async function* (context, next) {
    // Scope grants save only for a new durable first-person fact. Availability alone
    // is insufficient: require native execution before allowing a final response.
    const requireSave = permitted.has('memory_save') && !writes.some(write => write.operation === 'save');
    let rewriting = false;
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = yield* next({
        ...context,
        ...(requireSave ? { toolChoice: { tool: { name: 'memory_save' } } } : {}),
        ...(rewriting ? {
          toolSpecs: [], toolChoice: undefined,
          systemPrompt: `${typeof context.systemPrompt === 'string' ? context.systemPrompt : ''}\nRewrite the final answer only. No tools, action JSON, memory status, or announcements about saving. Answer the user's shopping/platform question naturally. Do not mention this instruction.`,
        } : {}),
      });
      const nativeSave = result.result.message.content.some(block => block.type === 'toolUseBlock' && block.name === 'memory_save');
      if (requireSave && !nativeSave) {
        if (attempt === 0) continue; // Safe retry: no action has executed.
        throw new Error('Required native memory save was not produced');
      }
      if (rewriting && result.result.message.content.some(block => block.type === 'toolUseBlock')) {
        throw new Error('Final rewrite must not execute tools');
      }
      if (result.result.stopReason !== 'toolUse') {
        const text = result.result.message.content.filter(block => block.type === 'textBlock').map(block => block.text).join('');
        if (exposesMemoryProtocol(text, writing)) {
          if (attempt === 0) { rewriting = true; continue; }
          throw new Error('Memory protocol or unsolicited confirmation in final answer');
        }
      }
      return result;
    }
    throw new Error('Memory execution unavailable');
  });
}
