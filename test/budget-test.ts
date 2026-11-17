/** Offline: LiteLLM's budget error, through the real OpenAI model provider and a fake fetch. */
import assert from 'node:assert/strict';
import { Agent } from '@strands-agents/sdk';
import { OpenAIModel } from '@strands-agents/sdk/models/openai';
import { isBudgetError, ConsoleRetryStrategy } from '../src/llm/budget';

// The body LiteLLM's proxy returns when a key, team or model budget is spent.
const LITELLM_BUDGET = { error: { message: 'Budget has been exceeded! Current cost: 20.0132, Max budget: 20.0', type: 'budget_exceeded', param: null, code: '400' } };

async function providerError(status: number, body: unknown): Promise<unknown> {
  let requests = 0;
  const model = new OpenAIModel({
    api: 'chat', modelId: 'console-agent', apiKey: 'test-key',
    clientConfig: { baseURL: 'http://127.0.0.1:1/v1', maxRetries: 0, fetch: (async () => { requests++; return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }); }) as typeof fetch },
  });
  const agent = new Agent({ model, printer: false, retryStrategy: new ConsoleRetryStrategy() });
  try { await agent.invoke('hello'); } catch (error) { return { error, requests }; }
  assert.fail('the provider error must reach the caller');
}

async function main() {
  const budget = await providerError(400, LITELLM_BUDGET) as { error: unknown; requests: number };
  assert.equal(isBudgetError(budget.error), true, 'LiteLLM budget_exceeded maps to agent_budget');
  assert.equal(budget.requests, 1, 'a spent budget is not retried');

  const other = await providerError(400, { error: { message: 'Invalid model name passed in model=console-agent', type: 'invalid_request_error', code: '400' } }) as { error: unknown };
  assert.equal(isBudgetError(other.error), false);
  const server = await providerError(500, { error: { message: 'Internal Server Error', type: 'internal_error' } }) as { error: unknown };
  assert.equal(isBudgetError(server.error), false);

  // Shapes seen through wrappers: a cause chain, the type alone, a code.
  assert.equal(isBudgetError(Object.assign(new Error('wrapped'), { cause: Object.assign(new Error('x'), { type: 'budget_exceeded' }) })), true);
  assert.equal(isBudgetError({ error: { code: 'budget_exceeded' } }), true);
  assert.equal(isBudgetError(new Error('ExceededBudget: budget exceeded for deployment')), true);
  assert.equal(isBudgetError(new Error('rate limit exceeded')), false);
  assert.equal(isBudgetError(undefined), false);
  console.log('Budget mapping tests passed (LiteLLM body through the provider, no retry, wrappers)');
}
main().catch(e => { console.error(e); process.exitCode = 1; });
