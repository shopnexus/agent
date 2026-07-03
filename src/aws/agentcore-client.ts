import { Injectable } from '@nestjs/common';
import { BedrockAgentCoreClient } from '@aws-sdk/client-bedrock-agentcore';
import { config } from '../config';

/**
 * Shared AgentCore data-plane client. Memory, Session, Identity and Sandbox
 * services all talk to the same endpoint, so they share one client instance.
 */
@Injectable()
export class AgentCoreClient {
  readonly client = new BedrockAgentCoreClient({ region: config.aws_region });
}
