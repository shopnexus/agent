import assert from 'node:assert/strict';
import { APIConnectionError, APIConnectionTimeoutError } from 'openai';
import { errorDetails } from '../src/observability/error-details';

// Removing extraction, validation, or traversal bounds must break these tests.
let passed = 0;
function test(name: string, check: () => void) {
  check();
  passed++;
  console.log(`PASS ${name}`);
}

test('extracts only allowlisted metadata from SDK-shaped errors', () => {
  const error = Object.assign(new Error('private prompt and response'), {
    name: 'APIError', code: 'rate_limit_exceeded', status: 429,
    request_id: 'req_123', type: 'rate_limit_error', param: 'messages.0.content',
    body: { prompt: 'private prompt' }, custom: 'private response',
  });
  assert.deepEqual(errorDetails(error), {
    errorName: 'APIError', code: 'rate_limit_exceeded', status: 429,
    requestId: 'req_123', type: 'rate_limit_error', param: 'messages.0.content',
  });
});

test('retains nested cause errno and SDK request ID', () => {
  const error = Object.assign(new Error('wrapper secret'), {
    cause: Object.assign(new Error('network secret'), {
      code: 'ECONNRESET', _request_id: 'req_nested',
      cause: { code: 'ETIMEDOUT', request_id: 'req_deep' },
    }),
  });
  assert.deepEqual(errorDetails(error), {
    errorName: 'Error', cause: {
      errorName: 'Error', code: 'ECONNRESET', requestId: 'req_nested',
      cause: { code: 'ETIMEDOUT', requestId: 'req_deep' },
    },
  });
});

test('supports response status and only approved response headers', () => {
  assert.deepEqual(errorDetails({ response: {
    status: 503, headers: new Headers({
      'x-request-id': 'req_header', 'authorization': 'Bearer secret',
      'x-litellm-call-id': 'call_fallback', 'x-private': 'private payload',
    }), body: 'secret response',
  } }), { status: 503, requestId: 'req_header' });
  assert.deepEqual(errorDetails({ headers: { 'x-litellm-call-id': 'call_123' } }),
    { requestId: 'call_123' });
  assert.deepEqual(errorDetails({ response: { headers: { 'X-Request-ID': 'req_case' } } }),
    { requestId: 'req_case' });
});

test('supports nested OpenAI error type and param without its message', () => {
  assert.deepEqual(errorDetails({ error: {
    code: 'invalid_request', type: 'invalid_request_error', param: 'model',
    message: 'private tool payload',
  } }), { code: 'invalid_request', type: 'invalid_request_error', param: 'model' });
});

test('rejects malicious identifiers without coercion or truncation', () => {
  for (const value of ['sk-secret', 'prefix-sk-secret', 'BearerSecret', 'Bearer secret',
    'has space', 'line\nbreak', 'trailing\n', 'trailing\r\n', 'tab\tvalue', '<script>', '../secret', '',
    'x'.repeat(129), 123, { toString: () => 'req_secret' }]) {
    assert.deepEqual(errorDetails({ name: value, code: value, request_id: value,
      _request_id: value, type: value, param: value,
      headers: { 'x-request-id': value, 'x-litellm-call-id': value } }), {});
  }
  assert.deepEqual(errorDetails({ request_id: 'sk-secret', _request_id: 'req_safe' }),
    { requestId: 'req_safe' });
});

test('accepts only finite integer HTTP statuses', () => {
  for (const status of [0, 99, 600, -1, 429.5, NaN, Infinity, '429', '500 secret',
    { valueOf: () => 500 }]) {
    assert.deepEqual(errorDetails({ status, statusCode: status, response: { status } }), {});
  }
  assert.deepEqual(errorDetails({ statusCode: 502 }), { status: 502 });
});

test('bounds cause traversal to three metadata objects and detects cycles', () => {
  const cycle: Record<string, unknown> = { code: 'ECONNRESET' };
  cycle.cause = cycle;
  assert.deepEqual(errorDetails(cycle), { code: 'ECONNRESET' });
  const a: Record<string, unknown> = { code: 'A' };
  const b: Record<string, unknown> = { code: 'B', cause: a };
  a.cause = b;
  assert.deepEqual(errorDetails(a), { code: 'A', cause: { code: 'B' } });
  assert.deepEqual(errorDetails({ cause: { cause: { code: 'ETIMEDOUT',
    cause: { request_id: 'must_not_reach' } } } }),
  { cause: { cause: { code: 'ETIMEDOUT' } } });
});

test('never serializes messages, stacks, bodies, prompts, keys or custom fields', () => {
  const secret = 'SENSITIVE_DO_NOT_LOG';
  const error = Object.assign(new Error(secret), {
    stack: secret, request: { key: secret }, body: secret, response: { data: secret },
    prompt: secret, toolPayload: secret, apiKey: secret, custom: secret,
    cause: Object.assign(new Error(secret), { response: { body: secret } }),
    toJSON: () => ({ leaked: secret }),
  });
  assert.deepEqual(errorDetails(error), { errorName: 'Error', cause: { errorName: 'Error' } });
  assert(!JSON.stringify(errorDetails(error)).includes(secret));
  for (const value of [secret, null, undefined, 42, true, Symbol('secret')]) {
    assert.deepEqual(errorDetails(value), {});
  }
});

test('does not invoke field getters or throw on hostile objects', () => {
  const hostile = Object.defineProperty({}, 'request_id', {
    get() { throw new Error('getter must not run'); },
  });
  assert.deepEqual(errorDetails(hostile), {});
  assert.deepEqual(errorDetails(new Proxy({}, {
    getOwnPropertyDescriptor() { throw new Error('private'); },
    getPrototypeOf() { throw new Error('private'); },
  })), {});
});

test('reports actual OpenAI connection classes and nested errno without network calls', () => {
  const cause = Object.assign(new Error('private network detail'), { code: 'ECONNRESET' });
  assert.deepEqual(errorDetails(new APIConnectionError({ cause })), {
    errorName: 'APIConnectionError', cause: { errorName: 'Error', code: 'ECONNRESET' },
  });
  const timeout = Object.assign(new APIConnectionTimeoutError(), {
    cause: Object.assign(new Error('private timeout detail'), { code: 'ETIMEDOUT' }),
  });
  assert.deepEqual(errorDetails(timeout), {
    errorName: 'APIConnectionTimeoutError', cause: { errorName: 'Error', code: 'ETIMEDOUT' },
  });
});

test('preserves explicit local error names over constructor names', () => {
  class LocalTimeout extends Error {
    name = 'ScopeTimeoutError';
  }
  assert.deepEqual(errorDetails(new LocalTimeout('private timeout')), {
    errorName: 'ScopeTimeoutError',
  });
});

test('supports the SDK requestID spelling with identifier validation', () => {
  assert.deepEqual(errorDetails({ requestID: 'req_sdk' }), { requestId: 'req_sdk' });
  for (const requestID of ['sk-secret', 'Bearer secret', 'bad\nvalue', 'x'.repeat(129)]) {
    assert.deepEqual(errorDetails({ requestID }), {});
  }
});

test('reads prototype constructors through descriptors without invoking getters', () => {
  let getterCalls = 0;
  const prototype = Object.create(Error.prototype, {
    constructor: { get() { getterCalls++; throw new Error('private constructor'); } },
  });
  assert.deepEqual(errorDetails(Object.create(prototype)), { errorName: 'Error' });
  function SecretConstructor() {}
  Object.defineProperty(SecretConstructor, 'name', {
    get() { getterCalls++; throw new Error('private constructor name'); },
  });
  const otherPrototype = Object.create(Error.prototype, {
    constructor: { value: SecretConstructor },
  });
  assert.deepEqual(errorDetails(Object.create(otherPrototype)), { errorName: 'Error' });
  assert.equal(getterCalls, 0);
});

console.log(`Error details tests passed (${passed} tests)`);
