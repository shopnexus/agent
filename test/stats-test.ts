/** Offline: the settings figures — ranges, UTC days filled with zeros, shapes, the default agent. */
import assert from 'node:assert/strict';
import { AgentError } from '../src/http/agent-error';
import { StatsService, rangeDays } from '../src/stats/stats.service';

async function main() {
  const now = new Date('2026-11-19T01:30:00Z');
  const seven = rangeDays('7d', now);
  assert.deepEqual(seven.dates, ['2026-11-13', '2026-11-14', '2026-11-15', '2026-11-16', '2026-11-17', '2026-11-18', '2026-11-19']);
  assert.equal(seven.from.toISOString(), '2026-11-13T00:00:00.000Z');
  assert.equal(rangeDays(undefined, now).dates.length, 7, '7d by default');
  assert.equal(rangeDays('30d', now).dates.length, 30);
  assert.equal(rangeDays('90d', now).dates[0], '2026-08-22');
  for (const bad of ['1d', '7', 'all', 7]) assert.throws(() => rangeDays(bad, now), (e: unknown) => e instanceof AgentError && e.code === 'bad_request');

  const at = new Date('2026-11-18T10:00:00Z');
  const froms: Date[] = [];
  const source = {
    toolTotals: async (from: Date) => { froms.push(from); return [{ name: 'ticket_get', calls: 3, failed: 1, p50_ms: 41.6 }, { name: 'order_get', calls: 1, failed: 0, p50_ms: null }]; },
    toolDays: async () => [{ key: 'ticket_get', date: '2026-11-18', count: 2 }, { key: 'ticket_get', date: '2026-11-13', count: 1 }, { key: 'order_get', date: '2026-11-19', count: 1 }],
    recentCalls: async (_f: Date, limit: number) => { assert.equal(limit, 20); return [{ call_id: 'c1', turn_id: 't1', member_id: 'm1', tool: 'ticket_get', label: 'Ticket', duration_ms: 40, status: 'success', at }, { call_id: 'c2', turn_id: 't1', member_id: 'm1', tool: 'order_get', label: null, duration_ms: null, status: 'failed', at }]; },
    guardrailRules: async () => [{ rule: 'loop_stopped', count: 2 }, { rule: 'rate_limited', count: 1 }],
    recentGuardrails: async () => [{ rule: 'loop_stopped', detail: 'order_get was called again with the same input', member_id: 'm1', turn_id: 't1', at }],
    agentDays: async () => [{ key: null, date: '2026-11-19', count: 2 }, { key: 'scam-desk', date: '2026-11-14', count: 5 }, { key: null, date: '2026-11-13', count: 1 }],
    memberTurns: async () => [{ key: 'm1', count: 6 }, { key: 'm2', count: 2 }],
  };
  const stats = new StatsService(source as any);
  const zeros = (field: string, set: Record<string, number>) => seven.dates.map(date => ({ date, [field]: set[date] ?? 0 }));

  assert.deepEqual(await stats.tools('7d', now), {
    items: [
      { name: 'ticket_get', calls: 3, failed: 1, p50_ms: 42, days: zeros('calls', { '2026-11-13': 1, '2026-11-18': 2 }) },
      { name: 'order_get', calls: 1, failed: 0, p50_ms: null, days: zeros('calls', { '2026-11-19': 1 }) },
    ],
    recent: [
      { call_id: 'c1', turn_id: 't1', member_id: 'm1', tool: 'ticket_get', label: 'Ticket', duration_ms: 40, status: 'success', at: at.toISOString() },
      { call_id: 'c2', turn_id: 't1', member_id: 'm1', tool: 'order_get', label: 'order_get', duration_ms: null, status: 'failed', at: at.toISOString() },
    ],
  });
  assert.equal(froms[0].toISOString(), '2026-11-13T00:00:00.000Z');
  assert.deepEqual(await stats.guardrails('7d', now), {
    items: [{ rule: 'loop_stopped', count: 2 }, { rule: 'rate_limited', count: 1 }],
    recent: [{ rule: 'loop_stopped', detail: 'order_get was called again with the same input', member_id: 'm1', turn_id: 't1', at: at.toISOString() }],
  });
  assert.deepEqual(await stats.turns('7d', now), {
    by_agent: [
      { agent_id: 'scam-desk', requests: 5, days: zeros('requests', { '2026-11-14': 5 }) },
      { agent_id: null, requests: 3, days: zeros('requests', { '2026-11-13': 1, '2026-11-19': 2 }) },
    ],
    by_member: [{ member_id: 'm1', requests: 6 }, { member_id: 'm2', requests: 2 }],
  });
  console.log('Stats tests passed (ranges, zero-filled UTC days, tools, guardrails, turns by agent and member)');
}
main().catch(e => { console.error(e); process.exitCode = 1; });
