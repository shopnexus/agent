import { Injectable, Logger } from '@nestjs/common';
import { scanAndMaskPii } from './pii-utils';
import { traceContext } from '../observability/trace-context';

export interface AuditEvent {
  trace_id: string;
  conversation_id: string;
  actor_id: string;
  user_type: 'authenticated' | 'anonymous';
  event: 'tool_call' | 'input_blocked' | 'output_modified' | 'handoff' | 'rate_limited' | 'loop_detected' | 'turn_timeout' | 'turn_error';
  tool?: string;
  input_masked?: Record<string, unknown>;
  output_summary?: string;
  latency_ms?: number;
  status: 'ok' | 'blocked' | 'error' | 'modified';
  block_reason?: string;
  ts: string;
}

@Injectable()
export class AuditLogService {
  private readonly log = new Logger('AuditLog');

  write(event: AuditEvent): void {
    // Mask any PII that slipped through in string fields
    const safe = this.deepMask(event) as Record<string,unknown>;
    // Server-owned internal IDs must survive broad PII patterns unchanged.
    // Merge only this allowlisted context after masking user-derived fields.
    this.log.log(JSON.stringify({...safe,...traceContext()}));
  }

  private deepMask(obj: unknown): unknown {
    if (typeof obj === 'string') return scanAndMaskPii(obj).masked;
    if (Array.isArray(obj)) return obj.map(v => this.deepMask(v));
    if (obj !== null && typeof obj === 'object') {
      return Object.fromEntries(
        Object.entries(obj as Record<string, unknown>).map(([k, v]) => [k, this.deepMask(v)])
      );
    }
    return obj;
  }
}
