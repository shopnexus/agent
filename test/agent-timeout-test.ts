import assert from 'node:assert/strict';
import { Agent } from '@strands-agents/sdk';
import { invokeWithTimeout } from '../src/agent/agent.service';

async function main(): Promise<void> {
  let observedSignal: AbortSignal | undefined;
  const neverResolves = {
    invoke: (_text: string, options?: { cancelSignal?: AbortSignal }) => {
      observedSignal = options?.cancelSignal;
      return new Promise<never>(() => {});
    },
  } as unknown as Agent;

  await assert.rejects(
    invokeWithTimeout(neverResolves, 'test', 10),
    /Yêu cầu hết thời gian/,
  );
  assert.ok(observedSignal, 'passes a cancellation signal to Agent.invoke');
  assert.equal(observedSignal.aborted, true, 'aborts the SDK invocation on timeout');

  let completedSignal: AbortSignal | undefined;
  const quickAgent = {
    invoke: async (_text: string, options?: { cancelSignal?: AbortSignal }) => {
      completedSignal = options?.cancelSignal;
      return { stopReason: 'endTurn' };
    },
  } as unknown as Agent;
  await invokeWithTimeout(quickAgent, 'test', 10);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(completedSignal?.aborted, false, 'clears the deadline after successful completion');

  console.log('Agent timeout cancellation tests passed');
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
