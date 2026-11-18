import Redis from 'ioredis';
import { BusEntry, BusReader, RunBus } from './run-bus';

function entries(reply: Array<[string, string[]]> | null | undefined): BusEntry[] {
  return (reply ?? []).map(([id, flat]) => {
    const fields: Record<string, string> = {};
    for (let i = 0; i + 1 < flat.length; i += 2) fields[flat[i]] = flat[i + 1];
    return { id, fields };
  });
}

/** The run bus on Redis Streams. Each reader gets its own connection for XREAD BLOCK. */
export class RedisRunBus extends RunBus {
  private readonly client: Redis;

  constructor(private readonly url: string) {
    super();
    this.client = new Redis(url, { maxRetriesPerRequest: 2, enableOfflineQueue: true, lazyConnect: false });
    this.client.on('error', () => { /* reconnects; callers see command errors */ });
  }

  async add(key: string, fields: Record<string, string>, maxLen: number): Promise<string> {
    const flat = Object.entries(fields).flat();
    return (await this.client.xadd(key, 'MAXLEN', '~', String(maxLen), '*', ...flat)) as string;
  }

  async lastId(key: string): Promise<string> {
    const reply = await this.client.xrevrange(key, '+', '-', 'COUNT', 1);
    return reply[0]?.[0] ?? '0-0';
  }

  async expire(key: string, seconds: number): Promise<void> { await this.client.expire(key, seconds); }
  async persist(key: string): Promise<void> { await this.client.persist(key); }

  reader(): BusReader {
    const connection = new Redis(this.url, { maxRetriesPerRequest: 2, lazyConnect: false });
    connection.on('error', () => { /* reconnects */ });
    return {
      read: async (key, afterId, blockMs, count = 100) => {
        const reply = blockMs > 0
          ? await connection.xread('COUNT', count, 'BLOCK', blockMs, 'STREAMS', key, afterId)
          : await connection.xread('COUNT', count, 'STREAMS', key, afterId);
        return entries(reply?.[0]?.[1] as Array<[string, string[]]> | undefined);
      },
      close: async () => { connection.disconnect(); },
    };
  }

  async close(): Promise<void> { this.client.disconnect(); }
}
