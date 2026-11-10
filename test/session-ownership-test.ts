import assert from 'node:assert/strict';
import { NotFoundException } from '@nestjs/common';
import type { ActorRepository } from '../src/db/actor.repository';
import { ConversationRepository } from '../src/db/conversation.repository';
import { ConversationService } from '../src/conversation/conversation.service';

const ownedSessionId = '00000000-0000-4000-8000-000000000001';
let lookupCount = 0;
const repository = {
  findByIdForActor: async (conversationId: string, actorId: string) => {
    lookupCount += 1;
    return conversationId === ownedSessionId && actorId === 'actor-a'
      ? {
          id: conversationId,
          actorId,
          context: {},
          status: 'active',
          turnCount: 1,
          createdAt: new Date(0),
          lastActive: new Date(0),
        }
      : null;
  },
} as unknown as ConversationRepository;

const service = new ConversationService(repository, {} as ActorRepository);

async function expectSessionNotFound(actorId: string, conversationId: string): Promise<void> {
  await assert.rejects(
    service.assertOwnedConversation(actorId, conversationId),
    (error: unknown) => error instanceof NotFoundException,
  );
}

async function main(): Promise<void> {
  await service.assertOwnedConversation('actor-a', ownedSessionId);
  assert.equal(lookupCount, 1, 'owner session is found through actor-scoped repository lookup');

  await expectSessionNotFound('actor-b', ownedSessionId);
  await expectSessionNotFound('actor-a', '00000000-not-a-uuid');
  await expectSessionNotFound('actor-a', '00000000-0000-4000-8000-000000000002');
  assert.equal(lookupCount, 3, 'malformed UUID is rejected before querying the repository');

  console.log('Session ownership tests passed');
}

void main();
