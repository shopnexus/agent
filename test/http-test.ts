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

const TOKEN = 'service-token-for-tests';
const MEMBER = '11111111-1111-4111-8111-111111111111';
const CONVERSATION = '22222222-2222-4222-8222-222222222222';
const TICKET = '33333333-3333-4333-8333-333333333333';

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
  const agent = { ask: async (member: any, id: string, text: unknown) => {
    seen.push({ member, id, text });
    if (text === 'budget') throw AgentError.budget();
    if (text === 'crash') throw new Error('PRIVATE');
    return { conversation_id: id, turn_id: 't', answer: 'a', sources: [] };
  } };
  const conversations = {
    list: async (member: any, filter: any) => { seen.push({ member, filter }); return []; },
    open: async (member: any, subject: any) => { seen.push({ member, subject }); return { id: CONVERSATION, updated_at: 'now' }; },
    get: async (_member: any, id: string) => { if (id !== CONVERSATION) throw AgentError.notFound(); return { id, updated_at: 'now', turns: [] }; },
  };
  @Module({ controllers: [AgentController], providers: [
    { provide: AgentService, useValue: agent }, { provide: ConversationService, useValue: conversations },
    ConsoleMemberGuard, { provide: APP_FILTER, useClass: AgentErrorFilter },
  ] })
  class TestModule {}
  const app = await NestFactory.create(TestModule, { logger: false });
  await app.listen(0, '127.0.0.1');
  const base = await app.getUrl();
  const member = { authorization: `Bearer ${TOKEN}`, 'x-console-member': MEMBER, 'x-console-role': 'moderator', 'content-type': 'application/json' };
  const call = async (method: string, path: string, h: Record<string, string> = member, body?: unknown) => {
    const res = await fetch(base + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
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
    assert.deepEqual(await call('POST', `/conversations/${CONVERSATION}/turns`, member, { text: 'hỏi' }),
      { status: 200, body: { conversation_id: CONVERSATION, turn_id: 't', answer: 'a', sources: [] } });
    assert.deepEqual(await call('POST', `/conversations/${CONVERSATION}/turns`, member, { text: 'budget' }), { status: 429, body: { code: 'agent_budget' } });
    assert.deepEqual(await call('POST', `/conversations/${CONVERSATION}/turns`, member, { text: 'crash' }), { status: 500, body: { code: 'internal' } });
    assert.deepEqual(await call('GET', '/chat'), { status: 404, body: { code: 'not_found' } }, 'the shopper routes are gone');
  } finally {
    await app.close();
  }
  console.log('HTTP tests passed (service token, member headers, routes, error codes)');
}
main().catch(e => { console.error(e); process.exitCode = 1; });
