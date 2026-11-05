import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../db/prisma.service';
import { MemoryCategory, SearchHit, UserMemory } from './types';

@Injectable()
export class MemoryRepository {
  private readonly log = new Logger(MemoryRepository.name);

  constructor(private readonly prisma: PrismaService) {}

  async saveFact(params: {
    userId: string;
    category: MemoryCategory;
    factKey: string;
    content: string;
    importance?: number;
    embedding: number[];
    sourceTurnId?: string;
    expiresAt?: Date;
  }): Promise<UserMemory> {
    const { userId, category, factKey, content, importance = 3, embedding, sourceTurnId, expiresAt } = params;
    const searchText = content.normalize('NFC').trim();
    const vectorStr = `[${embedding.join(',')}]`;
    const rows = await this.prisma.$queryRaw<Array<any>>`
      INSERT INTO user_memories
        (actor_id, category, importance, content, search_text, embedding, source_turn_id, fact_key, expires_at)
      VALUES (${userId}, ${category}, ${importance}, ${content}, ${searchText}, ${vectorStr}::vector,
              ${sourceTurnId ?? null}::uuid, ${factKey}, ${expiresAt ?? null})
      RETURNING id, actor_id AS "userId", category, importance, content, search_text AS "searchText",
                superseded_at AS "supersededAt", superseded_by AS "supersededBy", deleted_at AS "deletedAt",
                expires_at AS "expiresAt", fact_key AS "factKey", created_at AS "createdAt", updated_at AS "updatedAt"
    `;
    this.log.log(`Saved user memory [${category}] for actor=${userId}`);
    return rows[0] as UserMemory;
  }

  /** Atomic replacement by stable fact key; unrelated facts in a category remain active. */
  async replaceFact(params: Parameters<MemoryRepository['saveFact']>[0]): Promise<UserMemory> {
    return this.prisma.$transaction(async (tx) => {
      const vector = `[${params.embedding.join(',')}]`;
      const saved = await tx.$queryRaw<Array<{ id: string }>>`
        INSERT INTO user_memories
          (actor_id, category, importance, content, search_text, embedding, source_turn_id, fact_key, expires_at)
        VALUES (${params.userId}, ${params.category}, ${params.importance ?? 3}, ${params.content},
                ${params.content.normalize('NFC').trim()}, ${vector}::vector, ${params.sourceTurnId ?? null}::uuid,
                ${params.factKey}, ${params.expiresAt ?? null}) RETURNING id
      `;
      await tx.$executeRaw`
        UPDATE user_memories SET superseded_at = NOW(), superseded_by = ${saved[0].id}::uuid, updated_at = NOW()
        WHERE actor_id = ${params.userId} AND fact_key = ${params.factKey}
          AND id <> ${saved[0].id}::uuid AND superseded_at IS NULL AND deleted_at IS NULL
      `;
      const rows = await tx.$queryRaw<Array<any>>`
        SELECT id, actor_id AS "userId", category, importance, content, search_text AS "searchText",
               superseded_at AS "supersededAt", superseded_by AS "supersededBy", deleted_at AS "deletedAt",
               expires_at AS "expiresAt", fact_key AS "factKey", created_at AS "createdAt", updated_at AS "updatedAt"
        FROM user_memories WHERE id = ${saved[0].id}::uuid
      `;
      return rows[0] as UserMemory;
    });
  }

  async searchFacts(params: { userId: string; query: string; queryEmbedding: number[]; limit?: number }): Promise<SearchHit[]> {
    const { userId, query, queryEmbedding, limit = 5 } = params;
    const vectorStr = `[${queryEmbedding.join(',')}]`;
    const normalizedQuery = query.normalize('NFC').trim();
    try {
      const rows = await this.prisma.$queryRaw<Array<any>>`
        WITH semantic AS (
          SELECT id, category, content, importance,
                 ROW_NUMBER() OVER (ORDER BY embedding <=> ${vectorStr}::vector) AS rank
          FROM user_memories WHERE actor_id = ${userId} AND superseded_at IS NULL AND deleted_at IS NULL
            AND (expires_at IS NULL OR expires_at > NOW())
          ORDER BY embedding <=> ${vectorStr}::vector LIMIT 20
        ), lexical AS (
          SELECT id, category, content, importance,
                 ROW_NUMBER() OVER (ORDER BY ts_rank_cd(to_tsvector('simple', search_text),
                   plainto_tsquery('simple', ${normalizedQuery})) DESC) AS rank
          FROM user_memories WHERE actor_id = ${userId} AND superseded_at IS NULL AND deleted_at IS NULL
            AND (expires_at IS NULL OR expires_at > NOW())
            AND to_tsvector('simple', search_text) @@ plainto_tsquery('simple', ${normalizedQuery})
          LIMIT 20
        )
        SELECT COALESCE(s.id, k.id) AS id, COALESCE(s.category, k.category) AS category,
               COALESCE(s.content, k.content) AS content, COALESCE(s.importance, k.importance) AS importance,
               (COALESCE(1.0 / (60 + s.rank), 0.0) + COALESCE(1.0 / (60 + k.rank), 0.0)) AS score
        FROM semantic s FULL OUTER JOIN lexical k ON s.id = k.id
        ORDER BY score DESC LIMIT ${Math.max(1, Math.min(limit, 20))}
      `;
      return rows.map((r) => ({ id: r.id, category: r.category as MemoryCategory, content: r.content,
        importance: r.importance, score: Number(r.score) }));
    } catch (e) {
      this.log.warn(`Memory search failed (${e instanceof Error ? e.name : 'unknown error'})`);
      return [];
    }
  }

  async listFacts(userId: string): Promise<UserMemory[]> {
    const rows = await this.prisma.$queryRaw<Array<any>>`
      SELECT id, actor_id AS "userId", category, importance, content, search_text AS "searchText",
        superseded_at AS "supersededAt", superseded_by AS "supersededBy", deleted_at AS "deletedAt",
        expires_at AS "expiresAt", fact_key AS "factKey", created_at AS "createdAt", updated_at AS "updatedAt"
      FROM user_memories WHERE actor_id = ${userId} AND superseded_at IS NULL AND deleted_at IS NULL
        AND (expires_at IS NULL OR expires_at > NOW()) ORDER BY importance DESC, created_at DESC LIMIT 100
    `;
    return rows as UserMemory[];
  }

  async updateFact(userId: string, id: string, content: string, embedding: number[]): Promise<boolean> {
    const result = await this.prisma.$executeRaw`
      UPDATE user_memories SET content = ${content}, search_text = ${content.normalize('NFC').trim()},
        embedding = ${`[${embedding.join(',')}]`}::vector, updated_at = NOW()
      WHERE id = ${id}::uuid AND actor_id = ${userId} AND deleted_at IS NULL AND superseded_at IS NULL
        AND (expires_at IS NULL OR expires_at > NOW())
    `;
    return result > 0;
  }

  async forgetFact(userId: string, id: string): Promise<boolean> {
    const result = await this.prisma.$executeRaw`
      UPDATE user_memories SET deleted_at = NOW(), updated_at = NOW()
      WHERE id = ${id}::uuid AND actor_id = ${userId} AND deleted_at IS NULL
    `;
    return result > 0;
  }

  async forgetAll(userId: string): Promise<number> {
    return this.prisma.$executeRaw`
      UPDATE user_memories SET deleted_at = NOW(), updated_at = NOW()
      WHERE actor_id = ${userId} AND deleted_at IS NULL
    `;
  }
}
