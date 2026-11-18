import { Injectable, Logger } from '@nestjs/common';
import { TurnEventStore } from '../db/turn-event.repository';
import { errorDetails } from '../observability/error-details';
import { eventsKey, RunBus } from './run-bus';
import { STOP_EVENTS, type TurnEvent, type TurnEventType } from './events';

/** Reads a turn's status for the stream: is anyone still writing? */
export abstract class TurnStatusReader {
  abstract statusOf(turnId: string): Promise<string | null>;
}

export interface StreamOptions {
  /** How long one blocking read waits before a keep-alive and a PostgreSQL check. */
  blockMs?: number;
  /** How long a turn that is not RUNNING may stay silent before the stream closes. */
  idleCloseMs?: number;
  /** Called on each keep-alive. */
  onIdle?: () => void;
}

const PAGE = 500;

/**
 * A turn's events for one reader: replay from PostgreSQL after `afterSeq`,
 * then follow the Redis stream. The reader may be on any replica. Redis
 * entries are matched by seq: duplicates are skipped and a gap (trimmed or
 * lost entries) is filled from PostgreSQL. The stream ends after an event that
 * stops the run (turn.finished, turn.paused, clarify), or when the reader goes.
 */
@Injectable()
export class TurnStreamService {
  private readonly log = new Logger(TurnStreamService.name);

  constructor(private readonly store: TurnEventStore, private readonly bus: RunBus, private readonly turns: TurnStatusReader) {}

  async stream(turnId: string, afterSeq: number, send: (event: TurnEvent) => void, signal: AbortSignal, options: StreamOptions = {}): Promise<void> {
    const blockMs = options.blockMs ?? 15_000;
    const idleCloseMs = options.idleCloseMs ?? 10_000;
    const key = eventsKey(turnId);
    let last = Math.max(0, afterSeq);
    let lastType: string | undefined;
    const deliver = (events: TurnEvent[]) => {
      for (const e of events) {
        if (e.seq <= last) continue;
        send(e); last = e.seq; lastType = e.type;
      }
    };
    const fromStore = async (until?: number) => {
      for (;;) {
        const batch = await this.store.after(turnId, last, PAGE, until);
        deliver(batch);
        if (batch.length < PAGE) return;
      }
    };

    // Note the stream's position before the replay: whatever was added after it
    // is read from Redis, whatever before it is already in PostgreSQL.
    let cursor = await this.bus.lastId(key).catch(() => '0-0');
    await fromStore();
    if (lastType === undefined && last > 0) lastType = (await this.store.after(turnId, last - 1, 1))[0]?.type;
    if (lastType && STOP_EVENTS.has(lastType) && (await this.turns.statusOf(turnId)) !== 'RUNNING') return;

    const reader = this.bus.reader();
    const abort = () => { void reader.close(); };
    signal.addEventListener('abort', abort, { once: true });
    let idleSince: number | undefined;
    try {
      while (!signal.aborted) {
        let entries: Awaited<ReturnType<typeof reader.read>> = [];
        let busDown = false;
        try { entries = await reader.read(key, cursor, blockMs, PAGE); }
        catch (error) {
          if (signal.aborted) break;
          busDown = true;
          this.log.warn(JSON.stringify({ event: 'turn_stream_bus_failed', turn_id: turnId, ...errorDetails(error) }));
        }
        if (signal.aborted) break;
        if (!entries.length) {
          // A keep-alive, and PostgreSQL in case Redis lost or never got the events.
          options.onIdle?.();
          const before = last;
          await fromStore();
          if (lastType && STOP_EVENTS.has(lastType)) return;
          if (last === before && (await this.turns.statusOf(turnId)) !== 'RUNNING') {
            idleSince ??= Date.now();
            if (Date.now() - idleSince >= idleCloseMs) return;
          } else idleSince = undefined;
          if (busDown) await new Promise(r => setTimeout(r, Math.min(1000, blockMs)));
          continue;
        }
        idleSince = undefined;
        for (const entry of entries) {
          cursor = entry.id;
          const seq = Number(entry.fields.seq);
          if (!Number.isFinite(seq) || seq <= last) continue;
          if (seq > last + 1) await fromStore(seq - 1);
          let body: Record<string, unknown> = {};
          try { body = JSON.parse(entry.fields.body ?? '{}'); } catch { /* malformed entry: deliver the bare event */ }
          deliver([{ seq, type: entry.fields.type as TurnEventType, at: entry.fields.at, body }]);
        }
        if (lastType && STOP_EVENTS.has(lastType)) return;
      }
    } finally {
      signal.removeEventListener('abort', abort);
      await reader.close();
    }
  }
}

/** One event as a server-sent event: `id` is the seq, `data` is `{seq, type, at, ...body}`. */
export function sseFrame(event: TurnEvent): string {
  const data = JSON.stringify({ seq: event.seq, type: event.type, at: event.at, ...event.body });
  return `id: ${event.seq}\nevent: ${event.type}\ndata: ${data}\n\n`;
}
