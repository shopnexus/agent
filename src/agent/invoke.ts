import type { Agent, AgentResult } from '@strands-agents/sdk';

/**
 * Agent.invoke with a time limit and a cancel signal. Either rejects at once
 * (the SDK is told to cancel too); "Turn deadline" is the time limit's reason.
 */
export function invokeWithTimeout(agent: Agent, args: Parameters<Agent['invoke']>[0], timeoutMs: number, options?: Parameters<Agent['invoke']>[1], cancelSignal?: AbortSignal): Promise<AgentResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('Turn deadline')), timeoutMs);
  const abort = () => controller.abort(cancelSignal?.reason);
  cancelSignal?.addEventListener('abort', abort, { once: true }); if (cancelSignal?.aborted) abort();
  return abortable(() => agent.invoke(args, { ...(options ?? {}), cancelSignal: controller.signal }), controller.signal)
    .finally(() => { clearTimeout(timer); cancelSignal?.removeEventListener('abort', abort); });
}

export async function abortable<T>(work: () => Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted(); let abort!: () => void;
  const cancelled = new Promise<never>((_, reject) => { abort = () => reject(signal.reason ?? new Error('Turn cancelled')); signal.addEventListener('abort', abort, { once: true }); });
  try { const result = await Promise.race([Promise.resolve().then(work), cancelled]); signal.throwIfAborted(); return result; }
  finally { signal.removeEventListener('abort', abort); }
}
