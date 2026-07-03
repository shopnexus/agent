/**
 * One-time: provision an AgentCore Gateway (MCP protocol) plus one tool target.
 *   1. CreateGateway   — MCP endpoint, CUSTOM_JWT inbound auth against your IdP.
 *   2. CreateGatewayTarget — exposes a public OpenAPI (Open-Meteo forecast) as
 *      an MCP tool, so no Lambda is needed for the demo.
 *
 *   npm run setup:gateway
 *
 * Required env:
 *   AGENTCORE_GATEWAY_ROLE_ARN  IAM role the Gateway assumes. Trust principal
 *                               bedrock-agentcore.amazonaws.com; grant the
 *                               permissions the Gateway needs to reach targets.
 *   OAUTH_DISCOVERY_URL         OIDC discovery doc of the IdP issuing inbound JWTs.
 *   OAUTH_CLIENT_ID             client id allowed to call the Gateway.
 *
 * Prints AGENTCORE_GATEWAY_URL to copy into .env.
 */
import 'dotenv/config';
import {
  BedrockAgentCoreControlClient,
  CreateGatewayCommand,
  GetGatewayCommand,
  CreateGatewayTargetCommand,
} from '@aws-sdk/client-bedrock-agentcore-control';

// Minimal OpenAPI 3 spec for one public, no-auth endpoint.
const OPENAPI_SPEC = JSON.stringify({
  openapi: '3.0.0',
  info: { title: 'Open-Meteo', version: '1.0.0' },
  servers: [{ url: 'https://api.open-meteo.com' }],
  paths: {
    '/v1/forecast': {
      get: {
        operationId: 'getForecast',
        description: 'Current weather forecast for a latitude/longitude.',
        parameters: [
          { name: 'latitude', in: 'query', required: true, schema: { type: 'number' } },
          { name: 'longitude', in: 'query', required: true, schema: { type: 'number' } },
          { name: 'current_weather', in: 'query', schema: { type: 'boolean' } },
        ],
        responses: { '200': { description: 'forecast' } },
      },
    },
  },
});

async function main() {
  const region = process.env.AWS_REGION ?? 'ap-southeast-1';
  const roleArn = required('AGENTCORE_GATEWAY_ROLE_ARN');
  const discoveryUrl = required('OAUTH_DISCOVERY_URL');
  const clientId = required('OAUTH_CLIENT_ID');

  const client = new BedrockAgentCoreControlClient({ region });

  console.log('Creating Gateway (MCP, CUSTOM_JWT)...');
  const gw = await client.send(
    new CreateGatewayCommand({
      name: 'aws-agent-demo-gw',
      protocolType: 'MCP',
      authorizerType: 'CUSTOM_JWT',
      authorizerConfiguration: {
        customJWTAuthorizer: { discoveryUrl, allowedClients: [clientId] },
      },
      roleArn,
    } as any),
  );
  const gatewayId = gw.gatewayId!;
  console.log(`  -> ${gw.gatewayArn}`);

  await waitReady(client, gatewayId);

  console.log('Creating Gateway target (OpenAPI: Open-Meteo)...');
  await client.send(
    new CreateGatewayTargetCommand({
      gatewayIdentifier: gatewayId,
      name: 'open-meteo',
      targetConfiguration: {
        mcp: { openApiSchema: { inlinePayload: OPENAPI_SPEC } },
      },
      // Public no-auth API: no outbound credential provider. If your target
      // needs auth, add one credentialProviderConfigurations entry (API_KEY /
      // OAUTH / GATEWAY_IAM_ROLE).
    } as any),
  );

  console.log('\n=== DONE === add to .env:');
  console.log(`  AGENTCORE_GATEWAY_URL=${gw.gatewayUrl}`);
}

async function waitReady(
  client: BedrockAgentCoreControlClient,
  gatewayId: string,
): Promise<void> {
  for (let i = 0; i < 30; i++) {
    const res = await client.send(new GetGatewayCommand({ gatewayIdentifier: gatewayId }));
    if (res.status === 'READY') return;
    if (res.status === 'FAILED') {
      throw new Error(`gateway failed: ${(res.statusReasons ?? []).join('; ')}`);
    }
    await sleep(5000);
  }
  throw new Error('gateway not READY after timeout');
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function required(key: string): string {
  const v = process.env[key];
  if (!v) throw new Error(`missing env ${key}`);
  return v;
}

main().catch((e) => {
  console.error('setup:gateway failed:', e?.message ?? e);
  process.exit(1);
});
