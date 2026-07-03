import { Injectable, Logger } from '@nestjs/common';
import { MemoryManager } from '@strands-agents/sdk';
import {
  CreateEventCommand,
  RetrieveMemoryRecordsCommand,
} from '@aws-sdk/client-bedrock-agentcore';
import { AgentCoreClient } from '../aws/agentcore-client';
import { config } from '../config';

// Store shape derived from the SDK, so tsc validates our implementation.
type MemoryStore = NonNullable<ConstructorParameters<typeof MemoryManager>[0]>['stores'][number];

// Steers the model on WHEN to actively recall (auto-injection already provides
// baseline context each turn, so this is for going beyond the current question).
const SEARCH_TOOL_DESCRIPTION =
  'Search the user\'s long-term memory for facts, preferences, or details they ' +
  'shared in earlier turns or past sessions. Use a focused query when you need ' +
  'something not already in the provided <memory> context — e.g. recalling a ' +
  'past decision, a stated preference, or what the user said about a specific ' +
  'topic. Prefer this over guessing or asking the user to repeat themselves.';

/**
 * Long-term memory across sessions via AgentCore Memory.
 *
 * Retrieval is wired natively into the Strands agent: `createManager(actor)`
 * returns a MemoryManager whose store is backed by AgentCore. Strands injects a
 * bounded, query-relevant `<memory>` block before each model call — so growing
 * memory never bloats the prompt (top-K semantic search, not a full dump), and
 * facts stay data (a delimited block) rather than system instructions.
 *
 * Extraction stays server-side (AgentCore strategies), so the manager does
 * injection only; raw turns are written with saveTurn (CreateEvent).
 */
@Injectable()
export class MemoryService {
  private readonly log = new Logger(MemoryService.name);

  constructor(private readonly aws: AgentCoreClient) {}

  /**
   * MemoryManager for an actor. It both (a) auto-injects a bounded, relevant
   * `<memory>` block each turn, and (b) exposes a `search_memory` tool (via
   * getTools) so the model can actively recall with its own queries. Writing is
   * disabled (addToolConfig:false) — extraction stays server-side.
   */
  createManager(actorId: string): MemoryManager {
    return new MemoryManager({
      stores: [this.buildStore(actorId)],
      injection: { maxEntries: config.memory.max_entries },
      addToolConfig: false,
      searchToolConfig: { description: SEARCH_TOOL_DESCRIPTION },
    });
  }

  /** Persist one conversation turn; server-side strategies extract facts. */
  async saveTurn(
    actorId: string,
    sessionId: string,
    userText: string,
    assistantText: string,
  ): Promise<void> {
    try {
      await this.aws.client.send(
        new CreateEventCommand({
          memoryId: config.memory.id,
          actorId,
          sessionId,
          eventTimestamp: new Date(),
          payload: [
            { conversational: { role: 'USER', content: { text: userText } } },
            { conversational: { role: 'ASSISTANT', content: { text: assistantText } } },
          ],
        }),
      );
    } catch (e) {
      this.log.warn(`saveTurn failed: ${(e as Error).message}`);
    }
  }

  /** AgentCore-backed store: search = semantic retrieve; add is a no-op
   *  (facts are extracted server-side from the events saveTurn writes). */
  private buildStore(actorId: string): MemoryStore {
    const namespace = `/facts/${actorId}`;
    return {
      name: 'agentcore',
      writable: false,
      search: async (query, options) => {
        const res = await this.aws.client.send(
          new RetrieveMemoryRecordsCommand({
            memoryId: config.memory.id,
            namespace,
            searchCriteria: { searchQuery: query },
            maxResults: options?.maxSearchResults ?? config.memory.max_entries,
          }),
        );
        return (res.memoryRecordSummaries ?? [])
          .map((r) => r.content?.text)
          .filter((t): t is string => !!t)
          // Cap each entry so one long record can't bloat the <memory> block.
          .map((t) => ({
            content: t.length > config.memory.entry_cap ? `${t.slice(0, config.memory.entry_cap)}…` : t,
          }));
      },
    };
  }
}
