import { Injectable, Logger } from '@nestjs/common';
import {
  GetWorkloadAccessTokenCommand,
  GetResourceOauth2TokenCommand,
} from '@aws-sdk/client-bedrock-agentcore';
import { AgentCoreClient } from '../aws/agentcore-client';
import { config } from '../config';

/**
 * AgentCore Identity. Obtains an OAuth2 access token for a downstream resource
 * using the machine-to-machine (2LO) flow, so the agent authenticates as its
 * own workload identity — no human in the loop.
 *
 * Flow: GetWorkloadAccessToken (workload identity token) ->
 *       GetResourceOauth2Token (M2M, against the configured credential provider).
 * The resulting bearer is used to call the Gateway MCP endpoint.
 */
@Injectable()
export class IdentityService {
  private readonly log = new Logger(IdentityService.name);
  private cached?: { token: string; expiresAt: number };
  private readonly ttlMs = 5 * 60 * 1000; // re-fetch every 5 min

  constructor(private readonly aws: AgentCoreClient) {
    if (!this.enabled) {
      this.log.warn(
        'Identity disabled: set AGENTCORE_WORKLOAD_NAME + AGENTCORE_OAUTH_PROVIDER_NAME (npm run setup:identity)',
      );
    }
  }

  get enabled(): boolean {
    return !!config.identity.workload_name && !!config.identity.oauth_provider_name;
  }

  /** OAuth2 bearer for the configured resource, cached briefly. */
  async getResourceToken(): Promise<string | null> {
    if (!this.enabled) return null;
    if (this.cached && this.cached.expiresAt > Date.now()) {
      return this.cached.token;
    }
    try {
      const wl = await this.aws.client.send(
        new GetWorkloadAccessTokenCommand({ workloadName: config.identity.workload_name }),
      );
      const workloadIdentityToken = wl.workloadAccessToken;
      if (!workloadIdentityToken) throw new Error('no workloadAccessToken returned');

      const res = await this.aws.client.send(
        new GetResourceOauth2TokenCommand({
          resourceCredentialProviderName: config.identity.oauth_provider_name,
          oauth2Flow: 'M2M',
          scopes: config.identity.oauth_scopes,
          workloadIdentityToken,
        }),
      );
      if (!res.accessToken) throw new Error('no accessToken returned');

      this.cached = { token: res.accessToken, expiresAt: Date.now() + this.ttlMs };
      this.log.log('fetched OAuth2 resource token (M2M)');
      return res.accessToken;
    } catch (e) {
      this.log.warn(`getResourceToken failed: ${(e as Error).message}`);
      return null;
    }
  }
}
