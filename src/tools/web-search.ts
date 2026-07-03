import { Logger } from '@nestjs/common';
import { tool } from '@strands-agents/sdk';
import { z } from 'zod';
import { config } from '../config';

/**
 * A `web_search` tool backed by Tavily (https://tavily.com) — a search API made
 * for agents that returns clean, snippet-level results. Enabled only when
 * TAVILY_API_KEY is set (feature degrades otherwise). To switch provider,
 * replace the fetch/format below; the tool contract stays the same.
 */

const log = new Logger('WebSearch');
const TAVILY_URL = 'https://api.tavily.com/search';

interface TavilyResult {
  title?: string;
  url?: string;
  content?: string;
}

/** True when a search provider key is configured. */
export const webSearchEnabled = (): boolean => !!config.web_search.tavily_api_key;

export function webSearchTool() {
  return tool({
    name: 'web_search',
    description:
      'Search the public web for current information and return the top results ' +
      '(title, URL, snippet). Use for recent events, facts, docs, or anything ' +
      'outside your knowledge or the other tools.',
    inputSchema: z.object({
      query: z.string().describe('The search query.'),
      max_results: z.number().int().min(1).max(10).default(5),
    }),
    callback: async (input) => search(input.query, input.max_results),
  });
}

async function search(query: string, maxResults: number): Promise<string> {
  try {
    const res = await fetch(TAVILY_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${config.web_search.tavily_api_key}`,
      },
      body: JSON.stringify({ query, max_results: maxResults, search_depth: 'basic' }),
    });
    if (!res.ok) {
      return `web_search failed: HTTP ${res.status} ${await res.text().catch(() => '')}`.trim();
    }
    const data = (await res.json()) as { results?: TavilyResult[]; answer?: string };
    const results = data.results ?? [];
    if (!results.length) return `No results for "${query}".`;

    const lines = results.map(
      (r, i) => `${i + 1}. ${r.title ?? '(untitled)'}\n   ${r.url ?? ''}\n   ${(r.content ?? '').trim()}`,
    );
    const answer = data.answer ? `Answer: ${data.answer}\n\n` : '';
    return `${answer}${lines.join('\n')}`;
  } catch (e) {
    log.warn(`web_search error: ${(e as Error).message}`);
    return `web_search error: ${(e as Error).message}`;
  }
}
