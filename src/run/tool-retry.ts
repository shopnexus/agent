import { Tool, type ToolContext, type ToolStreamGenerator } from '@strands-agents/sdk';

export class ToolTimeoutError extends Error {
  constructor(readonly timeoutMs: number) { super(`Tool timed out after ${Math.round(timeoutMs / 1000)} s`); this.name = 'ToolTimeoutError'; }
}

/** When a tool's last attempt ran, by tool use id. */
export class ToolClock {
  private readonly runs = new Map<string, { started: number; ended?: number }>();
  start(id: string) { this.runs.set(id, { started: Date.now() }); }
  end(id: string) { const r = this.runs.get(id); if (r) r.ended = Date.now(); }
  get(id: string) { return this.runs.get(id); }
}

/**
 * A tool with a time limit per attempt. The wrapped call is abandoned at the
 * limit; a server-side MCP call already running is not stopped by it.
 */
export class TimedTool extends Tool {
  readonly name: string;
  readonly description: string;
  readonly toolSpec: Tool['toolSpec'];

  constructor(private readonly inner: Tool, private readonly timeoutMs: number, private readonly clock: ToolClock) {
    super();
    this.name = inner.name;
    this.description = inner.description;
    this.toolSpec = inner.toolSpec;
  }

  async *stream(context: ToolContext): ToolStreamGenerator {
    const id = context.toolUse.toolUseId;
    this.clock.start(id);
    const generator = this.inner.stream(context);
    const deadline = Date.now() + this.timeoutMs;
    let timer: NodeJS.Timeout | undefined;
    try {
      for (;;) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new ToolTimeoutError(this.timeoutMs);
        const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new ToolTimeoutError(this.timeoutMs)), remaining); });
        const next = await Promise.race([generator.next(), timeout]);
        clearTimeout(timer);
        if (next.done) return next.value;
        yield next.value;
      }
    } catch (error) {
      if (error instanceof ToolTimeoutError) void generator.return(undefined as never).catch(() => {});
      throw error;
    } finally {
      clearTimeout(timer);
      this.clock.end(id);
    }
  }
}

const TRANSIENT = /timed out|timeout|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|socket hang up|fetch failed|network|\b50[234]\b|unavailable|temporar/i;

/** A failure worth another attempt: a timeout or a dropped or refused connection. */
export function isTransientToolError(text: string): boolean {
  return TRANSIENT.test(text);
}

/** Wait before attempt n+1 (n starts at 1): 500 ms, 1 s, 2 s, at most 4 s. */
export function retryDelayMs(attempt: number): number {
  return Math.min(4000, 500 * 2 ** (attempt - 1));
}
