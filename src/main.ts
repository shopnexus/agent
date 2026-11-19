import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { config } from './config';

/** A resume request carries the run state back, so the body limit is well above the default 100 kB. */
export const BODY_LIMIT = '16mb';

async function bootstrap() {
  // Internal service: server is the only caller, so no CORS.
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bodyParser: false });
  app.useBodyParser('json', { limit: BODY_LIMIT });
  app.enableShutdownHooks();
  await app.listen(config.port);
  new Logger('Bootstrap').log(`agent up on port ${config.port}: POST /runs`);
}
if (require.main === module) bootstrap();
