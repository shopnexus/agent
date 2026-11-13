import { Injectable, OnModuleInit, OnModuleDestroy, Logger } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { config } from '../config';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(PrismaService.name);

  constructor() {
    super({
      datasourceUrl: config.database.url,
    });
  }

  async onModuleInit() {
    try {
      await this.$connect();
      // Ensure PostgreSQL extensions exist. Prisma raw execute accepts one statement per call.
      await this.$executeRawUnsafe('CREATE EXTENSION IF NOT EXISTS vector');
      await this.$executeRawUnsafe('CREATE EXTENSION IF NOT EXISTS pg_trgm');
      this.log.log('Prisma connected to PostgreSQL and verified extensions.');
    } catch (e) {
      this.log.warn(`Prisma connection failed: ${(e as Error).message}. Ensure Postgres is running.`);
    }
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}
