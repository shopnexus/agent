import { Injectable, Logger } from '@nestjs/common';
import { config } from '../config';
import { errorDetails } from '../observability/error-details';

/** One input the server queued for a running segment. */
export type ControlItem =
  | { seq: number; kind: 'pause' }
  | { seq: number; kind: 'stop' }
  | { seq: number; kind: 'steer'; steer_id: string; text: string };

export interface ControlHandlers {
  onItem(item: ControlItem): void;
  /** The server no longer runs the turn (deleted, swept or ended). */
  onGone(): void;
}

export interface ControlWatch { stop(): Promise<void> }

/** The known items, the newest seq among all of them, and whether the turn still runs. */
function parseAnswer(value: unknown): { items: ControlItem[]; last: number; running: boolean } | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const { items, running } = value as { items?: unknown; running?: unknown };
  if (!Array.isArray(items) || typeof running !== 'boolean') return undefined;
  const out: ControlItem[] = [];
  let last = 0;
  for (const raw of items as Array<Record<string, unknown>>) {
    const seq = raw?.seq;
    if (typeof seq !== 'number' || !Number.isInteger(seq)) continue;
    last = Math.max(last, seq);
    if (raw.kind === 'pause' || raw.kind === 'stop') out.push({ seq, kind: raw.kind });
    else if (raw.kind === 'steer' && typeof raw.steer_id === 'string' && typeof raw.text === 'string') out.push({ seq, kind: 'steer', steer_id: raw.steer_id, text: raw.text });
  }
  return { items: out, last, running };
}

/**
 * Polls the server for a running segment's pause, stop and steer:
 * `GET {origin of MCP_SERVER_URL}/agent/turns/{id}/control?after=<seq>` with
 * AGENT_MCP_TOKEN, about every second. A failed poll is retried on the next tick.
 */
@Injectable()
export class ControlPoller {
  private readonly log = new Logger(ControlPoller.name);
  /** Time between polls; tests shorten it. */
  intervalMs = 1000;
  /** A poll that takes longer is dropped and retried. */
  requestTimeoutMs = 5000;

  /** The control URL base, or '' when MCP_SERVER_URL is not set. */
  protected origin(): string {
    try { return config.mcp.url ? new URL(config.mcp.url).origin : ''; } catch { return ''; }
  }

  watch(turnId: string, after: number, handlers: ControlHandlers): ControlWatch {
    const origin = this.origin();
    const token = config.console.mcp_token;
    let stopped = false;
    let cursor = after;
    let failures = 0;
    let inflight: AbortController | undefined;
    let wake: (() => void) | undefined;

    const poll = async () => {
      inflight = new AbortController();
      const timer = setTimeout(() => inflight?.abort(), this.requestTimeoutMs);
      try {
        const res = await fetch(`${origin}/agent/turns/${encodeURIComponent(turnId)}/control?after=${cursor}`, {
          headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }, signal: inflight.signal });
        if (!res.ok) throw new Error(`control poll answered ${res.status}`);
        const answer = parseAnswer(await res.json());
        if (!answer) throw new Error('control poll answer is malformed');
        failures = 0;
        cursor = Math.max(cursor, answer.last);
        for (const item of answer.items) {
          if (stopped) return;
          handlers.onItem(item);
        }
        if (!answer.running && !stopped) { stopped = true; handlers.onGone(); }
      } catch (error) {
        if (stopped) return;
        // One warning per outage, not one a second.
        if (failures++ === 0) this.log.warn(JSON.stringify({ event: 'turn_control_poll_failed', turn_id: turnId, ...errorDetails(error) }));
      } finally {
        clearTimeout(timer);
        inflight = undefined;
      }
    };

    const loop = (async () => {
      if (!origin) return;
      while (!stopped) {
        await poll();
        if (stopped) break;
        await new Promise<void>(resolve => { const t = setTimeout(resolve, this.intervalMs); wake = () => { clearTimeout(t); resolve(); }; });
        wake = undefined;
      }
    })();

    return { stop: async () => { stopped = true; inflight?.abort(); wake?.(); await loop; } };
  }
}
