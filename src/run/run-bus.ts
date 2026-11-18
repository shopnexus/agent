import { EventEmitter } from 'node:events';

/** One stream entry: its id and flat string fields. */
export interface BusEntry { id: string; fields: Record<string, string> }

/** A reader with its own connection, so a blocking read holds nobody else up. */
export interface BusReader {
  /** Entries after `afterId`, waiting up to `blockMs` for the first; [] on timeout. */
  read(key: string, afterId: string, blockMs: number, count?: number): Promise<BusEntry[]>;
  close(): Promise<void>;
}

/**
 * The run bus: append-only streams keyed by name (Redis Streams in production).
 * `turn:{id}` carries a turn's events to readers on any replica and
 * `turn:{id}:control` carries pause, stop and steer to the replica running it.
 */
export abstract class RunBus {
  /** XADD with an approximate MAXLEN; returns the entry id. */
  abstract add(key: string, fields: Record<string, string>, maxLen: number): Promise<string>;
  /** The newest entry id, or '0-0' when the stream is empty or gone. */
  abstract lastId(key: string): Promise<string>;
  abstract expire(key: string, seconds: number): Promise<void>;
  abstract persist(key: string): Promise<void>;
  abstract reader(): BusReader;
  async close(): Promise<void> {}
  async onModuleDestroy(): Promise<void> { await this.close(); }
}

export const EVENTS_MAXLEN = 2000;
export const CONTROL_MAXLEN = 200;
/** A stream key expires this long after its turn stops writing. */
export const STREAM_TTL_S = 3600;
export const eventsKey = (turnId: string) => `turn:${turnId}`;
export const controlKey = (turnId: string) => `turn:${turnId}:control`;

/** Compares Redis stream ids ("ms-seq"). */
export function compareIds(a: string, b: string): number {
  const [am, as] = a.split('-').map(Number);
  const [bm, bs] = b.split('-').map(Number);
  return am !== bm ? am - bm : (as ?? 0) - (bs ?? 0);
}

/**
 * The bus in one process: for tests and for a single replica without
 * REDIS_URL. Same semantics as the Redis bus except that expiry is ignored.
 */
export class MemoryRunBus extends RunBus {
  private readonly streams = new Map<string, BusEntry[]>();
  private readonly signal = new EventEmitter();
  private last = { ms: 0, seq: 0 };

  constructor() { super(); this.signal.setMaxListeners(0); }

  async add(key: string, fields: Record<string, string>, maxLen: number): Promise<string> {
    const now = Date.now();
    this.last = now > this.last.ms ? { ms: now, seq: 0 } : { ms: this.last.ms, seq: this.last.seq + 1 };
    const id = `${this.last.ms}-${this.last.seq}`;
    const entries = this.streams.get(key) ?? [];
    entries.push({ id, fields: { ...fields } });
    if (entries.length > maxLen) entries.splice(0, entries.length - maxLen);
    this.streams.set(key, entries);
    this.signal.emit(key);
    return id;
  }

  async lastId(key: string): Promise<string> {
    return this.streams.get(key)?.at(-1)?.id ?? '0-0';
  }

  async expire(): Promise<void> {}
  async persist(): Promise<void> {}

  /** Drops a stream, as an expired Redis key would be. */
  drop(key: string) { this.streams.delete(key); }

  reader(): BusReader {
    let closed = false;
    const wake = new Set<() => void>();
    return {
      read: async (key, afterId, blockMs, count = 100) => {
        const after = () => (this.streams.get(key) ?? []).filter(e => compareIds(e.id, afterId) > 0).slice(0, count);
        let found = after();
        if (found.length || blockMs <= 0 || closed) return found;
        await new Promise<void>(resolve => {
          const done = () => { clearTimeout(timer); this.signal.off(key, done); wake.delete(done); resolve(); };
          const timer = setTimeout(done, blockMs);
          this.signal.on(key, done);
          wake.add(done);
        });
        found = after();
        return found;
      },
      close: async () => { closed = true; for (const done of [...wake]) done(); },
    };
  }
}
