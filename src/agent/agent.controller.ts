import { BadRequestException, Body, Controller, Delete, Get, Patch, Param, ParseUUIDPipe, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { AgentService, AgentContext, ChatReply } from './agent.service';
import { SessionService, SessionSummary } from '../session/session.service';
import { MemoryService } from '../memory/memory.service';

interface ChatDto {
  sessionId?: string;
  message: string;
  context?: AgentContext;
}

@Controller()
export class AgentController {
  constructor(
    private readonly agent: AgentService,
    private readonly sessions: SessionService,
    private readonly memory: MemoryService,
  ) {}

  /** The API Gateway passes its validated ActorID as X-User-ID. */
  @Post('chat')
  async chat(@Body() body: ChatDto, @Req() req: Request): Promise<ChatReply> {
    const actorId = requireGatewayActorId(req);
    const ctx: AgentContext = { ...(body.context ?? {}), userId: actorId };
    const sessionId = body.sessionId?.trim();
    if (sessionId) await this.sessions.assertOwnedSession(actorId, sessionId);
    const resolvedSessionId = sessionId || await this.sessions.newSession(actorId, ctx);
    return this.agent.chat(actorId, resolvedSessionId, body.message ?? '', ctx);
  }

  /** Create a session for the ActorID propagated by the API Gateway. */
  @Post('sessions')
  async createSession(
    @Body() body: { context?: AgentContext },
    @Req() req: Request,
  ): Promise<{ actorId: string; sessionId: string }> {
    const actorId = requireGatewayActorId(req);
    const context: AgentContext = { ...(body.context ?? {}), userId: actorId };
    const sessionId = await this.sessions.newSession(actorId, context);
    return { actorId, sessionId };
  }

  /** List sessions for the ActorID propagated by the API Gateway. */
  @Get('sessions')
  listSessions(@Req() req: Request): Promise<SessionSummary[]> {
    return this.sessions.listSessions(requireGatewayActorId(req));
  }

  @Get('memory')
  async listMemories(@Req() req: Request) {
    return this.memory.list(requireGatewayActorId(req));
  }

  @Patch('memory/:id')
  async updateMemory(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: { content: string },
    @Req() req: Request,
  ) {
    const updated = await this.memory.update(requireGatewayActorId(req), id, body.content ?? '');
    return { updated };
  }

  @Delete('memory/:id')
  async forgetMemory(@Param('id', new ParseUUIDPipe()) id: string, @Req() req: Request) {
    return { deleted: await this.memory.forget(requireGatewayActorId(req), id) };
  }

  @Delete('memory')
  async forgetAllMemories(@Req() req: Request) {
    return { deletedCount: await this.memory.forgetAll(requireGatewayActorId(req)) };
  }
}

/** Reads the identity propagated by the gateway; performs no authentication. */
function requireGatewayActorId(req: Request): string {
  const value = req.header('X-User-ID')?.trim();
  if (!value || value.length > 64 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new BadRequestException('Gateway must provide a valid X-User-ID');
  }
  return value;
}
