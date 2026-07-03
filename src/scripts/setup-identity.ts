/**
 * One-time: provision AgentCore Identity for the agent's machine-to-machine
 * (M2M) OAuth flow. Creates:
 *   1. a workload identity (the agent's own identity), and
 *   2. an OAuth2 credential provider pointing at your IdP.
 *
 *   npm run setup:identity
 *
 * Required env (your OAuth2 IdP — e.g. Cognito, Auth0, Okta):
 *   OAUTH_DISCOVERY_URL   OIDC discovery doc, e.g. https://<idp>/.well-known/openid-configuration
 *   OAUTH_CLIENT_ID       M2M (client_credentials) client id
 *   OAUTH_CLIENT_SECRET   M2M client secret
 *
 * Prints the workload + provider names to copy into .env.
 */
import 'dotenv/config';
import {
  BedrockAgentCoreControlClient,
  CreateWorkloadIdentityCommand,
  CreateOauth2CredentialProviderCommand,
} from '@aws-sdk/client-bedrock-agentcore-control';

async function main() {
  const region = process.env.AWS_REGION ?? 'ap-southeast-1';
  const discoveryUrl = required('OAUTH_DISCOVERY_URL');
  const clientId = required('OAUTH_CLIENT_ID');
  const clientSecret = required('OAUTH_CLIENT_SECRET');

  const client = new BedrockAgentCoreControlClient({ region });
  const workloadName = 'aws_agent_demo_workload';
  const providerName = 'aws_agent_demo_oauth';

  console.log(`Creating workload identity "${workloadName}"...`);
  const wl = await client.send(
    new CreateWorkloadIdentityCommand({ name: workloadName }),
  );
  console.log(`  -> ${wl.workloadIdentityArn}`);

  console.log(`Creating OAuth2 credential provider "${providerName}" (CustomOauth2)...`);
  const provider = await client.send(
    new CreateOauth2CredentialProviderCommand({
      name: providerName,
      credentialProviderVendor: 'CustomOauth2',
      oauth2ProviderConfigInput: {
        customOauth2ProviderConfig: {
          clientId,
          clientSecret,
          oauthDiscovery: { discoveryUrl },
        },
      },
    } as any),
  );
  console.log(`  -> ${provider.credentialProviderArn} (status=${provider.status})`);

  console.log('\n=== DONE === add to .env:');
  console.log(`  AGENTCORE_WORKLOAD_NAME=${workloadName}`);
  console.log(`  AGENTCORE_OAUTH_PROVIDER_NAME=${providerName}`);
  console.log('  OAUTH_SCOPES=<space/comma-separated scopes your Gateway expects>');
}

function required(key: string): string {
  const v = process.env[key];
  if (!v) throw new Error(`missing env ${key}`);
  return v;
}

main().catch((e) => {
  console.error('setup:identity failed:', e?.message ?? e);
  process.exit(1);
});
