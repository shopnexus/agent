import { Logger } from '@nestjs/common';
import { tool } from '@strands-agents/sdk';
import { z } from 'zod';
import { MemoryService } from './memory.service';
import { MemoryCategory } from './types';

const log = new Logger('RememberFact');
const CATEGORIES: [MemoryCategory, ...MemoryCategory[]] = ['profile', 'preference', 'size_fit', 'feedback'];

export function rememberFactTool(memory: MemoryService, userId: string, _sessionId: string) {
  return tool({
    name: 'remember_fact',
    description:
      'Save or update a stable fact the user has directly shared about themself, such as their name, ' +
      'shopping preferences, sizes, or feedback. Do not save secrets, sensitive personal data, or transient business facts.',
    inputSchema: z.object({
      category: z.enum(CATEGORIES).describe('Fact category: profile, preference, size_fit, or feedback.'),
      fact: z.string().min(3).max(500).describe('A concise fact, preferably in key: value form.'),
      importance: z.number().min(1).max(5).default(3),
    }),
    callback: async ({ category, fact, importance }) => {
      try {
        const keyPart = fact.split(/[:=]/, 1)[0].trim().toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').slice(0, 48);
        const factKey = `${category}.${keyPart || 'general'}`;
        await memory.recordFact({ userId, category, factKey, content: fact, importance });
        log.log(`Saved user memory [${category}] for actor=${userId}`);
        return `Remembered [${category}].`;
      } catch (e) {
        log.warn(`Memory write rejected or failed (${e instanceof Error ? e.name : 'unknown error'})`);
        return 'I could not save that memory. It may contain information that should not be stored.';
      }
    },
  });
}
