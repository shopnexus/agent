import { Injectable } from '@nestjs/common';
import { AgentError } from '../http/agent-error';
import { StatsSource, type DayRow } from './stats.repository';

const RANGES: Record<string, number> = { '7d': 7, '30d': 30, '90d': 90 };
const RECENT = 20;

/** Every UTC date of the range, oldest first, ending today, and the moment the first one starts. */
export function rangeDays(range: unknown, now = new Date()): { from: Date; dates: string[] } {
  const key = range === undefined || range === '' ? '7d' : range;
  const n = typeof key === 'string' ? RANGES[key] : undefined;
  if (!n) throw AgentError.badRequest();
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const dates = Array.from({ length: n }, (_, i) => new Date(today - (n - 1 - i) * 86_400_000).toISOString().slice(0, 10));
  return { from: new Date(today - (n - 1) * 86_400_000), dates };
}

/** Per key, a count for every date of the range (0 where there were none). */
function byDay<T extends string>(rows: DayRow[], dates: string[], field: T) {
  const map = new Map<string | null, Map<string, number>>();
  for (const r of rows) {
    const days = map.get(r.key) ?? new Map<string, number>();
    days.set(r.date, (days.get(r.date) ?? 0) + Number(r.count));
    map.set(r.key, days);
  }
  return (key: string | null) => dates.map(date => ({ date, [field]: map.get(key)?.get(date) ?? 0 }) as { date: string } & Record<T, number>);
}

/** The figures Settings › Tools, Guardrails and Overview show; server allows admins only. */
@Injectable()
export class StatsService {
  constructor(private readonly source: StatsSource) {}

  async tools(range: unknown, now?: Date) {
    const { from, dates } = rangeDays(range, now);
    const [totals, days, recent] = await Promise.all([this.source.toolTotals(from), this.source.toolDays(from), this.source.recentCalls(from, RECENT)]);
    const daysOf = byDay(days, dates, 'calls');
    return {
      items: totals.map(t => ({ name: t.name, calls: Number(t.calls), failed: Number(t.failed),
        p50_ms: t.p50_ms === null ? null : Math.round(Number(t.p50_ms)), days: daysOf(t.name) })),
      recent: recent.map(r => ({ call_id: r.call_id, turn_id: r.turn_id, member_id: r.member_id, tool: r.tool, label: r.label ?? r.tool,
        duration_ms: r.duration_ms, status: r.status, at: new Date(r.at).toISOString() })),
    };
  }

  async guardrails(range: unknown, now?: Date) {
    const { from } = rangeDays(range, now);
    const [rules, recent] = await Promise.all([this.source.guardrailRules(from), this.source.recentGuardrails(from, RECENT)]);
    return {
      items: rules.map(r => ({ rule: r.rule ?? 'unknown', count: Number(r.count) })),
      recent: recent.map(r => ({ rule: r.rule ?? 'unknown', detail: r.detail ?? '', member_id: r.member_id, turn_id: r.turn_id, at: new Date(r.at).toISOString() })),
    };
  }

  async turns(range: unknown, now?: Date) {
    const { from, dates } = rangeDays(range, now);
    const [days, members] = await Promise.all([this.source.agentDays(from), this.source.memberTurns(from)]);
    const daysOf = byDay(days, dates, 'requests');
    const totals = new Map<string | null, number>();
    for (const r of days) totals.set(r.key, (totals.get(r.key) ?? 0) + Number(r.count));
    return {
      by_agent: [...totals.entries()].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])))
        .map(([agent_id, requests]) => ({ agent_id, requests, days: daysOf(agent_id) })),
      by_member: members.map(m => ({ member_id: m.key, requests: Number(m.count) })),
    };
  }
}
