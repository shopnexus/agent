import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ConsoleMember, ConsoleMemberGuard, Member } from '../console/console-member';
import { AgentError } from '../http/agent-error';
import { StatsService } from './stats.service';

/** Figures for the admin settings pages; `range` is 7d (default), 30d or 90d. */
@Controller('stats')
@UseGuards(ConsoleMemberGuard)
export class StatsController {
  constructor(private readonly stats: StatsService) {}

  @Get('tools')
  tools(@Member() member: ConsoleMember, @Query('range') range?: string) { admin(member); return this.stats.tools(range); }

  @Get('guardrails')
  guardrails(@Member() member: ConsoleMember, @Query('range') range?: string) { admin(member); return this.stats.guardrails(range); }

  @Get('turns')
  turns(@Member() member: ConsoleMember, @Query('range') range?: string) { admin(member); return this.stats.turns(range); }
}

function admin(member: ConsoleMember) {
  if (member.role !== 'admin') throw AgentError.forbidden();
}
