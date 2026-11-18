/** Offline: the HTTP surface on 127.0.0.1 with fake services — guard, routes, `{code}` errors. */
import 'reflect-metadata';
import assert from 'node:assert/strict';
import { Logger, Module } from '@nestjs/common';
import { APP_FILTER, NestFactory } from '@nestjs/core';
import { AgentController } from '../src/agent/agent.controller';
import { AgentService } from '../src/agent/agent.service';
import { ConversationService } from '../src/conversation/conversation.service';
import { ConsoleMemberGuard, readConsoleMember, sameSecret } from '../src/console/console-member';
import { AgentError, AgentErrorFilter } from '../src/http/agent-error';
import { config } from '../src/config';
import { ToolCallsController, TurnsController } from '../src/run/turns.controller';
import { TurnActionsService } from '../src/run/turn-actions.service';
import { TurnStreamService } from '../src/run/turn-stream.service';
import { TurnRepository } from '../src/db/turn.repository';
import { DocumentsController } from '../src/documents/documents.controller';
import { DocumentRepository } from '../src/db/document.repository';
import { SkillsController, slugOf } from '../src/skills/skills.controller';
import { SkillRepository } from '../src/db/skill.repository';

const TOKEN = 'service-token-for-tests';
const MEMBER = '11111111-1111-4111-8111-111111111111';
const CONVERSATION = '22222222-2222-4222-8222-222222222222';
const TICKET = '33333333-3333-4333-8333-333333333333';
const TURN = '44444444-4444-4444-8444-444444444444';
const OTHER = '66666666-6666-4666-8666-666666666666';

async function main() {
  Logger.overrideLogger(['fatal']);
  (config.console as { service_token: string }).service_token = TOKEN;

  assert.equal(sameSecret(TOKEN, TOKEN), true);
  assert.equal(sameSecret(TOKEN + 'x', TOKEN), false);
  assert.equal(sameSecret('', ''), false, 'an empty configured token matches nothing');
  const headers = (h: Record<string, string>) => (name: string) => h[name];
  assert.throws(() => readConsoleMember(headers({ authorization: 'Bearer ', 'x-console-member': MEMBER, 'x-console-role': 'admin' }), ''), AgentError);
  assert.deepEqual(readConsoleMember(headers({ authorization: `Bearer ${TOKEN}`, 'x-console-member': MEMBER.toUpperCase(), 'x-console-role': 'admin' })), { id: MEMBER, role: 'admin' });

  const seen: any[] = [];
  const agent = { ask: async (member: any, id: string, body: any) => {
    seen.push({ member, id, body });
    if (body.text === 'budget') throw AgentError.budget();
    if (body.text === 'crash') throw new Error('PRIVATE');
    return { conversation_id: id, turn_id: 't' };
  } };
  const actionCalls: string[] = [];
  const actions = {
    visibleTurn: async (_m: any, id: string) => { if (id !== TURN) throw AgentError.notFound(); return { id }; },
    pause: async (_m: any, id: string) => { actionCalls.push(`pause ${id}`); if (id !== TURN) throw AgentError.turnState(); },
    stop: async (_m: any, id: string) => { actionCalls.push(`stop ${id}`); },
    steer: async (_m: any, id: string, text: unknown) => { actionCalls.push(`steer ${id} ${text}`); return { steer_id: 's1', resumed: false }; },
    continue: async (_m: any, id: string) => { actionCalls.push(`continue ${id}`); },
    end: async (_m: any, id: string) => { actionCalls.push(`end ${id}`); },
    input: async (_m: any, id: string, answers: unknown) => { actionCalls.push(`input ${id} ${JSON.stringify(answers)}`); },
  };
  const streamed: any[] = [];
  const stream = { stream: async (id: string, after: number, send: (e: any) => void) => {
    streamed.push({ id, after });
    send({ seq: after + 1, type: 'turn.started', at: 'now', body: { model: 'console-agent' } });
    send({ seq: after + 2, type: 'turn.finished', at: 'now', body: { status: 'SUCCEEDED' } });
  } };
  const turnRepo = { findToolCall: async (id: string) => id === TURN ? { id, turnId: TURN, toolName: 'ticket_get', status: 'success', input: { ticket_id: TICKET },
    output: '{"ticket":{"id":"x"}}', outputSpilled: false, attempts: 2, createdAt: new Date(0), finishedAt: new Date(5), latencyMs: 5, timing: { queued: 1 } } : null };
  const docRepo = { findVisible: async (id: string) => id === TURN ? { id, conversationId: CONVERSATION, turnId: null, title: 'R', latestVersion: 1, createdBy: MEMBER,
    createdAt: new Date(0), updatedAt: new Date(0), versions: [{ version: 1, title: 'R', sections: [], turnId: null, createdBy: MEMBER, createdAt: new Date(0) }] } : null };
  const skillRows = new Map<string, any>();
  const skillRepo = {
    list: async () => [...skillRows.values()],
    find: async (id: string) => skillRows.get(id) ?? null,
    create: async (createdBy: string, input: any) => { if ([...skillRows.values()].some(s => s.slug === input.slug)) throw AgentError.skillExists();
      const row = { id: TURN, createdBy, ...input, updatedAt: new Date(0) }; skillRows.set(row.id, row); return row; },
    update: async (id: string, input: any) => { const row = { ...skillRows.get(id), ...input }; skillRows.set(id, row); return row; },
    delete: async (id: string) => skillRows.delete(id),
  };
  const conversations = {
    list: async (member: any, filter: any) => { seen.push({ member, filter }); return []; },
    open: async (member: any, subject: any) => { seen.push({ member, subject }); return { id: CONVERSATION, updated_at: 'now' }; },
    get: async (_member: any, id: string) => { if (id !== CONVERSATION) throw AgentError.notFound(); return { id, updated_at: 'now', turns: [] }; },
  };
  @Module({ controllers: [AgentController, TurnsController, ToolCallsController, DocumentsController, SkillsController], providers: [
    { provide: AgentService, useValue: agent }, { provide: ConversationService, useValue: conversations },
    { provide: TurnActionsService, useValue: actions }, { provide: TurnStreamService, useValue: stream },
    { provide: TurnRepository, useValue: turnRepo }, { provide: DocumentRepository, useValue: docRepo }, { provide: SkillRepository, useValue: skillRepo },
    ConsoleMemberGuard, { provide: APP_FILTER, useClass: AgentErrorFilter },
  ] })
  class TestModule {}
  const app = await NestFactory.create(TestModule, { logger: false });
  await app.listen(0, '127.0.0.1');
  const base = await app.getUrl();
  const member = { authorization: `Bearer ${TOKEN}`, 'x-console-member': MEMBER, 'x-console-role': 'moderator', 'content-type': 'application/json' };
  const call = async (method: string, path: string, h: Record<string, string> = member, body?: unknown) => {
    const res = await fetch(base + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : undefined };
  };
  try {
    for (const h of [
      {}, { ...member, authorization: 'Bearer wrong' }, { ...member, authorization: TOKEN },
      { ...member, 'x-console-member': 'not-a-uuid' }, { ...member, 'x-console-role': 'seller' }, { authorization: member.authorization },
    ]) assert.deepEqual(await call('GET', '/conversations', h as Record<string, string>), { status: 401, body: { code: 'unauthorized' } });
    assert.equal(seen.length, 0, 'refused requests reach no service');

    assert.deepEqual(await call('GET', `/conversations?subject_kind=ticket&subject_id=${TICKET}`), { status: 200, body: [] });
    assert.deepEqual(seen.pop(), { member: { id: MEMBER, role: 'moderator' }, filter: { kind: 'ticket', id: TICKET } });
    assert.deepEqual(await call('GET', '/conversations?subject_kind=shop'), { status: 400, body: { code: 'bad_request' } });
    assert.equal((await call('POST', '/conversations', member, { subject_kind: 'account', subject_id: TICKET })).status, 200);
    assert.deepEqual(seen.pop().subject, { kind: 'account', id: TICKET });
    assert.equal((await call('POST', '/conversations', member, {})).status, 200);
    assert.equal(seen.pop().subject, undefined);
    assert.deepEqual(await call('POST', '/conversations', member, { subject_kind: 'ticket' }), { status: 400, body: { code: 'bad_request' } });
    assert.deepEqual(await call('GET', `/conversations/${TICKET}`), { status: 404, body: { code: 'not_found' } });
    assert.equal((await call('GET', `/conversations/${CONVERSATION}`)).status, 200);
    assert.deepEqual(await call('POST', `/conversations/${CONVERSATION}/turns`, member, { text: 'hỏi', agent_config: { alias: 'console-agent' } }),
      { status: 202, body: { conversation_id: CONVERSATION, turn_id: 't' } });
    assert.deepEqual(seen.pop().body, { text: 'hỏi', agent_config: { alias: 'console-agent' } });
    assert.deepEqual(await call('POST', `/conversations/${CONVERSATION}/turns`, member, { text: 'budget' }), { status: 429, body: { code: 'agent_budget' } });
    assert.deepEqual(await call('POST', `/conversations/${CONVERSATION}/turns`, member, { text: 'crash' }), { status: 500, body: { code: 'internal' } });
    assert.deepEqual(await call('GET', '/chat'), { status: 404, body: { code: 'not_found' } }, 'the shopper routes are gone');

    // The event stream: SSE headers, Last-Event-ID as the seq, frames with id = seq.
    const sse = await fetch(`${base}/turns/${TURN}/events`, { headers: { ...member, 'last-event-id': '4' } });
    assert.equal(sse.status, 200);
    assert.match(sse.headers.get('content-type') ?? '', /^text\/event-stream/);
    assert.equal(sse.headers.get('cache-control'), 'no-cache, no-transform');
    const frames = await sse.text();
    assert.ok(frames.includes('id: 5\nevent: turn.started\ndata: {"seq":5,"type":"turn.started","at":"now","model":"console-agent"}\n\n'));
    assert.ok(frames.includes('id: 6\nevent: turn.finished'));
    assert.deepEqual(streamed.pop(), { id: TURN, after: 4 });
    assert.equal((await fetch(`${base}/turns/${TURN}/events?after=2`, { headers: member })).status, 200);
    assert.deepEqual(streamed.pop(), { id: TURN, after: 2 });
    assert.deepEqual(await call('GET', `/turns/${OTHER}/events`), { status: 404, body: { code: 'not_found' } }, 'no stream for a turn the member may not see');
    assert.deepEqual(await call('GET', `/turns/${TURN}/events?after=-1`), { status: 400, body: { code: 'bad_request' } });

    // Controls.
    assert.deepEqual(await call('POST', `/turns/${TURN}/pause`), { status: 202, body: {} });
    assert.deepEqual(await call('POST', `/turns/${OTHER}/pause`), { status: 409, body: { code: 'turn_state' } });
    assert.deepEqual(await call('POST', `/turns/${TURN}/stop`), { status: 202, body: {} });
    assert.deepEqual(await call('POST', `/turns/${TURN}/steer`, member, { text: 'chỉ tuần này' }), { status: 202, body: { steer_id: 's1', resumed: false } });
    assert.deepEqual(await call('POST', `/turns/${TURN}/continue`), { status: 202, body: { turn_id: TURN } });
    assert.deepEqual(await call('POST', `/turns/${TURN}/end`), { status: 200, body: { status: 'CANCELLED' } });
    assert.deepEqual(await call('POST', `/turns/${TURN}/input`, member, { answers: { range: 'd7' } }), { status: 202, body: { turn_id: TURN } });
    assert.deepEqual(actionCalls, [`pause ${TURN}`, `pause ${OTHER}`, `stop ${TURN}`, `steer ${TURN} chỉ tuần này`, `continue ${TURN}`, `end ${TURN}`, `input ${TURN} {"range":"d7"}`]);

    // Tool calls and documents.
    const tc = await call('GET', `/tool-calls/${TURN}`);
    assert.equal(tc.status, 200);
    assert.deepEqual([tc.body.tool, tc.body.attempts, tc.body.output, tc.body.timing], ['ticket_get', 2, { ticket: { id: 'x' } }, { queued: 1 }]);
    assert.deepEqual(await call('GET', `/tool-calls/${OTHER}`), { status: 404, body: { code: 'not_found' } });
    assert.deepEqual(await call('GET', '/tool-calls/x'), { status: 404, body: { code: 'not_found' } });
    const doc = await call('GET', `/documents/${TURN}`);
    assert.deepEqual([doc.status, doc.body.versions.length], [200, 1]);
    assert.deepEqual(await call('GET', `/documents/${OTHER}`), { status: 404, body: { code: 'not_found' } });

    // Skills: shared, created by anyone, changed by their creator or an admin.
    assert.equal(slugOf('Báo cáo lừa đảo tuần'), 'bao-cao-lua-dao-tuan');
    const created = await call('POST', '/skills', member, { name: 'Báo cáo lừa đảo tuần', prompt: 'Đếm báo cáo lừa đảo theo ngày từ {{from}}.', variables: [{ name: 'from', label: 'From' }] });
    assert.equal(created.status, 201);
    assert.deepEqual([created.body.slug, created.body.created_by], ['bao-cao-lua-dao-tuan', MEMBER]);
    assert.deepEqual(await call('POST', '/skills', member, { name: 'Báo cáo lừa đảo tuần', prompt: 'x' }), { status: 409, body: { code: 'skill_exists' } });
    assert.deepEqual(await call('POST', '/skills', member, { name: '', prompt: 'x' }), { status: 400, body: { code: 'bad_request' } });
    assert.equal((await call('GET', '/skills')).body.length, 1);
    const otherMember = { ...member, 'x-console-member': OTHER };
    assert.deepEqual(await call('PATCH', `/skills/${TURN}`, otherMember, { name: 'Mine now' }), { status: 403, body: { code: 'forbidden' } });
    assert.equal((await call('PATCH', `/skills/${TURN}`, { ...otherMember, 'x-console-role': 'admin' }, { name: 'Renamed' })).body.name, 'Renamed');
    assert.deepEqual(await call('DELETE', `/skills/${TURN}`), { status: 204, body: undefined });
    assert.deepEqual(await call('GET', `/skills/${TURN}`), { status: 404, body: { code: 'not_found' } });
  } finally {
    await app.close();
  }
  console.log('HTTP tests passed (service token, member headers, routes, 202 turns, the event stream, controls, tool calls, documents, skills, error codes)');
}
main().catch(e => { console.error(e); process.exitCode = 1; });
