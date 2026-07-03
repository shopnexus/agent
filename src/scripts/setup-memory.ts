/**
 * One-time: create an AgentCore Memory resource and print its id.
 *   npm run setup:memory
 * Put the printed id into .env as AGENTCORE_MEMORY_ID.
 *
 * If AGENTCORE_MEMORY_ROLE_ARN is set, managed extraction strategies
 * (semantic + user-preference) are attached so RetrieveMemoryRecords
 * returns extracted facts. Without a role, raw events are stored only.
 */
import 'dotenv/config';
import {
  BedrockAgentCoreControlClient,
  CreateMemoryCommand,
  ListMemoriesCommand,
  DeleteMemoryCommand,
  waitUntilMemoryCreated,
} from '@aws-sdk/client-bedrock-agentcore-control';

const MEMORY_NAME = 'aws_agent_demo_memory';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const region = process.env.AWS_REGION ?? 'ap-southeast-1';
  const roleArn = process.env.AGENTCORE_MEMORY_ROLE_ARN;
  const client = new BedrockAgentCoreControlClient({ region });

  // Idempotent: CreateMemory requires a unique name, so remove any prior demo
  // memory (e.g. an earlier one created without strategies) before recreating.
  await deleteExistingDemoMemory(client);

  // Namespaces must match what the agent retrieves at runtime: `/facts/{actorId}`.
  // `{actorId}` is a template variable AgentCore fills per event.
  const namespaces = ['/facts/{actorId}'];
  const strategies = roleArn
    ? [
        { semanticMemoryStrategy: { name: 'semantic', namespaces } },
        { userPreferenceMemoryStrategy: { name: 'userPrefs', namespaces } },
      ]
    : undefined;

  console.log(`Creating Memory in ${region}${roleArn ? ' with strategies' : ' (raw events only)'}...`);
  const res = await client.send(
    new CreateMemoryCommand({
      name: MEMORY_NAME,
      description: 'Memory for aws-agent-demo NestJS agent',
      eventExpiryDuration: 30, // days
      ...(roleArn ? { memoryExecutionRoleArn: roleArn } : {}),
      ...(strategies ? { memoryStrategies: strategies } : {}),
    } as any),
  );

  const id = res.memory?.id;
  if (!id) throw new Error('no memory id returned');
  console.log(`memory created: ${id} (status=${res.memory?.status}) — waiting for ACTIVE...`);

  await waitUntilMemoryCreated(
    { client, maxWaitTime: 300 },
    { memoryId: id },
  );

  console.log('\n=== DONE ===');
  console.log(`Add this to .env:\n  AGENTCORE_MEMORY_ID=${id}`);
}

/** Delete any existing demo memory (id starts with the demo name) and wait. */
async function deleteExistingDemoMemory(
  client: BedrockAgentCoreControlClient,
): Promise<void> {
  const ids = await findDemoMemoryIds(client);
  if (!ids.length) return;
  for (const id of ids) {
    console.log(`removing existing memory ${id}...`);
    await client.send(new DeleteMemoryCommand({ memoryId: id }));
  }
  // CreateMemory with the same name fails until the delete fully settles.
  for (let i = 0; i < 30; i++) {
    if (!(await findDemoMemoryIds(client)).length) return;
    await sleep(5000);
  }
  throw new Error('existing memory still deleting after timeout — retry shortly');
}

async function findDemoMemoryIds(
  client: BedrockAgentCoreControlClient,
): Promise<string[]> {
  const ids: string[] = [];
  let nextToken: string | undefined;
  do {
    const page: any = await client.send(
      new ListMemoriesCommand({ maxResults: 100, nextToken } as any),
    );
    for (const m of page.memories ?? []) {
      const id = m.id ?? m.memoryId;
      if (id && String(id).startsWith(`${MEMORY_NAME}-`)) ids.push(id);
    }
    nextToken = page.nextToken;
  } while (nextToken);
  return ids;
}

main().catch((e) => {
  console.error('setup failed:', e?.message ?? e);
  process.exit(1);
});
