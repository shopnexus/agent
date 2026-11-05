import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { SessionRepository, SessionRecord } from '../db/session.repository';
import { ActorRepository } from '../db/actor.repository';
import { AgentContext } from '../agent/agent.service';

export interface SessionSummary {
  sessionId: string;
  createdAt?: string;
  lastActive?: string;
  turnCount?: number;
}

/**
 * Chat-session lifecycle. Sessions are persisted in PostgreSQL so they survive
 * restarts and can be resumed. Each session is scoped to an actor.
 *
 * On first encounter, the actor row is upserted so FK constraints are satisfied
 * without requiring a separate "register actor" call.
 */
@Injectable()
export class SessionService {
  private readonly log = new Logger(SessionService.name);

  constructor(
    private readonly sessions: SessionRepository,
    private readonly actors: ActorRepository,
  ) {}

  /**
   * Mint a new session for an actor.
   * If actorId is provided the session is persisted immediately; otherwise a
   * random local ID is returned (backward-compatible with callers that don't
   * pass an actorId yet).
   */
  async newSession(actorId: string, context: AgentContext = {}): Promise<string> {
    await this.actors.upsert(actorId, context.locale ?? 'vi');
    const session = await this.sessions.create(actorId, context);
    this.log.debug(`New session ${session.id} for actor ${actorId}`);
    return session.id;
  }

  /**
   * Verify the session belongs to the ActorID propagated by the Gateway.
   * Return the same not-found response for missing and foreign sessions.
   */
  async assertOwnedSession(actorId: string, sessionId: string): Promise<void> {
    if (!isCanonicalUuid(sessionId)) throw new NotFoundException('Session not found');
    const session = await this.sessions.findByIdForActor(sessionId, actorId);
    if (!session) throw new NotFoundException('Session not found');
  }

  /** List active sessions for an actor (most recent first). */
  async listSessions(actorId: string): Promise<SessionSummary[]> {
    try {
      const rows = await this.sessions.listByActor(actorId);
      return rows.map(toSummary);
    } catch (e) {
      this.log.warn(`listSessions failed: ${(e as Error).message}`);
      return [];
    }
  }

  /** Bump session after each turn completes. */
  async touchSession(sessionId: string): Promise<void> {
    try {
      await this.sessions.touch(sessionId);
    } catch {
      /* best-effort */
    }
  }
}

function isCanonicalUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function toSummary(r: SessionRecord): SessionSummary {
  return {
    sessionId: r.id,
    createdAt: r.createdAt?.toISOString(),
    lastActive: r.lastActive?.toISOString(),
    turnCount: r.turnCount,
  };
}
