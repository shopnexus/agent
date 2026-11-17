import { Model } from '@strands-agents/sdk';

/** One model reply: tool calls, a final text, an error the provider throws, or no reply at all. */
export type ScriptStep =
  | { tools: Array<{ name: string; input?: Record<string, unknown>; id?: string }> }
  | { text: string }
  | { error: unknown }
  | { hang: true };

/**
 * An offline model that replays a script, one step per model call; after the
 * script it answers 'scripted final answer'. `calls` counts model calls and
 * `systemPrompts` keeps the system prompt each call received.
 */
export function scriptedModel(steps: ScriptStep[]) {
  let cycle = 0;
  return new class extends Model {
    calls = 0;
    systemPrompts: unknown[] = [];
    updateConfig() {}
    getConfig() { return { modelId: 'scripted' }; }
    async *stream(_messages?: unknown, options?: { systemPrompt?: unknown }): AsyncGenerator<any> {
      this.calls++;
      this.systemPrompts.push(options?.systemPrompt);
      const step = steps[cycle++] ?? { text: 'scripted final answer' };
      if ('error' in step) throw step.error;
      if ('hang' in step) await new Promise(() => {});
      yield { type: 'modelMessageStartEvent', role: 'assistant' };
      if ('tools' in step) {
        for (const [index, call] of step.tools.entries()) {
          yield { type: 'modelContentBlockStartEvent', start: { type: 'toolUseStart', name: call.name, toolUseId: call.id ?? `call-${cycle}-${index}` } };
          yield { type: 'modelContentBlockDeltaEvent', delta: { type: 'toolUseInputDelta', input: JSON.stringify(call.input ?? {}) } };
          yield { type: 'modelContentBlockStopEvent' };
        }
        yield { type: 'modelMessageStopEvent', stopReason: 'toolUse' };
        return;
      }
      yield { type: 'modelContentBlockStartEvent' };
      yield { type: 'modelContentBlockDeltaEvent', delta: { type: 'textDelta', text: 'text' in step ? step.text : '' } };
      yield { type: 'modelContentBlockStopEvent' };
      yield { type: 'modelMessageStopEvent', stopReason: 'endTurn' };
    }
  }();
}

/** One call to `name`, then a final text. */
export function syntheticModel(name?: string, input: Record<string, unknown> = {}, toolUseId = 'synthetic-call') {
  return scriptedModel(name ? [{ tools: [{ name, input, id: toolUseId }] }, { text: 'synthetic final answer' }] : [{ text: 'synthetic final answer' }]);
}
