import { isBudgetError } from './budget';

/** What LiteLLM says about one model response in its headers. */
export interface LiteLlmResponse {
  /** `x-litellm-response-cost`; LiteLLM may leave it out on streamed responses. */
  cost_usd?: number;
  /** The deployment's API host (`x-litellm-model-api-base`), else its id. */
  provider?: string;
  deployment_id?: string;
  /** `x-litellm-attempted-fallbacks`: other deployments tried before this one. */
  attempted_fallbacks: number;
}

type HeaderSource = { get(name: string): string | null };

function num(value: string | null): number | undefined {
  if (value === null || value.trim() === '') return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

export function readLiteLlmHeaders(headers: HeaderSource): LiteLlmResponse {
  const base = headers.get('x-litellm-model-api-base');
  let provider: string | undefined;
  if (base) { try { provider = new URL(base).host; } catch { provider = base.slice(0, 128); } }
  const deployment = headers.get('x-litellm-model-id') ?? undefined;
  return {
    cost_usd: num(headers.get('x-litellm-response-cost')),
    provider: provider ?? deployment,
    deployment_id: deployment,
    attempted_fallbacks: num(headers.get('x-litellm-attempted-fallbacks')) ?? 0,
  };
}

/**
 * How long a 429 asks to wait: LiteLLM names the reset moment in `reset_at`,
 * else `retry-after-ms` or `retry-after` (seconds or a date). Null when it says nothing.
 */
export function retryAfterMs(headers: HeaderSource, now = Date.now()): number | null {
  const resetAt = Date.parse(headers.get('reset_at') ?? '');
  if (!Number.isNaN(resetAt)) return Math.max(0, resetAt - now);
  const ms = num(headers.get('retry-after-ms'));
  if (ms !== undefined && ms > 0) return ms;
  const raw = headers.get('retry-after');
  if (raw === null) return null;
  const seconds = num(raw);
  if (seconds !== undefined) return Math.max(0, seconds * 1000);
  const at = Date.parse(raw);
  return Number.isNaN(at) ? null : Math.max(0, at - now);
}

/** A 429 body that means a spent budget or quota: waiting cannot clear it. */
const SPENT = /budget|quota|insufficient_quota|credit|billing|payment/i;

export interface LiteLlmFetchOptions {
  /** Told of every response's LiteLLM headers. */
  onResponse(info: LiteLlmResponse): void;
  /** Told when the run sits out a per-minute ceiling, with the moment it calls again. */
  onWait(until: Date): void;
  /** Ends a wait early (Stop now, the deadline). */
  signal?: AbortSignal;
  /** Waits one run sits out in all; then the 429 goes to the model client. */
  maxWaits?: number;
  /** The longest single wait. */
  maxWaitMs?: number;
}

const RESET_MARGIN_MS = 1000;

function sleep(ms: number, signals: Array<AbortSignal | undefined | null>): Promise<void> {
  return new Promise((resolve, reject) => {
    const live = signals.filter((s): s is AbortSignal => !!s);
    const done = () => { clearTimeout(timer); for (const s of live) s.removeEventListener('abort', abort); };
    const abort = () => { done(); reject(new Error('Rate-limit wait cancelled')); };
    const timer = setTimeout(() => { done(); resolve(); }, ms);
    for (const s of live) { if (s.aborted) { abort(); return; } s.addEventListener('abort', abort, { once: true }); }
  });
}

/**
 * The fetch the model client uses: reads LiteLLM's headers off each response
 * and sits out a per-minute ceiling (429 that is not a spent budget) before
 * sending the same request again, so the agent loop never sees a refusal that
 * was waited out. Waiting at the fetch boundary is the only place the status
 * and headers are still legible.
 */
export function liteLlmFetch(options: LiteLlmFetchOptions, base: typeof fetch = globalThis.fetch): typeof fetch {
  let waits = 0;
  const maxWaits = options.maxWaits ?? 3;
  const maxWaitMs = options.maxWaitMs ?? 90_000;
  return async (input, init) => {
    for (;;) {
      const response = await base(input, init);
      options.onResponse(readLiteLlmHeaders(response.headers));
      if (response.status !== 429 || waits >= maxWaits) return response;
      const body = await response.clone().text().catch(() => '');
      if (SPENT.test(body) || isBudgetError({ message: body })) return response;
      const wait = (retryAfterMs(response.headers) ?? 60_000) + RESET_MARGIN_MS;
      if (wait > maxWaitMs) return response;
      waits++;
      options.onWait(new Date(Date.now() + wait));
      await sleep(wait, [init?.signal, options.signal]);
    }
  };
}
