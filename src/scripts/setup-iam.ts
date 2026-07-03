/**
 * One-time: create the two IAM roles AgentCore assumes, and emit a least-
 * privilege policy for the running app.
 *   1. Memory execution role — lets AgentCore Memory call Bedrock to extract
 *      durable facts from conversations (Bedrock InvokeModel only).
 *   2. Gateway role          — assumed by AgentCore Gateway to reach targets.
 *      A public, no-auth OpenAPI target needs no permissions, so this role gets
 *      an empty policy by default (set GATEWAY_TARGET_USES_SECRETS=1 to allow
 *      reading credential secrets for auth-backed targets).
 *
 *   npm run setup:iam
 *
 * A role has a *trust policy* (who may assume it — the AgentCore service) and a
 * *permission policy* (what it may do once assumed). Roles are created
 * idempotently: re-running reuses an existing role of the same name.
 *
 * Also writes iam/app-runtime-policy.json — the minimal policy the *app's* own
 * credentials need at runtime. Attach it to the IAM user/role the app runs as.
 *
 * Prints the role ARNs to copy into .env. IAM changes take a few seconds to
 * propagate, so wait briefly before running setup:memory / setup:gateway.
 */
import 'dotenv/config';
import * as fs from 'fs';
import * as path from 'path';
import {
  IAMClient,
  CreateRoleCommand,
  PutRolePolicyCommand,
  GetRoleCommand,
} from '@aws-sdk/client-iam';

const AGENTCORE_SERVICE = 'bedrock-agentcore.amazonaws.com';

const TRUST_POLICY = JSON.stringify({
  Version: '2012-10-17',
  Statement: [
    {
      Effect: 'Allow',
      Principal: { Service: AGENTCORE_SERVICE },
      Action: 'sts:AssumeRole',
    },
  ],
});

async function main() {
  const region = process.env.AWS_REGION ?? 'ap-southeast-1';
  const iam = new IAMClient({ region });

  // Memory role: Bedrock model invocation only, scoped to foundation models +
  // inference profiles (no other Bedrock or AgentCore actions).
  const memoryArn = await ensureRole(iam, 'aws-agent-demo-memory-role');
  const account = memoryArn.split(':')[4]; // arn:aws:iam::<account>:role/...
  await putPolicy(iam, 'aws-agent-demo-memory-role', 'memory', {
    Version: '2012-10-17',
    Statement: [
      {
        Sid: 'BedrockExtraction',
        Effect: 'Allow',
        Action: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
        Resource: [
          'arn:aws:bedrock:*::foundation-model/*',
          `arn:aws:bedrock:*:${account}:inference-profile/*`,
        ],
      },
    ],
  });

  // Gateway role: empty by default (public target needs nothing).
  const gatewayArn = await ensureRole(iam, 'aws-agent-demo-gateway-role');
  if (process.env.GATEWAY_TARGET_USES_SECRETS === '1') {
    await putPolicy(iam, 'aws-agent-demo-gateway-role', 'gateway', {
      Version: '2012-10-17',
      Statement: [
        {
          Effect: 'Allow',
          Action: ['secretsmanager:GetSecretValue'],
          Resource: `arn:aws:secretsmanager:${region}:${account}:secret:bedrock-agentcore-*`,
        },
      ],
    });
  }

  const policyPath = writeAppPolicy(region, account);

  console.log('\n=== DONE === add to .env (wait ~10s for IAM to propagate):');
  console.log(`  AGENTCORE_MEMORY_ROLE_ARN=${memoryArn}`);
  console.log(`  AGENTCORE_GATEWAY_ROLE_ARN=${gatewayArn}`);
  console.log(`\nApp runtime policy written to ${policyPath}. Attach it to the`);
  console.log('identity the app runs as, e.g.:');
  console.log(
    `  aws iam put-user-policy --user-name <app-user> --policy-name aws-agent-demo-app --policy-document file://${policyPath}`,
  );
}

/** Create the role if absent, else reuse; returns its ARN. */
async function ensureRole(iam: IAMClient, roleName: string): Promise<string> {
  try {
    const res = await iam.send(
      new CreateRoleCommand({
        RoleName: roleName,
        AssumeRolePolicyDocument: TRUST_POLICY,
        Description: 'aws-agent-demo AgentCore role',
      }),
    );
    console.log(`created role ${roleName}`);
    return res.Role!.Arn!;
  } catch (e: any) {
    if (e?.name !== 'EntityAlreadyExistsException') throw e;
    const res = await iam.send(new GetRoleCommand({ RoleName: roleName }));
    console.log(`role ${roleName} already exists — reusing`);
    return res.Role!.Arn!;
  }
}

async function putPolicy(
  iam: IAMClient,
  roleName: string,
  policyName: string,
  doc: unknown,
): Promise<void> {
  await iam.send(
    new PutRolePolicyCommand({
      RoleName: roleName,
      PolicyName: `aws-agent-demo-${policyName}`,
      PolicyDocument: JSON.stringify(doc),
    }),
  );
}

/**
 * Least-privilege policy for the app's own credentials. Covers exactly what the
 * services call: Bedrock Converse, Memory, Identity (OAuth), Code Interpreter.
 * MCP/Gateway is reached over HTTPS with a bearer token, so it needs no IAM.
 */
function writeAppPolicy(region: string, account: string): string {
  const policy = {
    Version: '2012-10-17',
    Statement: [
      {
        Sid: 'BedrockConverse',
        Effect: 'Allow',
        Action: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
        Resource: [
          'arn:aws:bedrock:*::foundation-model/*',
          `arn:aws:bedrock:*:${account}:inference-profile/*`,
        ],
      },
      {
        Sid: 'AgentCoreMemory',
        Effect: 'Allow',
        Action: [
          'bedrock-agentcore:CreateEvent',
          'bedrock-agentcore:RetrieveMemoryRecords',
          'bedrock-agentcore:ListSessions',
        ],
        Resource: `arn:aws:bedrock-agentcore:${region}:${account}:memory/*`,
      },
      {
        Sid: 'AgentCoreIdentity',
        Effect: 'Allow',
        Action: [
          'bedrock-agentcore:GetWorkloadAccessToken',
          'bedrock-agentcore:GetResourceOauth2Token',
        ],
        // Workload-identity + token-vault ARNs vary; scope to your account once known.
        Resource: '*',
      },
      {
        Sid: 'AgentCoreCodeInterpreter',
        Effect: 'Allow',
        Action: [
          'bedrock-agentcore:StartCodeInterpreterSession',
          'bedrock-agentcore:InvokeCodeInterpreter',
          'bedrock-agentcore:StopCodeInterpreterSession',
        ],
        // Built-in interpreter (aws.codeinterpreter.v1) is AWS-owned; `*` covers it.
        Resource: '*',
      },
    ],
  };
  const dir = path.join(process.cwd(), 'iam');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'app-runtime-policy.json');
  fs.writeFileSync(file, JSON.stringify(policy, null, 2));
  return file;
}

main().catch((e) => {
  console.error('setup:iam failed:', e?.message ?? e);
  process.exit(1);
});
