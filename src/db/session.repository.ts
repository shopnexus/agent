import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from './prisma.service';
import { AgentContext } from '../agent/agent.service';

export interface SessionRecord {
  id: string;
  actorId: string;
  context: AgentContext;
  status: string;
  turnCount: number;
  createdAt: Date;
  lastActive: Date;
}

@Injectable()
export class SessionRepository {
  private readonly log = new Logger(SessionRepository.name);

  constructor(private readonly prisma: PrismaService) {}

  async create(actorId: string, context: AgentContext = {}): Promise<SessionRecord> {
    const s = await this.prisma.session.create({
      data: {
        actorId,
        context: context as any,
      },
    });
    return {
      id: s.id,
      actorId: s.actorId,
      context: s.context as AgentContext,
      status: s.status,
      turnCount: s.turnCount,
      createdAt: s.createdAt,
      lastActive: s.lastActive,
    };
  }

  async listByActor(actorId: string, limit = 50): Promise<SessionRecord[]> {
    const rows = await this.prisma.session.findMany({
      where: {
        actorId,
        status: 'active',
      },
      orderBy: {
        lastActive: 'desc',
      },
      take: limit,
    });
    return rows.map((s) => ({
      id: s.id,
      actorId: s.actorId,
      context: s.context as AgentContext,
      status: s.status,
      turnCount: s.turnCount,
      createdAt: s.createdAt,
      lastActive: s.lastActive,
    }));
  }

  /** Bump last_active + turn_count each time a turn completes. */
  async touch(sessionId: string): Promise<void> {
    await this.prisma.session.update({
      where: { id: sessionId },
      data: {
        lastActive: new Date(),
        turnCount: { increment: 1 },
      },
    });
  }

  /** Find a session only when both its ID and owner ActorID match. */
  async findByIdForActor(sessionId: string, actorId: string): Promise<SessionRecord | null> {
    const s = await this.prisma.session.findFirst({
      where: { id: sessionId, actorId },
    });
    if (!s) return null;
    return {
      id: s.id,
      actorId: s.actorId,
      context: s.context as AgentContext,
      status: s.status,
      turnCount: s.turnCount,
      createdAt: s.createdAt,
      lastActive: s.lastActive,
    };
  }

  async findById(sessionId: string): Promise<SessionRecord | null> {
    const s = await this.prisma.session.findUnique({
      where: { id: sessionId },
    });
    if (!s) return null;
    return {
      id: s.id,
      actorId: s.actorId,
      context: s.context as AgentContext,
      status: s.status,
      turnCount: s.turnCount,
      createdAt: s.createdAt,
      lastActive: s.lastActive,
    };
  }
}
