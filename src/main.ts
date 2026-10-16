import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { AppModule } from './app.module';
import { config } from './config';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.enableCors();
  await app.listen(config.port);
  new Logger('Bootstrap').log(
    `agent up on http://localhost:${config.port} (region=${config.aws_region}) — POST /chat, /sessions`,
  );
}
bootstrap();
