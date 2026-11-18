import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { type Model } from '@strands-agents/sdk';
import { OpenAIModel } from '@strands-agents/sdk/models/openai';
import { config } from '../config';

export interface ModelOptions {
  /** The LiteLLM alias; agent_config.alias, else AGENT_MODEL_ID. */
  alias?: string;
  /** The console member, sent as `user` so LiteLLM applies their end-user budget. */
  user: string;
  maxTokens?: number;
  /** The fetch the OpenAI client uses (LiteLLM headers, rate-limit waits). */
  fetch?: typeof fetch;
}

/**
 * Builds the Strands model for a run, on LiteLLM's OpenAI-compatible proxy.
 * One model per run, so each run carries its own alias, member and fetch.
 */
@Injectable()
export class LlmService implements OnModuleInit {
  private readonly log = new Logger(LlmService.name);

  onModuleInit() {
    this.log.log(`LiteLLM at ${config.litellm.base_url}, default alias ${config.model.id || '(none)'}`);
  }

  createModel(options: ModelOptions): Model {
    const { id, max_tokens, thinking_budget } = config.model;
    // Extended thinking needs headroom (budget < maxTokens) and temperature=1.
    const thinking = thinking_budget > 0;
    const base = options.maxTokens ?? max_tokens;
    const maxTokens = thinking ? Math.max(base, thinking_budget + 1024) : base;
    return new OpenAIModel({
      api: 'chat',
      modelId: options.alias || id,
      maxTokens,
      temperature: thinking ? 1 : undefined,
      apiKey: config.litellm.api_key || 'sk-local-dev-key',
      clientConfig: {
        baseURL: config.litellm.base_url,
        ...(options.fetch ? { fetch: options.fetch } : {}),
      },
      params: {
        user: options.user,
        // LiteLLM passes extended thinking through to the provider.
        ...(thinking ? { extra_body: { thinking: { type: 'enabled', budget_tokens: thinking_budget } } } : {}),
      },
    });
  }
}
