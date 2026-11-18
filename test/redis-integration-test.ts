/** Opt-in: the cross-replica stream checks on a real Redis, two connections as two replicas. Skips without REDIS_URL. */
import { Logger } from '@nestjs/common';
import { RedisRunBus } from '../src/run/redis-run-bus';
import { crossReplica } from './stream-test';

async function main() {
  const url = process.env.REDIS_URL;
  if (!url) { console.log('SKIP Redis integration: REDIS_URL is not set'); return; }
  Logger.overrideLogger(['fatal']);
  const a = new RedisRunBus(url), b = new RedisRunBus(url);
  try {
    await crossReplica(a, b, 'redis');
    console.log('Redis integration passed (replay then follow, pause and continue across two replicas)');
  } finally {
    await a.close(); await b.close();
  }
}
main().catch(e => { console.error(e); process.exitCode = 1; });
