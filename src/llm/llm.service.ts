import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { type Model } from '@strands-agents/sdk';
import { OpenAIModel } from '@strands-agents/sdk/models/openai';
import { config } from '../config';

/**
 * Provides the Strands model via LiteLLM's OpenAI-compatible proxy.
 * The Agent owns tool-use orchestration; this service only constructs the
 * model provider and hands it over.
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

    this.model = new OpenAIModel({
      api: 'chat',
      modelId: id,
      maxTokens,
      temperature: thinking ? 1 : undefined,
      apiKey: config.litellm.api_key || 'sk-local-dev-key',
      clientConfig: {
        baseURL: config.litellm.base_url,
      },
      // Forward extended thinking as extra params — LiteLLM passes them
      // through to the underlying provider.
      ...(thinking
        ? {
            params: {
              extra_body: {
                thinking: { type: 'enabled', budget_tokens: thinking_budget },
              },
            },
          }
        : {}),
    });
    this.log.log(
      `LiteLLM model ready (url=${config.litellm.base_url} model=${id} maxTokens=${maxTokens}` +
        `${thinking ? ` thinking=${thinking_budget}` : ''})`,
    );
  }

  getModel(): Model {
    return this.model;
  }
}

