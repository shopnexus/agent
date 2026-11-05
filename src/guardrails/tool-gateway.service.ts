import { Injectable, Logger } from '@nestjs/common';
import { AuditLogService } from './audit-log.service';
import { TOOL_SCHEMAS, ALLOWED_TOOLS, ToolName } from './tool-schemas';
import { FeatureFlags } from './feature-flags';
import { randomUUID } from 'crypto';

export class ToolGatewayError extends Error {
  constructor(public readonly reason: string, public readonly code: 'NOT_ALLOWED' | 'SCHEMA_INVALID' | 'AUTHZ_DENIED' | 'TIMEOUT' | 'SIZE_EXCEEDED') {
    super(reason);
    this.name = 'ToolGatewayError';
  }
}

export interface GatewaySession {
  sessionId: string;
  actorId: string;  // trusted identity propagated by the API Gateway
  userType: 'authenticated' | 'anonymous';
}

const TIMEOUT_MS = 30_000;

@Injectable()
export class ToolGatewayService {
  private readonly log = new Logger(ToolGatewayService.name);

  constructor(private readonly audit: AuditLogService) {}

  /**
   * Validate and execute a tool call through the gateway.
   * This wraps the actual MCP tool call with:
   * 1. Allowlist check
   * 2. Schema validation (Zod)
   * 3. AuthZ enforcement
   * 4. Result size capping
   * 5. Timeout
   * 6. Audit logging
   */
  async call<T>(
    toolName: string,
    rawInput: Record<string, unknown>,
    session: GatewaySession,
    executor: (validatedInput: Record<string, unknown>) => Promise<T>,
  ): Promise<T> {
    const traceId = randomUUID();
    const start = Date.now();

    // 1. Allowlist check
    if (!ALLOWED_TOOLS.has(toolName)) {
      this.audit.write({ trace_id: traceId, session_id: session.sessionId, actor_id: session.actorId, user_type: session.userType, event: 'tool_call', tool: toolName, status: 'blocked', block_reason: 'NOT_ALLOWED', ts: new Date().toISOString() });
      throw new ToolGatewayError(`Tool "${toolName}" is not allowed`, 'NOT_ALLOWED');
    }

    // 2. Schema validation
    const schema = TOOL_SCHEMAS[toolName as ToolName];
    const parsed = schema.safeParse(rawInput);
    if (!parsed.success) {
      const reason = parsed.error.issues.map(i => i.message).join('; ');
      this.audit.write({ trace_id: traceId, session_id: session.sessionId, actor_id: session.actorId, user_type: session.userType, event: 'tool_call', tool: toolName, status: 'blocked', block_reason: `SCHEMA: ${reason}`, ts: new Date().toISOString() });
      throw new ToolGatewayError(`Invalid input: ${reason}`, 'SCHEMA_INVALID');
    }

    const validatedInput = parsed.data as Record<string, unknown>;

    // 3. AuthZ: get_order requires authenticated user & feature flag enabled
    if (toolName === 'get_order') {
      if (!FeatureFlags.isOrderStatusEnabled) {
        this.audit.write({ trace_id: traceId, session_id: session.sessionId, actor_id: session.actorId, user_type: session.userType, event: 'tool_call', tool: toolName, status: 'blocked', block_reason: 'FEATURE_DISABLED: get_order', ts: new Date().toISOString() });
        throw new ToolGatewayError('Tính năng tra cứu đơn hàng tạm thời đang tắt.', 'NOT_ALLOWED');
      }
      if (session.userType !== 'authenticated' || typeof session.actorId !== 'string' || !session.actorId.trim()) {
        this.audit.write({ trace_id: traceId, session_id: session.sessionId, actor_id: session.actorId, user_type: session.userType, event: 'tool_call', tool: toolName, status: 'blocked', block_reason: 'AUTHZ_DENIED: not authenticated', ts: new Date().toISOString() });
        throw new ToolGatewayError('Bạn cần đăng nhập để tra cứu đơn hàng.', 'AUTHZ_DENIED');
      }
    }

    // 4. Execute with timeout
    let result: T;
    try {
      result = await Promise.race([
        executor(validatedInput),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new ToolGatewayError('Tool call timed out', 'TIMEOUT')), TIMEOUT_MS)
        ),
      ]);
    } catch (e) {
      const latencyMs = Date.now() - start;
      if (e instanceof ToolGatewayError) {
        this.audit.write({ trace_id: traceId, session_id: session.sessionId, actor_id: session.actorId, user_type: session.userType, event: 'tool_call', tool: toolName, input_masked: sanitizeInput(validatedInput), latency_ms: latencyMs, status: 'error', block_reason: e.reason, ts: new Date().toISOString() });
        throw e;
      }
      this.audit.write({ trace_id: traceId, session_id: session.sessionId, actor_id: session.actorId, user_type: session.userType, event: 'tool_call', tool: toolName, input_masked: sanitizeInput(validatedInput), latency_ms: latencyMs, status: 'error', block_reason: (e as Error).message, ts: new Date().toISOString() });
      throw e;
    }

    const latencyMs = Date.now() - start;

    // 5. Cap search results
    if (toolName === 'search_products' && result && typeof result === 'object' && 'products' in (result as object)) {
      const r = (result as unknown) as { products: unknown[]; totalMatches: number; returned: number };
      if (r.products.length > 10) r.products = r.products.slice(0, 10);
      r.returned = r.products.length;
    }

    // 6. Audit success
    this.audit.write({
      trace_id: traceId,
      session_id: session.sessionId,
      actor_id: session.actorId,
      user_type: session.userType,
      event: 'tool_call',
      tool: toolName,
      input_masked: sanitizeInput(validatedInput),
      output_summary: summarize(result),
      latency_ms: latencyMs,
      status: 'ok',
      ts: new Date().toISOString(),
    });

    return result;
  }

  /**
   * Validate a tool call (allowlist + schema + authZ) WITHOUT executing it.
   * Used by BeforeToolCallEvent hook to gate execution before the SDK calls the tool.
   * Throws ToolGatewayError on any violation.
   */
  async validate(
    toolName: string,
    rawInput: Record<string, unknown>,
    session: GatewaySession,
  ): Promise<void> {
    const traceId = randomUUID();

    // 1. Allowlist
    if (!ALLOWED_TOOLS.has(toolName)) {
      this.audit.write({ trace_id: traceId, session_id: session.sessionId, actor_id: session.actorId, user_type: session.userType, event: 'tool_call', tool: toolName, status: 'blocked', block_reason: 'NOT_ALLOWED', ts: new Date().toISOString() });
      throw new ToolGatewayError(`Tool "${toolName}" is not allowed`, 'NOT_ALLOWED');
    }

    // 2. Schema
    const schema = TOOL_SCHEMAS[toolName as ToolName];
    const parsed = schema.safeParse(rawInput);
    if (!parsed.success) {
      const reason = parsed.error.issues.map(i => i.message).join('; ');
      this.audit.write({ trace_id: traceId, session_id: session.sessionId, actor_id: session.actorId, user_type: session.userType, event: 'tool_call', tool: toolName, status: 'blocked', block_reason: `SCHEMA: ${reason}`, ts: new Date().toISOString() });
      throw new ToolGatewayError(`Invalid input: ${reason}`, 'SCHEMA_INVALID');
    }

    // 3. AuthZ
    if (toolName === 'get_order') {
      if (!FeatureFlags.isOrderStatusEnabled) {
        this.audit.write({ trace_id: traceId, session_id: session.sessionId, actor_id: session.actorId, user_type: session.userType, event: 'tool_call', tool: toolName, status: 'blocked', block_reason: 'FEATURE_DISABLED: get_order', ts: new Date().toISOString() });
        throw new ToolGatewayError('Tính năng tra cứu đơn hàng tạm thời đang tắt.', 'NOT_ALLOWED');
      }
      if (session.userType !== 'authenticated' || typeof session.actorId !== 'string' || !session.actorId.trim()) {
        this.audit.write({ trace_id: traceId, session_id: session.sessionId, actor_id: session.actorId, user_type: session.userType, event: 'tool_call', tool: toolName, status: 'blocked', block_reason: 'AUTHZ_DENIED: not authenticated', ts: new Date().toISOString() });
        throw new ToolGatewayError('Bạn cần đăng nhập để tra cứu đơn hàng.', 'AUTHZ_DENIED');
      }
    }
  }
}

function sanitizeInput(input: Record<string, unknown>): Record<string, unknown> {
  // Remove any accidentally injected sensitive fields
  const { actorId, actor_id, ...safe } = input as Record<string, unknown>;
  void actorId; void actor_id;
  return safe;
}

function summarize(result: unknown): string {
  const s = JSON.stringify(result);
  return s.length > 200 ? s.slice(0, 200) + '…' : s;
}
