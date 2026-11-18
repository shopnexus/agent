
import { Model } from '@strands-agents/sdk';

interface StepOptions { delayMs?: number; usage?: { input: number; output: number }; reasoning?: string }

/** One model reply: tool calls, a final text, an error the provider throws, or no reply at all. */
export type ScriptStep =
  | ({ tools: Array<{ name: string; input?: Record<string, unknown>; id?: string }> } & StepOptions)
  | ({ text: string } & StepOptions)
  | { error: unknown }
  | { hang: true };

/**
 * An offline model that replays a script, one step per model call; after the
 * script it answers 'scripted final answer'. `calls` counts model calls,
 * `systemPrompts` keeps the system prompt each call received and `messages`
 * the messages each call was sent. `beforeEach` runs at the start of each call
 * (tests use it to drive the model's fetch).
 */
export function scriptedModel(steps: ScriptStep[], beforeEach?: () => Promise<void>) {
  let cycle = 0;
  return new class extends Model {
    calls = 0;
    systemPrompts: unknown[] = [];
    messages: unknown[][] = [];
    updateConfig() {}
    getConfig() { return { modelId: 'scripted' }; }
    async *stream(messages?: unknown, options?: { systemPrompt?: unknown }): AsyncGenerator<any> {
      this.calls++;
      this.systemPrompts.push(options?.systemPrompt);
      this.messages.push(JSON.parse(JSON.stringify(messages ?? [])));
      await beforeEach?.();
      const step = steps[cycle++] ?? { text: 'scripted final answer' };
      if ('error' in step) throw step.error;
      if ('hang' in step) await new Promise(() => {});
      const opts = step as StepOptions;
      if (opts.delayMs) await new Promise(r => setTimeout(r, opts.delayMs));
      yield { type: 'modelMessageStartEvent', role: 'assistant' };
      if (opts.reasoning) {
        yield { type: 'modelContentBlockStartEvent' };
        yield { type: 'modelContentBlockDeltaEvent', delta: { type: 'reasoningContentDelta', text: opts.reasoning } };
        yield { type: 'modelContentBlockStopEvent' };
      }
      const usage = { type: 'modelMetadataEvent', usage: { inputTokens: opts.usage?.input ?? 100, outputTokens: opts.usage?.output ?? 20, totalTokens: (opts.usage?.input ?? 100) + (opts.usage?.output ?? 20) } };
      if ('tools' in step) {
        for (const [index, call] of step.tools.entries()) {
          yield { type: 'modelContentBlockStartEvent', start: { type: 'toolUseStart', name: call.name, toolUseId: call.id ?? `call-${cycle}-${index}` } };
          yield { type: 'modelContentBlockDeltaEvent', delta: { type: 'toolUseInputDelta', input: JSON.stringify(call.input ?? {}) } };
          yield { type: 'modelContentBlockStopEvent' };
        }
        yield usage;
        yield { type: 'modelMessageStopEvent', stopReason: 'toolUse' };
        return;
      }
      yield { type: 'modelContentBlockStartEvent' };
      yield { type: 'modelContentBlockDeltaEvent', delta: { type: 'textDelta', text: 'text' in step ? step.text : '' } };
      yield { type: 'modelContentBlockStopEvent' };
      yield usage;
      yield { type: 'modelMessageStopEvent', stopReason: 'endTurn' };
    }
  }();
}

/** One call to `name`, then a final text. */
export function syntheticModel(name?: string, input: Record<string, unknown> = {}, toolUseId = 'synthetic-call') {
  return scriptedModel(name ? [{ tools: [{ name, input, id: toolUseId }] }, { text: 'synthetic final answer' }] : [{ text: 'synthetic final answer' }]);
}
