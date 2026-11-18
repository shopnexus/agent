import { Injectable } from '@nestjs/common';
import { PrismaService } from '../db/prisma.service';

export interface ToolTotalRow { name: string; calls: number; failed: number; p50_ms: number | null }
export interface DayRow { key: string | null; date: string; count: number }
export interface RecentCallRow { call_id: string; turn_id: string; member_id: string; tool: string; label: string | null; duration_ms: number | null; status: string; at: Date }
export interface RuleRow { rule: string | null; count: number }
export interface RecentGuardrailRow { rule: string | null; detail: string | null; member_id: string; turn_id: string; at: Date }
export interface CountRow { key: string | null; count: number }

/** The aggregates behind the settings figures, from tool_calls, turn_events and turns since a moment. */
export abstract class StatsSource {
  abstract toolTotals(from: Date): Promise<ToolTotalRow[]>;
  abstract toolDays(from: Date): Promise<DayRow[]>;
  abstract recentCalls(from: Date, limit: number): Promise<RecentCallRow[]>;
  abstract guardrailRules(from: Date): Promise<RuleRow[]>;
  abstract recentGuardrails(from: Date, limit: number): Promise<RecentGuardrailRow[]>;
  abstract agentDays(from: Date): Promise<DayRow[]>;
  abstract memberTurns(from: Date): Promise<CountRow[]>;
}

const DAY = `to_char(timezone('UTC', $COL), 'YYYY-MM-DD')`;
const day = (col: string) => DAY.replace('$COL', col);
/** A turn's agent: the column, else the id in its stored agent_config. */
const AGENT = `COALESCE(t.agent_id, t.state->'agent_config'->>'id')`;

@Injectable()
export class StatsRepository extends StatsSource {
  constructor(private readonly prisma: PrismaService) { super(); }

  toolTotals(from: Date) {
    return this.prisma.$queryRawUnsafe<ToolTotalRow[]>(`
      SELECT tool_name AS name, count(*)::int AS calls, (count(*) FILTER (WHERE status = 'failed'))::int AS failed,
             (percentile_cont(0.5) WITHIN GROUP (ORDER BY latency_ms))::float8 AS p50_ms
      FROM tool_calls WHERE created_at >= $1 GROUP BY tool_name ORDER BY calls DESC, name`, from);
  }

  toolDays(from: Date) {
    return this.prisma.$queryRawUnsafe<DayRow[]>(`
      SELECT tool_name AS key, ${day('created_at')} AS date, count(*)::int AS count
      FROM tool_calls WHERE created_at >= $1 GROUP BY 1, 2`, from);
  }

  recentCalls(from: Date, limit: number) {
    return this.prisma.$queryRawUnsafe<RecentCallRow[]>(`
      SELECT c.id::text AS call_id, c.turn_id::text AS turn_id, t.member_id, c.tool_name AS tool, c.tool_label AS label,
             c.latency_ms AS duration_ms, c.status::text AS status, COALESCE(c.finished_at, c.created_at) AS at
      FROM tool_calls c JOIN turns t ON t.id = c.turn_id
      WHERE c.created_at >= $1 ORDER BY c.created_at DESC, c.id LIMIT $2`, from, limit);
  }

  guardrailRules(from: Date) {
    return this.prisma.$queryRawUnsafe<RuleRow[]>(`
      SELECT body->>'rule' AS rule, count(*)::int AS count
      FROM turn_events WHERE type = 'guardrail' AND at >= $1 GROUP BY 1 ORDER BY count DESC, rule`, from);
  }

  recentGuardrails(from: Date, limit: number) {
    return this.prisma.$queryRawUnsafe<RecentGuardrailRow[]>(`
      SELECT e.body->>'rule' AS rule, e.body->>'detail' AS detail, t.member_id, e.turn_id::text AS turn_id, e.at
      FROM turn_events e JOIN turns t ON t.id = e.turn_id
      WHERE e.type = 'guardrail' AND e.at >= $1 ORDER BY e.at DESC, e.turn_id, e.seq DESC LIMIT $2`, from, limit);
  }

  agentDays(from: Date) {
    return this.prisma.$queryRawUnsafe<DayRow[]>(`
      SELECT ${AGENT} AS key, ${day('t.started_at')} AS date, count(*)::int AS count
      FROM turns t WHERE t.started_at >= $1 GROUP BY 1, 2`, from);
  }

  memberTurns(from: Date) {
    return this.prisma.$queryRawUnsafe<CountRow[]>(`
      SELECT member_id AS key, count(*)::int AS count
      FROM turns WHERE started_at >= $1 GROUP BY 1 ORDER BY count DESC, key`, from);
  }
}
