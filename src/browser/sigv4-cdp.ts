import { SignatureV4 } from '@smithy/signature-v4';
import { HttpRequest } from '@smithy/protocol-http';
import { Sha256 } from '@aws-crypto/sha256-js';
import type { AwsCredentialIdentity, AwsCredentialIdentityProvider, Provider } from '@smithy/types';

interface SignArgs {
  region: string | Provider<string>;
  credentials: AwsCredentialIdentity | AwsCredentialIdentityProvider;
}

/**
 * Sign the AgentCore Browser CDP WebSocket handshake with SigV4.
 *
 * The automation stream is reached with a WebSocket upgrade (an HTTP GET). AWS
 * requires that GET to be SigV4-signed for the `bedrock-agentcore` service.
 * This returns the signed headers to pass to
 * `chromium.connectOverCDP(endpoint, { headers })`.
 *
 * region/credentials are taken from the existing SDK client's config, so no
 * extra credential wiring is needed.
 */
export async function signCdpHeaders(endpoint: string, args: SignArgs): Promise<Record<string, string>> {
  const url = new URL(endpoint);

  const query: Record<string, string> = {};
  url.searchParams.forEach((value, key) => {
    query[key] = value;
  });

  const request = new HttpRequest({
    method: 'GET',
    protocol: 'https:',
    hostname: url.hostname,
    ...(url.port ? { port: Number(url.port) } : {}),
    path: url.pathname,
    query,
    headers: { host: url.host },
  });

  const signer = new SignatureV4({
    service: 'bedrock-agentcore',
    region: args.region,
    credentials: args.credentials,
    sha256: Sha256,
  });

  const signed = await signer.sign(request);
  return signed.headers;
}
