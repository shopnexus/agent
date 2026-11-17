import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { AppModule } from './app.module';
import { config } from './config';

async function bootstrap() {
  // Internal service: server2 is the only caller, so no CORS.
  const app = await NestFactory.create(AppModule);
  app.enableShutdownHooks();
  await app.listen(config.port);
  new Logger('Bootstrap').log(`agent up on port ${config.port}: /conversations`);
}
bootstrap();
