/**
 * One-time: create a Cognito user pool configured for machine-to-machine (M2M)
 * OAuth — the IdP that issues the agent's bearer tokens and that the Gateway
 * trusts for inbound auth. Creates:
 *   1. a user pool,
 *   2. a hosted domain (serves the OAuth token endpoint),
 *   3. a resource server defining the `agent/invoke` scope,
 *   4. an app client with the client_credentials grant (GenerateSecret).
 *
 *   npm run setup:cognito
 *
 * Prints OAUTH_* values to copy into .env. NOTE: each run creates a NEW pool;
 * delete old ones you no longer need. The client secret is sensitive — keep it
 * out of source control.
 */
import 'dotenv/config';
import {
  CognitoIdentityProviderClient,
  CreateUserPoolCommand,
  CreateUserPoolDomainCommand,
  CreateResourceServerCommand,
  CreateUserPoolClientCommand,
} from '@aws-sdk/client-cognito-identity-provider';

async function main() {
  const region = process.env.AWS_REGION ?? 'ap-southeast-1';
  const cognito = new CognitoIdentityProviderClient({ region });

  const resourceServerId = 'agent';
  const scopeName = 'invoke';
  const fullScope = `${resourceServerId}/${scopeName}`;
  // Domain prefix must be globally unique, lowercase, [a-z0-9-].
  const domainPrefix = `aws-agent-demo-${Date.now().toString(36)}`;

  console.log('Creating user pool...');
  const pool = await cognito.send(
    new CreateUserPoolCommand({ PoolName: 'aws-agent-demo' }),
  );
  const userPoolId = pool.UserPool!.Id!;
  console.log(`  -> ${userPoolId}`);

  console.log(`Creating hosted domain "${domainPrefix}"...`);
  await cognito.send(
    new CreateUserPoolDomainCommand({ Domain: domainPrefix, UserPoolId: userPoolId }),
  );

  console.log('Creating resource server + scope...');
  await cognito.send(
    new CreateResourceServerCommand({
      UserPoolId: userPoolId,
      Identifier: resourceServerId,
      Name: 'aws-agent-demo',
      Scopes: [{ ScopeName: scopeName, ScopeDescription: 'Invoke the agent' }],
    }),
  );

  console.log('Creating M2M app client (client_credentials)...');
  const client = await cognito.send(
    new CreateUserPoolClientCommand({
      UserPoolId: userPoolId,
      ClientName: 'aws-agent-demo-m2m',
      GenerateSecret: true,
      AllowedOAuthFlows: ['client_credentials'],
      AllowedOAuthScopes: [fullScope],
      AllowedOAuthFlowsUserPoolClient: true,
      SupportedIdentityProviders: ['COGNITO'],
    }),
  );
  const clientId = client.UserPoolClient!.ClientId!;
  const clientSecret = client.UserPoolClient!.ClientSecret!;

  const discoveryUrl = `https://cognito-idp.${region}.amazonaws.com/${userPoolId}/.well-known/openid-configuration`;
  const tokenEndpoint = `https://${domainPrefix}.auth.${region}.amazoncognito.com/oauth2/token`;

  console.log('\n=== DONE === add to .env:');
  console.log(`  OAUTH_DISCOVERY_URL=${discoveryUrl}`);
  console.log(`  OAUTH_CLIENT_ID=${clientId}`);
  console.log(`  OAUTH_CLIENT_SECRET=${clientSecret}`);
  console.log(`  OAUTH_SCOPES=${fullScope}`);
  console.log(`\n(token endpoint for reference: ${tokenEndpoint})`);
}

main().catch((e) => {
  console.error('setup:cognito failed:', e?.message ?? e);
  process.exit(1);
});
