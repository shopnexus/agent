import { DefaultModelRetryStrategy } from '@strands-agents/sdk';

const BUDGET_MESSAGE = /budget[\s\S]{0,40}exceed|exceed[\s\S]{0,40}budget/i;

function own(value: unknown, key: string): unknown {
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null) return undefined;
  try {
    const d = Object.getOwnPropertyDescriptor(value, key);
    return d && 'value' in d ? d.value : undefined;
  } catch { return undefined; }
}

/**
 * True when the call was refused because a budget is spent: LiteLLM's error
 * type or code `budget_exceeded`, its "Budget has been exceeded" message, or
 * a 402 (status or code), which ai-gateway passes on when OpenRouter's credit
 * or the key's limit there is spent. Walks the cause chain, since the SDK
 * rewraps provider errors.
 */
export function isBudgetError(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current; depth++) {
    const api = own(current, 'error');
    for (const value of [own(current, 'type'), own(current, 'code'), own(api, 'type'), own(api, 'code')]) {
      if (typeof value === 'string' && value.toLowerCase() === 'budget_exceeded') return true;
      if (value === '402' || value === 402) return true;
    }
    if (own(current, 'status') === 402) return true;
    const message = own(current, 'message');
    const apiMessage = own(api, 'message');
    if ((typeof message === 'string' && BUDGET_MESSAGE.test(message)) ||
        (typeof apiMessage === 'string' && BUDGET_MESSAGE.test(apiMessage))) return true;
    current = own(current, 'cause');
  }
  return false;
}

/** The SDK's model retry, except that a spent budget is not retried. */
export class ConsoleRetryStrategy extends DefaultModelRetryStrategy {
  protected override isRetryable(error: Error): boolean {
    return !isBudgetError(error) && super.isRetryable(error);
  }
}
