import { Logger, type Provider } from '@nestjs/common';
import { config } from '../config';
import { MemoryRunBus, RunBus } from './run-bus';
import { RedisRunBus } from './redis-run-bus';

/** Redis Streams with REDIS_URL; without it an in-process bus that only works with one replica. */
export const runBusProvider: Provider = {
  provide: RunBus,
  useFactory: () => {
    if (config.redis.url) return new RedisRunBus(config.redis.url);
    new Logger('RunBus').warn('REDIS_URL is empty: events and control stay in this process (one replica only)');
    return new MemoryRunBus();
  },
};
