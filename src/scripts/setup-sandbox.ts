/**
 * One-time: create a custom AgentCore Code Interpreter with PUBLIC network mode
 * (full outbound internet) and print its id.
 *   npm run setup:sandbox
 * Put the printed id into .env as AGENTCORE_CODE_INTERPRETER_ID.
 *
 * Why: the built-in `aws.codeinterpreter.v1` runs in SANDBOX mode — S3 + DNS
 * resolution only, no public internet. A custom interpreter with
 * networkMode=PUBLIC lets the `run_code` tool reach the internet. The runtime
 * needs no code change: SandboxService reads the id from config.
 *
 * No execution role is attached by default (the code only needs internet, not
 * AWS resources). Set AGENTCORE_CODE_INTERPRETER_ROLE_ARN to attach one if the
 * sandboxed code must also reach AWS services such as S3.
 *
 * SECURITY: PUBLIC = unrestricted outbound egress from the sandbox. Code the
 * agent runs can reach any host — a data-exfiltration surface. AgentCore PUBLIC
 * mode has no domain allowlist; use VPC network mode or the Policy service to
 * constrain egress.
 */
import 'dotenv/config';
import {
  BedrockAgentCoreControlClient,
  CreateCodeInterpreterCommand,
  ListCodeInterpretersCommand,
  DeleteCodeInterpreterCommand,
} from '@aws-sdk/client-bedrock-agentcore-control';

const CI_NAME = 'aws_agent_demo_ci_public';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const region = process.env.AWS_REGION ?? 'ap-southeast-1';
  const roleArn = process.env.AGENTCORE_CODE_INTERPRETER_ROLE_ARN; // optional
  const client = new BedrockAgentCoreControlClient({ region });

  // Idempotent: CreateCodeInterpreter requires a unique name, so remove any
  // prior demo interpreter (e.g. from an earlier run) before recreating.
  await deleteExistingDemoInterpreters(client);

  console.log(
    `Creating PUBLIC Code Interpreter in ${region}` +
      `${roleArn ? ' with execution role' : ' (internet only, no role)'}...`,
  );
  const res: any = await client.send(
    new CreateCodeInterpreterCommand({
      name: CI_NAME,
      description: 'aws-agent-demo custom Code Interpreter with public internet access',
      networkConfiguration: { networkMode: 'PUBLIC' },
      ...(roleArn ? { executionRoleArn: roleArn } : {}),
    } as any),
  );

  const id = res.codeInterpreterId ?? res.codeInterpreter?.codeInterpreterId;
  if (!id) throw new Error('no codeInterpreterId returned from CreateCodeInterpreter');

  console.log(`code interpreter created: ${id} (status=${res.status ?? 'CREATING'})`);
  console.log('\n=== DONE === (may take a few seconds to become ACTIVE)');
  console.log('Replace the built-in id in .env with:');
  console.log(`  AGENTCORE_CODE_INTERPRETER_ID=${id}`);
}

/** Delete any existing demo interpreter (name/id matches our demo) and wait. */
async function deleteExistingDemoInterpreters(
  client: BedrockAgentCoreControlClient,
): Promise<void> {
  const ids = await findDemoInterpreterIds(client);
  if (!ids.length) return;
  for (const id of ids) {
    console.log(`removing existing code interpreter ${id}...`);
    try {
      await client.send(new DeleteCodeInterpreterCommand({ codeInterpreterId: id } as any));
    } catch (e: any) {
      console.log(`  (delete ${id} failed: ${e?.message ?? e})`);
    }
  }
  // CreateCodeInterpreter with the same name fails until the delete settles.
  for (let i = 0; i < 30; i++) {
    if (!(await findDemoInterpreterIds(client)).length) return;
    await sleep(5000);
  }
  console.log('(existing interpreter still deleting — continuing; create may fail on a duplicate name)');
}

/** List custom interpreters whose name/id matches our demo. Best-effort: if the
 *  list shape differs across SDK versions, skip cleanup rather than crash. */
async function findDemoInterpreterIds(
  client: BedrockAgentCoreControlClient,
): Promise<string[]> {
  const ids: string[] = [];
  let nextToken: string | undefined;
  try {
    do {
      const page: any = await client.send(
        new ListCodeInterpretersCommand({ maxResults: 100, nextToken } as any),
      );
      const items = page.codeInterpreterSummaries ?? page.items ?? page.codeInterpreters ?? [];
      for (const ci of items) {
        const id = ci.codeInterpreterId ?? ci.id;
        const name = ci.name ?? '';
        // Custom ids look like "<name>-<suffix>"; never matches the AWS built-in.
        if (id && (name === CI_NAME || String(id).startsWith(`${CI_NAME}-`))) ids.push(id);
      }
      nextToken = page.nextToken;
    } while (nextToken);
  } catch (e: any) {
    console.log(`(list interpreters skipped: ${e?.message ?? e})`);
  }
  return ids;
}

main().catch((e) => {
  console.error('setup:sandbox failed:', e?.message ?? e);
  process.exit(1);
});
