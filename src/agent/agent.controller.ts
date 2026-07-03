import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import { AgentService, ChatReply } from './agent.service';
import { SessionService, SessionSummary } from '../session/session.service';
import { config } from '../config';

interface ChatDto {
  actorId?: string;
  sessionId?: string;
  message: string;
}

@Controller()
export class AgentController {
  constructor(
    private readonly agent: AgentService,
    private readonly sessions: SessionService,
  ) {}

  /** Send a message. Omit sessionId to start a brand-new chat session. */
  @Post('chat')
  chat(@Body() body: ChatDto): Promise<ChatReply> {
    const actorId = body.actorId?.trim() || config.default_actor;
    const sessionId = body.sessionId?.trim() || this.sessions.newSession();
    return this.agent.chat(actorId, sessionId, body.message ?? '');
  }

  /** Mint a new chat session id for an actor. */
  @Post('sessions')
  createSession(@Body() body: { actorId?: string }): { actorId: string; sessionId: string } {
    const actorId = body.actorId?.trim() || config.default_actor;
    return { actorId, sessionId: this.sessions.newSession() };
  }

  /** List an actor's existing chat sessions. */
  @Get('sessions')
  listSessions(@Query('actorId') actorId?: string): Promise<SessionSummary[]> {
    return this.sessions.listSessions(actorId?.trim() || config.default_actor);
  }
}
