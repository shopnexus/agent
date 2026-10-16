import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Pool } from 'pg';
import { config } from '../config';

@Injectable()
export class DbPool implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(DbPool.name);
  readonly pool: Pool;

  constructor() {
    this.pool = new Pool({
      connectionString: config.database.url,
      max: 10,
      idleTimeoutMillis: 30000,
    });
  }

  async onModuleInit() {
    try {
      const client = await this.pool.connect();
      try {
        await client.query(`
          CREATE SCHEMA IF NOT EXISTS retrieval;
          CREATE EXTENSION IF NOT EXISTS vector;
          CREATE EXTENSION IF NOT EXISTS pg_trgm;

          CREATE TABLE IF NOT EXISTS retrieval.user_memories (
              id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
              user_id VARCHAR(64) NOT NULL,
              role VARCHAR(16) NOT NULL DEFAULT 'buyer',
              category VARCHAR(32) NOT NULL,
              importance SMALLINT DEFAULT 3 CHECK (importance BETWEEN 1 AND 5),
              content TEXT NOT NULL,
              search_text TEXT NOT NULL,
              embedding vector(1536) NOT NULL,
              superseded_at TIMESTAMPTZ NULL,
              superseded_by UUID NULL REFERENCES retrieval.user_memories(id),
              created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
              updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          );

          CREATE INDEX IF NOT EXISTS idx_user_memories_lookup ON retrieval.user_memories(user_id, role, category, superseded_at);
        `);
        this.log.log('Connected to PostgreSQL; retrieval.user_memories verified.');
      } finally {
        client.release();
      }
    } catch (e) {
      this.log.warn(`PostgreSQL connection failed: ${(e as Error).message}. Ensure Postgres is running (docker compose up).`);
    }
  }

  async onModuleDestroy() {
    await this.pool.end();
  }
}
