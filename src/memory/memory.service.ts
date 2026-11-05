import { Injectable, Logger } from '@nestjs/common';
import { MemoryManager } from '@strands-agents/sdk';
import { MemoryRepository } from './memory.repository';
import { EmbeddingService } from '../llm/embedding.service';
import { MemoryCategory, UserMemory } from './types';
import { config } from '../config';
import { scanAndMaskPii } from '../guardrails/pii-utils';

type MemoryStore = NonNullable<ConstructorParameters<typeof MemoryManager>[0]>['stores'][number];

const SEARCH_TOOL_DESCRIPTION =
  'Search this user\'s long-term memory for a relevant saved preference or profile fact. ' +
  'Use a focused query; do not guess if nothing relevant is found.';
const SECRET_RE = /\b(?:password|passwd|otp|pin|token|api[\s_-]?key|cvv|cvc|cccd|cmnd|credit\s*card|debit\s*card|bank\s*account|mật khẩu|mã otp|số thẻ)\b/i;

@Injectable()
export class MemoryService {
  private readonly log = new Logger(MemoryService.name);

  constructor(private readonly repo: MemoryRepository, private readonly embedding: EmbeddingService) {}

  createManager(userId: string): MemoryManager {
    return new MemoryManager({
      stores: [this.buildStore(userId)],
      injection: { maxEntries: config.memory.max_entries },
      addToolConfig: false,
      searchToolConfig: { description: SEARCH_TOOL_DESCRIPTION },
    });
  }

  async recordFact(params: {
    userId: string;
    category: MemoryCategory;
    factKey: string;
    content: string;
    importance?: number;
    sourceTurnId?: string;
    expiresAt?: Date;
  }): Promise<UserMemory> {
    const content = params.content.normalize('NFC').trim();
    this.assertEligible(content);
    const embedding = await this.embedding.embed(content);
    return this.repo.replaceFact({ ...params, content, embedding });
  }

  async search(userId: string, query: string, limit = config.memory.max_entries) {
    const normalized = query.normalize('NFC').trim();
    if (!normalized) return [];
    const queryEmbedding = await this.embedding.embed(normalized);
    const results = await this.repo.searchFacts({ userId, query: normalized, queryEmbedding, limit });
    this.log.log(`Memory search completed for actor=${userId} result_count=${results.length}`);
    return results;
  }

  async list(userId: string): Promise<UserMemory[]> {
    const facts = await this.repo.listFacts(userId);
    this.log.log(`Memory list completed for actor=${userId} result_count=${facts.length}`);
    return facts;
  }

  async update(userId: string, id: string, content: string): Promise<boolean> {
    const normalized = content.normalize('NFC').trim();
    this.assertEligible(normalized);
    const embedding = await this.embedding.embed(normalized);
    const updated = await this.repo.updateFact(userId, id, normalized, embedding);
    this.log.log(`Memory update completed for actor=${userId} outcome=${updated ? 'updated' : 'not_found'}`);
    return updated;
  }

  async forget(userId: string, id: string): Promise<boolean> {
    const deleted = await this.repo.forgetFact(userId, id);
    this.log.log(`Memory delete completed for actor=${userId} outcome=${deleted ? 'deleted' : 'not_found'}`);
    return deleted;
  }

  async forgetAll(userId: string): Promise<number> {
    const deletedCount = await this.repo.forgetAll(userId);
    this.log.log(`Memory bulk delete completed for actor=${userId} deleted_count=${deletedCount}`);
    return deletedCount;
  }

  private assertEligible(content: string): void {
    if (content.length < 3 || content.length > 500) throw new Error('Memory fact length is invalid');
    if (SECRET_RE.test(content) || scanAndMaskPii(content).hasPii) {
      throw new Error('Memory fact contains data that must not be stored');
    }
    if (/(?:price|stock|inventory|order status|tracking|giá|tồn kho|đơn hàng|vận chuyển)/i.test(content)) {
      throw new Error('Transient business data cannot be stored as user memory');
    }
  }

  private buildStore(userId: string): MemoryStore {
    return {
      name: 'ecommerce-pgvector-memory',
      writable: false,
      search: async (query, options) => {
        if (!query?.trim()) return [];
        try {
          const hits = await this.search(userId, query, options?.maxSearchResults ?? config.memory.max_entries);
          return hits.map((hit) => ({ content: `[${hit.category}] ${hit.content}`.slice(0, config.memory.entry_cap) }));
        } catch (e) {
          this.log.warn(`Memory search failed (${e instanceof Error ? e.name : 'unknown error'})`);
          return [];
        }
      },
    };
  }
}
