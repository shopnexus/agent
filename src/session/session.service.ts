import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { ListSessionsCommand } from '@aws-sdk/client-bedrock-agentcore';
import { AgentCoreClient } from '../aws/agentcore-client';
import { config } from '../config';

export interface SessionSummary {
  sessionId: string;
  createdAt?: string;
}

/**
 * Chat-session lifecycle. A session groups the turns of one conversation under
 * an actor; switching sessions starts a fresh conversation while long-term
 * memory (owned by MemoryService, keyed by actor) carries over.
 *
 * Sessions are materialised in AgentCore Memory as soon as the first turn is
 * written (CreateEvent), so listing reads them back via ListSessions.
 */
@Injectable()
export class SessionService {
  private readonly log = new Logger(SessionService.name);

  constructor(private readonly aws: AgentCoreClient) {}

  /** Mint a new chat session id for an actor. */
  newSession(): string {
    return `session-${randomUUID()}`;
  }

  /** List an actor's existing chat sessions from AgentCore Memory. */
  async listSessions(actorId: string): Promise<SessionSummary[]> {
    try {
      const res = await this.aws.client.send(
        new ListSessionsCommand({ memoryId: config.memory.id, actorId, maxResults: 100 }),
      );
      return (res.sessionSummaries ?? []).map((s) => ({
        sessionId: s.sessionId ?? '',
        createdAt: s.createdAt?.toISOString?.(),
      }));
    } catch (e) {
      this.log.warn(`listSessions failed: ${(e as Error).message}`);
      return [];
    }
  }
}
