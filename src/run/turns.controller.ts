import { Body, Controller, Get, Headers, HttpCode, Param, Post, Query, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { ConsoleMember, ConsoleMemberGuard, Member } from '../console/console-member';
import { ConversationService, TurnView } from '../conversation/conversation.service';
import { TurnRepository } from '../db/turn.repository';
import { AgentError } from '../http/agent-error';
import { TurnActionsService } from './turn-actions.service';
import { sseFrame, TurnStreamService } from './turn-stream.service';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function afterSeq(header?: string, query?: string): number {
  const raw = header ?? query;
  if (raw === undefined || raw === '') return 0;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) throw AgentError.badRequest();
  return n;
}

/** A turn's stream and controls. Called by server only, as for conversations. */
@Controller('turns')
@UseGuards(ConsoleMemberGuard)
export class TurnsController {
  constructor(
    private readonly conversations: ConversationService,
    private readonly actions: TurnActionsService,
    private readonly stream: TurnStreamService,
  ) {}

  @Get(':id')
  get(@Member() member: ConsoleMember, @Param('id') id: string): Promise<TurnView> {
    return this.conversations.getTurn(member, id);
  }

  /**
   * Server-sent events: replay after Last-Event-ID (or ?after=), then live.
   * Ends after turn.finished, turn.paused or clarify; reconnect after acting on the turn.
   */
  @Get(':id/events')
  async events(@Member() member: ConsoleMember, @Param('id') id: string, @Res() res: Response,
    @Headers('last-event-id') lastEventId?: string, @Query('after') after?: string): Promise<void> {
    const from = afterSeq(lastEventId, after);
    await this.actions.visibleTurn(member, id);
    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    res.write('retry: 2000\n\n');
    const closed = new AbortController();
    res.on('close', () => closed.abort());
    try {
      await this.stream.stream(id, from, event => { res.write(sseFrame(event)); }, closed.signal,
        { onIdle: () => { res.write(': keep-alive\n\n'); } });
    } finally {
      res.end();
    }
  }

  @Post(':id/pause') @HttpCode(202)
  async pause(@Member() member: ConsoleMember, @Param('id') id: string) { await this.actions.pause(member, id); return {}; }

  /** Stop now: ends the model call at once; the turn lands PAUSED and can be continued. */
  @Post(':id/stop') @HttpCode(202)
  async stop(@Member() member: ConsoleMember, @Param('id') id: string) { await this.actions.stop(member, id); return {}; }

  @Post(':id/steer') @HttpCode(202)
  steer(@Member() member: ConsoleMember, @Param('id') id: string, @Body() body: { text?: unknown } = {}) {
    return this.actions.steer(member, id, body?.text);
  }

  @Post(':id/continue') @HttpCode(202)
  async continue(@Member() member: ConsoleMember, @Param('id') id: string) { await this.actions.continue(member, id); return { turn_id: id }; }

  @Post(':id/end') @HttpCode(200)
  async end(@Member() member: ConsoleMember, @Param('id') id: string) { await this.actions.end(member, id); return { status: 'CANCELLED' }; }

  @Post(':id/input') @HttpCode(202)
  async input(@Member() member: ConsoleMember, @Param('id') id: string, @Body() body: { answers?: unknown } = {}) {
    await this.actions.input(member, id, body?.answers); return { turn_id: id };
  }
}

/** A tool call's input, output and timing for the tool panel. */
@Controller('tool-calls')
@UseGuards(ConsoleMemberGuard)
export class ToolCallsController {
  constructor(private readonly turns: TurnRepository) {}

  @Get(':id')
  async get(@Member() member: ConsoleMember, @Param('id') id: string) {
    if (!UUID.test(id)) throw AgentError.notFound();
    const call = await this.turns.findToolCall(id, member.id);
    if (!call) throw AgentError.notFound();
    let output: unknown = call.output;
    if (typeof call.output === 'string') { try { output = JSON.parse(call.output); } catch { /* plain text */ } }
    return {
      id: call.id, turn_id: call.turnId, tool: call.toolName, status: call.status,
      input: call.input, output, output_spilled: call.outputSpilled, attempts: call.attempts,
      started_at: call.createdAt.toISOString(), finished_at: call.finishedAt?.toISOString() ?? null,
      duration_ms: call.latencyMs, timing: call.timing ?? null,
    };
  }
}
