export interface ErrorDetails {
  errorName?: string;
  code?: string;
  status?: number;
  requestId?: string;
  type?: string;
  param?: string;
  cause?: ErrorDetails;
}

// Never enumerate/copy an error, coerce values, or invoke its accessors.
function field(value: unknown, key: string): unknown {
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null) return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && 'value' in descriptor ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

function identifier(value: unknown, max = 64): string | undefined {
  if (typeof value !== 'string' || value.length > max ||
    !/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(value) ||
    /sk-|bearer/i.test(value) || value.includes('..')) return undefined;
  return value;
}

function errorName(value: object): string | undefined {
  // Explicit local names win. SDK subclasses often inherit only the generic
  // Error.name, so retain their nearest safe prototype constructor name.
  const ownName = identifier(field(value, 'name'));
  if (ownName) return ownName;
  let current: object | null = value;
  let className: string | undefined;
  for (let depth = 0; current && depth < 8; depth++) {
    if (depth > 0) {
      const constructor = field(current, 'constructor');
      const candidate = typeof constructor === 'function'
        ? identifier(field(constructor, 'name')) : undefined;
      if (!className && candidate && candidate !== 'Object') className = candidate;
      const name = identifier(field(current, 'name'));
      if (name) return name === 'Error' ? className ?? name : name;
    }
    try {
      current = Object.getPrototypeOf(current);
    } catch {
      break;
    }
  }
  return className;
}

function httpStatus(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) &&
    value >= 100 && value <= 599 ? value : undefined;
}

function headerId(headers: unknown, name: 'x-request-id' | 'x-litellm-call-id'): string | undefined {
  // Use the native implementation, not a potentially arbitrary headers.get.
  try {
    const id = identifier(Headers.prototype.get.call(headers, name), 128);
    if (id) return id;
  } catch {
    // SDKs may also expose plain header records.
  }
  const title = name === 'x-request-id' ? 'X-Request-ID' : 'X-LiteLLM-Call-ID';
  return identifier(field(headers, name), 128) ??
    identifier(field(headers, title), 128) ??
    identifier(field(headers, name.toUpperCase()), 128);
}

/** Allowlisted metadata only; at most three objects including the root cause wrapper. */
export function errorDetails(error: unknown): ErrorDetails {
  const seen = new Set<object>();
  function extract(value: unknown, depth: number): ErrorDetails {
    if (typeof value !== 'object' || value === null || seen.has(value) || depth >= 3) return {};
    seen.add(value);
    const details: ErrorDetails = {};
    const response = field(value, 'response');
    const apiError = field(value, 'error');
    const name = errorName(value);
    const code = identifier(field(value, 'code')) ?? identifier(field(apiError, 'code'));
    const status = httpStatus(field(value, 'status')) ??
      httpStatus(field(value, 'statusCode')) ?? httpStatus(field(response, 'status'));
    const requestId = identifier(field(value, 'request_id'), 128) ??
      identifier(field(value, '_request_id'), 128) ??
      identifier(field(value, 'requestID'), 128) ??
      headerId(field(value, 'headers'), 'x-request-id') ??
      headerId(field(response, 'headers'), 'x-request-id') ??
      headerId(field(value, 'headers'), 'x-litellm-call-id') ??
      headerId(field(response, 'headers'), 'x-litellm-call-id');
    const type = identifier(field(value, 'type')) ?? identifier(field(apiError, 'type'));
    const param = identifier(field(value, 'param')) ?? identifier(field(apiError, 'param'));
    if (name) details.errorName = name;
    if (code) details.code = code;
    if (status !== undefined) details.status = status;
    if (requestId) details.requestId = requestId;
    if (type) details.type = type;
    if (param) details.param = param;
    const cause = extract(field(value, 'cause'), depth + 1);
    if (Object.keys(cause).length) details.cause = cause;
    return details;
  }
  return extract(error, 0);
}
