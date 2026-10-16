import { Injectable, Logger } from '@nestjs/common';
import { DbPool } from '../db/db.pool';
import { MemoryCategory, SearchHit, UserMemory, UserRole } from './types';

@Injectable()
export class MemoryRepository {
  private readonly log = new Logger(MemoryRepository.name);

  constructor(private readonly db: DbPool) {}

  /**
   * Save a new fact or preference.
   */
  async saveFact(params: {
    userId: string;
    role: UserRole;
    category: MemoryCategory;
    content: string;
    importance?: number;
    embedding: number[];
  }): Promise<UserMemory> {
    const { userId, role, category, content, importance = 3, embedding } = params;
    const searchText = content.normalize('NFC').trim();
    const vectorStr = `[${embedding.join(',')}]`;

    const res = await this.db.pool.query(
      `
      INSERT INTO retrieval.user_memories (
        user_id, role, category, importance, content, search_text, embedding
      ) VALUES ($1, $2, $3, $4, $5, $6, $7::vector)
      RETURNING id, user_id as "userId", role, category, importance, content,
                search_text as "searchText", superseded_at as "supersededAt",
                superseded_by as "supersededBy", created_at as "createdAt", updated_at as "updatedAt"
      `,
      [userId, role, category, importance, content, searchText, vectorStr],
    );

    const record = res.rows[0];
    this.log.log(`Saved fact for ${role} (${userId}) in category "${category}": ${content.slice(0, 50)}...`);
    return record;
  }

  /**
   * Mark an old fact as superseded by a newer one.
   */
  async supersede(oldId: string, newId?: string): Promise<void> {
    await this.db.pool.query(
      `
      UPDATE retrieval.user_memories
      SET superseded_at = NOW(), superseded_by = $2, updated_at = NOW()
      WHERE id = $1 AND superseded_at IS NULL
      `,
      [oldId, newId ?? null],
    );
  }

  /**
   * Hybrid retrieval combining Vector Cosine Distance + PostgreSQL Full-Text Search
   * with Reciprocal Rank Fusion (RRF).
   */
  async searchFacts(params: {
    userId: string;
    role: UserRole;
    query: string;
    queryEmbedding: number[];
    limit?: number;
  }): Promise<SearchHit[]> {
    const { userId, role, query, queryEmbedding, limit = 5 } = params;
    const vectorStr = `[${queryEmbedding.join(',')}]`;
    const normalizedQuery = query.normalize('NFC').trim();

    try {
      const res = await this.db.pool.query(
        `
        WITH semantic_search AS (
          SELECT id, category, content, importance,
                 ROW_NUMBER() OVER (ORDER BY embedding <=> $3::vector) as rank
          FROM retrieval.user_memories
          WHERE user_id = $1 AND role = $2 AND superseded_at IS NULL
          ORDER BY embedding <=> $3::vector
          LIMIT 20
        ),
        keyword_search AS (
          SELECT id, category, content, importance,
                 ROW_NUMBER() OVER (
                   ORDER BY ts_rank_cd(to_tsvector('simple', search_text), plainto_tsquery('simple', $4)) DESC
                 ) as rank
          FROM retrieval.user_memories
          WHERE user_id = $1 AND role = $2 AND superseded_at IS NULL
            AND to_tsvector('simple', search_text) @@ plainto_tsquery('simple', $4)
          LIMIT 20
        )
        SELECT COALESCE(s.id, k.id) as id,
               COALESCE(s.category, k.category) as category,
               COALESCE(s.content, k.content) as content,
               COALESCE(s.importance, k.importance) as importance,
               (COALESCE(1.0 / (60 + s.rank), 0.0) + COALESCE(1.0 / (60 + k.rank), 0.0)) as score
        FROM semantic_search s
        FULL OUTER JOIN keyword_search k ON s.id = k.id
        ORDER BY score DESC
        LIMIT $5;
        `,
        [userId, role, vectorStr, normalizedQuery, limit],
      );

      return res.rows.map((r) => ({
        id: r.id,
        category: r.category as MemoryCategory,
        content: r.content,
        importance: r.importance,
        score: parseFloat(r.score),
      }));
    } catch (e) {
      this.log.warn(`searchFacts failed: ${(e as Error).message}`);
      return [];
    }
  }

  /**
   * Retrieve top active facts for auto-injecting into the Agent system prompt.
   */
  async getTopFacts(userId: string, role: UserRole, limit = 10): Promise<UserMemory[]> {
    try {
      const res = await this.db.pool.query(
        `
        SELECT id, user_id as "userId", role, category, importance, content,
               search_text as "searchText", superseded_at as "supersededAt",
               superseded_by as "supersededBy", created_at as "createdAt", updated_at as "updatedAt"
        FROM retrieval.user_memories
        WHERE user_id = $1 AND role = $2 AND superseded_at IS NULL
        ORDER BY importance DESC, created_at DESC
        LIMIT $3
        `,
        [userId, role, limit],
      );

      return res.rows;
    } catch (e) {
      this.log.warn(`getTopFacts failed: ${(e as Error).message}`);
      return [];
    }
  }

  /**
   * Find candidate facts in the same category that might conflict/supersede.
   */
  async findCategoryCandidates(userId: string, role: UserRole, category: MemoryCategory): Promise<UserMemory[]> {
    try {
      const res = await this.db.pool.query(
        `
        SELECT id, user_id as "userId", role, category, importance, content,
               search_text as "searchText", superseded_at as "supersededAt",
               superseded_by as "supersededBy", created_at as "createdAt", updated_at as "updatedAt"
        FROM retrieval.user_memories
        WHERE user_id = $1 AND role = $2 AND category = $3 AND superseded_at IS NULL
        ORDER BY created_at DESC
        LIMIT 5
        `,
        [userId, role, category],
      );
      return res.rows;
    } catch {
      return [];
    }
  }
}
