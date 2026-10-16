import { Injectable, Logger } from '@nestjs/common';
import OpenAI from 'openai';
import { config } from '../config';

@Injectable()
export class EmbeddingService {
  private readonly log = new Logger(EmbeddingService.name);
  private readonly client: OpenAI;

  constructor() {
    this.client = new OpenAI({
      baseURL: config.litellm.base_url,
      apiKey: config.litellm.api_key || 'sk-dummy-key',
    });
  }

  /**
   * Generates a 768-dimensional embedding vector for the given text via LiteLLM.
   */
  async embed(text: string): Promise<number[]> {
    try {
      const sanitized = text.replace(/\n+/g, ' ').trim();
      const res = await this.client.embeddings.create({
        model: config.embedding.model_id,
        input: sanitized,
      });
      return res.data[0].embedding;
    } catch (err) {
      this.log.error(`Embedding generation failed: ${(err as Error).message}`);
      throw err;
    }
  }
}
