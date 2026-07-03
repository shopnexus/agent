import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { BedrockModel, type Model } from '@strands-agents/sdk';
import { config } from '../config';

/**
 * Provides the Strands model that drives the agent loop. The Strands `Agent`
 * owns tool-use orchestration, so this service only constructs the Bedrock
 * Converse provider and hands it over.
 */
@Injectable()
export class LlmService implements OnModuleInit {
  private readonly log = new Logger(LlmService.name);
  private model!: Model;

  onModuleInit() {
    const { id, max_tokens, thinking_budget } = config.model;
    // Extended thinking needs headroom (budget < maxTokens) and temperature=1.
    const thinking = thinking_budget > 0;
    const maxTokens = thinking ? Math.max(max_tokens, thinking_budget + 1024) : max_tokens;

    this.model = new BedrockModel({
      region: config.aws_region,
      modelId: id,
      maxTokens,
      ...(thinking
        ? {
            temperature: 1,
            additionalRequestFields: {
              thinking: { type: 'enabled', budget_tokens: thinking_budget },
            },
          }
        : {}),
    });
    this.log.log(
      `Bedrock model ready (region=${config.aws_region} model=${id} maxTokens=${maxTokens}` +
        `${thinking ? ` thinking=${thinking_budget}` : ''})`,
    );
  }

  getModel(): Model {
    return this.model;
  }
}
