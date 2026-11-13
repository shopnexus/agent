import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { type Model } from '@strands-agents/sdk';
import { OpenAIModel } from '@strands-agents/sdk/models/openai';
import OpenAI from 'openai';
import { config } from '../config';
import { traceContext } from '../observability/trace-context';
import { errorDetails } from '../observability/error-details';

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

  async classifyJson(
    messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
    signal: AbortSignal,
    diagnostics: { stage?: 'assess' | 'review' } = {},
  ): Promise<string> {
    const started = Date.now();
    const metadata = { ...traceContext(), stage: diagnostics.stage ?? 'classifier', operation: 'classify', model: config.model.id, client_timeout_ms: config.agent.scope_timeout_ms };
    this.log.log(JSON.stringify({ event: 'llm_request_started', ...metadata }));
    try {
      signal.throwIfAborted();
      const client = new OpenAI({
        baseURL: config.litellm.base_url,
        apiKey: config.litellm.api_key || 'sk-local-dev-key',
        maxRetries: 0,
        timeout: metadata.client_timeout_ms,
      });
      const response = await client.chat.completions.create({
        model: config.model.id, messages, max_tokens: 512,
      }, { signal });
      signal.throwIfAborted();
      const text = response.choices[0]?.message.content;
      const finishReason = response.choices[0]?.finish_reason;
      this.log.log(JSON.stringify({
        event: 'llm_request_completed', ...metadata, duration_ms: Date.now() - started,
        ...errorDetails(response), choice_count: response.choices.length, response_chars: text?.length ?? 0,
        finish_reason: finishReason && ['stop', 'length', 'tool_calls', 'content_filter', 'function_call'].includes(finishReason) ? finishReason : undefined
      }));
      if (!text) throw new Error('Empty classifier response');
      return text;
    } catch (error) {
      this.log.warn(JSON.stringify({
        event: 'llm_request_failed', ...metadata, duration_ms: Date.now() - started,
        signal_aborted: signal.aborted, reason: error instanceof Error && error.message === 'Empty classifier response' ? 'empty_response' : undefined,
        ...errorDetails(error)
      }));
      throw error;
    }
  }

  getModel(): Model {
    return this.model;
  }
}

