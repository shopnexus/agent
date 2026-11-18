import { isBudgetError } from './budget';

/** What LiteLLM says about one model response in its headers. */
export interface LiteLlmResponse {
  /** `x-litellm-response-cost`; LiteLLM leaves it out on streamed responses, whose cost comes with their usage. */
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

/** A streamed response's token counts, and its cost when LiteLLM adds it (include_cost_in_streaming_usage). */
export interface StreamUsage {
  input_tokens: number;
  output_tokens: number;
  cost_usd?: number;
}

/** The usage on one SSE line of a chat completion stream, or undefined when it carries none. */
export function streamUsageOf(line: string): StreamUsage | undefined {
  if (!line.startsWith('data:') || !line.includes('"usage"')) return undefined;
  try {
    const usage = JSON.parse(line.slice(5)).usage;
    if (!usage || typeof usage !== 'object') return undefined;
    return {
      input_tokens: Number(usage.prompt_tokens) || 0,
      output_tokens: Number(usage.completion_tokens) || 0,
      cost_usd: typeof usage.cost === 'number' && Number.isFinite(usage.cost) ? usage.cost : undefined,
    };
  } catch {
    return undefined;
  }
}

/**
 * Passes a streamed body through unchanged and reports the usage it carries.
 * LiteLLM sends the usage on a chunk that still has a choice, and the model
 * client reads usage only from a chunk without choices, so it never sees it.
 */
function tapUsage(response: Response, onUsage: (usage: StreamUsage) => void): Response {
  if (!response.ok || !response.body || !(response.headers.get('content-type') ?? '').includes('text/event-stream')) return response;
  const decoder = new TextDecoder();
  let rest = '';
  const read = (line: string) => { const usage = streamUsageOf(line.trim()); if (usage) onUsage(usage); };
  const body = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, out) {
      out.enqueue(chunk);
      rest += decoder.decode(chunk, { stream: true });
      const lines = rest.split('\n');
      rest = lines.pop() ?? '';
      lines.forEach(read);
    },
    flush() { read(rest + decoder.decode()); },
  }));
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
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
  /** Told of a streamed response's usage as it passes. */
  onUsage?(usage: StreamUsage): void;
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
 * The fetch the model client uses: reads LiteLLM's headers off each response,
 * and the usage off a streamed one, and sits out a per-minute ceiling (429 that is not a spent budget) before
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
      if (response.status !== 429 || waits >= maxWaits) return options.onUsage ? tapUsage(response, options.onUsage) : response;
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
