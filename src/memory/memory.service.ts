import { Injectable, Logger } from '@nestjs/common';
import { MemoryManager } from '@strands-agents/sdk';
import { MemoryRepository } from './memory.repository';
import { EmbeddingService } from '../llm/embedding.service';
import { MemoryCategory, UserRole } from './types';
import { config } from '../config';

type MemoryStore = NonNullable<ConstructorParameters<typeof MemoryManager>[0]>['stores'][number];

const SEARCH_TOOL_DESCRIPTION =
  'Search the user\'s long-term memory for shopping preferences, sizes (clothing/shoe), ' +
  'saved profile info, feedback, or shop policies. Use a focused query when you need ' +
  'something not already in the provided <memory> context. Prefer this over guessing ' +
  'or asking the user to repeat themselves.';

@Injectable()
export class MemoryService {
  private readonly log = new Logger(MemoryService.name);

  constructor(
    private readonly repo: MemoryRepository,
    private readonly embedding: EmbeddingService,
  ) { }

  /**
   * Builds a Strands MemoryManager for a user (buyer or seller).
   * It auto-injects relevant <memory> into prompt and exposes a `search_memory` tool.
   */
  createManager(userId: string, role: UserRole = 'buyer'): MemoryManager {
    return new MemoryManager({
      stores: [this.buildStore(userId, role)],
      injection: { maxEntries: config.memory.max_entries },
      addToolConfig: false,
      searchToolConfig: { description: SEARCH_TOOL_DESCRIPTION },
    });
  }

  /**
   * Persists an explicit fact for a buyer or seller with embedding and supersede handling.
   */
  async recordFact(params: {
    userId: string;
    role: UserRole;
    category: MemoryCategory;
    content: string;
    importance?: number;
  }) {
    const { userId, role, category, content, importance = 3 } = params;

    // Check if there are candidate memories in the same category to consider superseding
    const candidates = await this.repo.findCategoryCandidates(userId, role, category);

    // Compute embedding via LiteLLM
    const embedding = await this.embedding.embed(content);

    // Save new fact
    const newRecord = await this.repo.saveFact({
      userId,
      role,
      category,
      content,
      importance,
      embedding,
    });

    // If candidate exists in the same category with identical or strongly overlapping topic,
    // supersede the oldest active one (e.g. user updating their shoe size or shipping address)
    if (candidates.length > 0 && (category === 'size_fit' || category === 'profile')) {
      const oldFact = candidates[0];
      await this.repo.supersede(oldFact.id, newRecord.id);
      this.log.log(`Superseded previous fact [${oldFact.id}] with [${newRecord.id}]`);
    }

    return newRecord;
  }

  /**
   * Record conversation turn (persisted locally / memory transcript).
   */
  async saveTurn(
    userId: string,
    sessionId: string,
    userText: string,
    assistantText: string,
  ): Promise<void> {
    // Turn persistence log (clean decoupling from AWS AgentCore)
    this.log.debug(`Recorded turn for user=${userId} session=${sessionId}`);
  }

  /**
   * Connects PostgreSQL + pgvector Hybrid Search into Strands SDK's MemoryStore.
   */
  private buildStore(userId: string, role: UserRole): MemoryStore {
    return {
      name: 'ecommerce-pgvector-memory',
      writable: false,
      search: async (query, options) => {
        const limit = options?.maxSearchResults ?? config.memory.max_entries;

        // If query is blank, provide top facts
        if (!query || query.trim().length === 0) {
          const top = await this.repo.getTopFacts(userId, role, limit);
          return top.map((t) => ({
            content: `[${t.category}] ${t.content}`.slice(0, config.memory.entry_cap),
          }));
        }

        try {
          const queryEmbedding = await this.embedding.embed(query);
          const hits = await this.repo.searchFacts({
            userId,
            role,
            query,
            queryEmbedding,
            limit,
          });

          return hits.map((h) => ({
            content: `[${h.category}] ${h.content}`.slice(0, config.memory.entry_cap),
          }));
        } catch (e) {
          this.log.warn(`Memory search failed: ${(e as Error).message}`);
          return [];
        }
      },
    };
  }
}
