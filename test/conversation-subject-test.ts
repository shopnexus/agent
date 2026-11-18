/** Offline: shared conversations by subject, members' own conversations, and the member on turns. */
import assert from 'node:assert/strict';
import { Prisma } from '@prisma/client';
import { ConversationRepository } from '../src/db/conversation.repository';
import { ConversationService, parseSubject, parseSubjectFilter } from '../src/conversation/conversation.service';
import { TurnRepository } from '../src/db/turn.repository';
import { AgentError } from '../src/http/agent-error';

const LAN = { id: '11111111-1111-4111-8111-111111111111', role: 'moderator' as const };
const MINH = { id: '66666666-6666-4666-8666-666666666666', role: 'admin' as const };
const TICKET = '33333333-3333-4333-8333-333333333333';
const ACCOUNT = '44444444-4444-4444-8444-444444444444';

/** A where-clause evaluator for the shapes the repository uses. */
function matches(row: any, where: any): boolean {
  if (!where) return true;
  return Object.entries(where).every(([key, value]: [string, any]) => {
    if (key === 'AND') return value.every((w: any) => matches(row, w));
    if (key === 'OR') return value.some((w: any) => matches(row, w));
    if (value && typeof value === 'object' && 'not' in value) return row[key] !== value.not;
    return row[key] === value;
  });
}

function fakePrisma() {
  const rows: any[] = [];
  let seq = 0;
  let raceOnce = false;
  const prisma = {
    rows,
    openTurns: new Set<string>(),
    turn: { findFirst: async ({ where }: any) => (prisma.openTurns.has(where.conversationId) ? { id: 'open' } : null) },
    raceNextCreate() { raceOnce = true; },
    conversation: {
      findFirst: async ({ where }: any) => rows.find(r => matches(r, where)) ?? null,
      findFirstOrThrow: async ({ where }: any) => { const r = rows.find(x => matches(x, where)); if (!r) throw new Error('none'); return r; },
      findMany: async ({ where }: any) => rows.filter(r => matches(r, where)),
      update: async ({ where, data }: any) => { const r = rows.find(x => x.id === where.id); Object.assign(r, data); return r; },
      delete: async ({ where }: any) => { rows.splice(rows.findIndex(x => x.id === where.id), 1); },
      create: async ({ data }: any) => {
        const row = { id: `00000000-0000-4000-8000-00000000000${++seq}`, subjectKind: null, subjectId: null, title: null, status: 'active', lastActivityAt: new Date(0), ...data };
        if (raceOnce) {
          // Another member wins the insert between our lookup and create.
          raceOnce = false;
          rows.push({ ...row, id: 'winner', actorId: 'someone-else' });
          throw new Prisma.PrismaClientKnownRequestError('unique', { code: 'P2002', clientVersion: 'test' });
        }
        if (row.subjectKind && rows.some(r => r.subjectKind === row.subjectKind && r.subjectId === row.subjectId)) {
          throw new Prisma.PrismaClientKnownRequestError('unique', { code: 'P2002', clientVersion: 'test' });
        }
        rows.push(row);
        return row;
      },
    },
  };
  return prisma;
}

async function main() {
  const prisma = fakePrisma();
  const service = new ConversationService(new ConversationRepository(prisma as any), { upsert: async () => ({}) } as any);

  // One conversation per record, shared by every member.
  const lanTicket = await service.open(LAN, { kind: 'ticket', id: TICKET });
  const minhTicket = await service.open(MINH, { kind: 'ticket', id: TICKET });
  assert.equal(minhTicket.id, lanTicket.id, 'the second member gets the record\'s conversation');
  assert.deepEqual({ kind: lanTicket.subject_kind, id: lanTicket.subject_id }, { kind: 'ticket', id: TICKET });
  assert.equal(prisma.rows.length, 1);

  // A concurrent create resolves to the conversation that won the unique index.
  prisma.raceNextCreate();
  const raced = await service.open(MINH, { kind: 'account', id: ACCOUNT });
  assert.equal(raced.id, 'winner');

  // A conversation without a subject is its creator's alone, and each open makes a new one.
  const lanOwn = await service.open(LAN);
  const lanOwn2 = await service.open(LAN);
  assert.notEqual(lanOwn.id, lanOwn2.id);
  assert.equal(lanOwn.subject_kind, undefined);
  await service.assertVisible(LAN, lanOwn.id);
  await assert.rejects(service.assertVisible(MINH, lanOwn.id), (e: unknown) => e instanceof AgentError && e.code === 'not_found');
  await service.assertVisible(MINH, lanTicket.id);
  await assert.rejects(service.assertVisible(LAN, 'not-a-uuid'), (e: unknown) => e instanceof AgentError && e.code === 'not_found');

  const minhList = (await service.list(MINH)).map(c => c.id).sort();
  assert.deepEqual(minhList, [lanTicket.id, 'winner'].sort(), 'Minh sees the shared conversations, not Lan\'s own');
  assert.equal((await service.list(LAN)).length, 4);
  assert.deepEqual((await service.list(LAN, { kind: 'ticket', id: TICKET })).map(c => c.id), [lanTicket.id]);
  assert.deepEqual((await service.list(LAN, { kind: 'account' })).map(c => c.id), ['winner']);

  // Rename and delete: a member's own conversation is theirs (or an admin's); a shared one is an admin's.
  const MOD2 = { id: '77777777-7777-4777-8777-777777777777', role: 'moderator' as const };
  assert.equal((await service.rename(LAN, lanOwn.id, '  Ring check  ')).title, 'Ring check');
  await assert.rejects(service.rename(LAN, lanOwn.id, '   '), (e: unknown) => e instanceof AgentError && e.code === 'bad_request');
  await assert.rejects(service.rename(MOD2, lanOwn.id, 'x'), (e: unknown) => e instanceof AgentError && e.code === 'not_found');
  await assert.rejects(service.remove(LAN, lanTicket.id), (e: unknown) => e instanceof AgentError && e.code === 'forbidden');
  prisma.openTurns.add(lanOwn2.id);
  await assert.rejects(service.remove(LAN, lanOwn2.id), (e: unknown) => e instanceof AgentError && e.code === 'turn_in_progress');
  await service.remove(MINH, lanOwn.id);
  assert.equal(prisma.rows.some(r => r.id === lanOwn.id), false, 'an admin deletes a member\'s own conversation');
  await service.rename(MINH, lanTicket.id, 'Ticket 33333333');
  await assert.rejects(service.remove(LAN, 'nope'), (e: unknown) => e instanceof AgentError && e.code === 'not_found');
  prisma.openTurns.clear()

  // Subject parsing: both or neither, known kinds, UUIDs.
  assert.equal(parseSubject(undefined, undefined), undefined);
  assert.deepEqual(parseSubject('report_case', TICKET.toUpperCase()), { kind: 'report_case', id: TICKET });
  for (const [kind, id] of [['ticket', undefined], [undefined, TICKET], ['shop', TICKET], ['ticket', 'PROD-1']]) {
    assert.throws(() => parseSubject(kind, id), AgentError);
  }
  assert.deepEqual(parseSubjectFilter('ticket', undefined), { kind: 'ticket' });
  assert.throws(() => parseSubjectFilter(undefined, TICKET), AgentError);

  // The turn records who asked, under a lock that also checks the member may see the conversation.
  const sql: string[] = [];
  const created: any[] = [];
  const tx = {
    $queryRaw: async (strings: TemplateStringsArray) => { sql.push(strings.join('?')); return [{ id: lanTicket.id, status: 'active', title: null }]; },
    turn: { findFirst: async () => null, count: async () => 0, aggregate: async () => ({ _max: { ordinal: null } }),
      create: async ({ data }: any) => { created.push(data); return { id: 'turn', ordinal: data.ordinal }; } },
    conversation: { update: async ({ data }: any) => { created.push(data); } },
  };
  const turns = new TurnRepository({ $transaction: async (fn: any) => fn(tx) } as any);
  await turns.startTurn({ conversationId: lanTicket.id, memberId: MINH.id, userText: 'Ai mở ticket này?', modelId: 'console-agent' });
  assert.equal(created[0].memberId, MINH.id);
  assert.equal(created[1].title, 'Ai mở ticket này?', 'the first question titles the conversation');
  assert.match(sql[0], /subject_kind IS NOT NULL OR actor_id=\?/);
  assert.match(sql[0], /FOR UPDATE/);
  tx.turn.findFirst = async () => ({ id: 'running' }) as any;
  await assert.rejects(turns.startTurn({ conversationId: lanTicket.id, memberId: LAN.id, userText: 'x', modelId: 'm' }),
    (e: unknown) => e instanceof AgentError && e.code === 'turn_in_progress' && e.getStatus() === 409);
  tx.$queryRaw = async () => [];
  await assert.rejects(turns.startTurn({ conversationId: lanOwn.id, memberId: MINH.id, userText: 'x', modelId: 'm' }),
    (e: unknown) => e instanceof AgentError && e.code === 'not_found');

  // The conversation view: each turn with who asked, the question, steering kept apart, the answer, its blocks and sources.
  const at = new Date('2026-11-17T02:50:00Z');
  const source = { n: 1, kind: 'ticket', record_id: TICKET, label: 'Ticket 33333333', quote: 'Hàng giả', call_id: 'c1', tool: 'ticket_get' };
  const row = (extra: any) => ({ conversationId: lanTicket.id, errorCode: null, agentId: 'a1', agentName: 'Console assistant', inputTokens: 10n, outputTokens: 5n,
    costUsd: 0.01, firstTokenMs: 300, provider: 'api.test', eventSeq: 9n, state: null, startedAt: at, ...extra });
  const view = await new ConversationService({ findVisibleWithTurns: async () => ({
    id: lanTicket.id, subjectKind: 'ticket', subjectId: TICKET, title: 'Ai mở ticket này?', lastActivityAt: at,
    turns: [
      row({ id: 't1', memberId: LAN.id, status: 'SUCCEEDED', finishedAt: new Date('2026-11-17T02:50:42Z'), latencyMs: 41_500n, messages: [
        { role: 'USER', blocks: [{ text: 'Ai mở ticket này?', isTerminal: false }] },
        { role: 'USER', blocks: [{ text: 'Chỉ tuần này', isTerminal: false, payload: { steer_id: 's1' } }] },
        { role: 'ASSISTANT', blocks: [{ text: 'Người mua [1].', isTerminal: true, payload: { sources: [source], blocks: [{ type: 'text', markdown: 'Người mua [1].' }] } }] },
      ] }),
      row({ id: 't2', memberId: MINH.id, status: 'FAILED', errorCode: 'agent_failed', state: { wrote: true, sources: [] },
        messages: [{ role: 'USER', blocks: [{ text: 'Còn gì?', isTerminal: false }] }] }),
    ],
  }) } as any, {} as any).get(MINH, lanTicket.id);
  const common = { conversation_id: lanTicket.id, agent: { id: 'a1', name: 'Console assistant' },
    usage: { input_tokens: 10, output_tokens: 5, cost_usd: 0.01, first_token_ms: 300, provider: 'api.test' }, last_seq: 9, created_at: at.toISOString() };
  assert.deepEqual(view, {
    id: lanTicket.id, subject_kind: 'ticket', subject_id: TICKET, title: 'Ai mở ticket này?', updated_at: at.toISOString(),
    turns: [
      { id: 't1', member_id: LAN.id, status: 'SUCCEEDED', text: 'Ai mở ticket này?', answer: 'Người mua [1].', blocks: [{ type: 'text', markdown: 'Người mua [1].' }],
        sources: [source], outcome: null, continuable: false, steers: [{ steer_id: 's1', text: 'Chỉ tuần này' }], ...common,
        finished_at: '2026-11-17T02:50:42.000Z', duration_ms: 41_500 },
      { id: 't2', member_id: MINH.id, status: 'FAILED', text: 'Còn gì?', blocks: [], sources: [], outcome: 'broken', error_code: 'agent_failed',
        continuable: true, steers: [], ...common },
    ],
  });
  console.log('Conversation subject tests passed (shared by subject, own conversations, visibility, member on turns)');
}
main().catch(e => { console.error(e); process.exitCode = 1; });
