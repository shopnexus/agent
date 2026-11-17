import { Injectable } from '@nestjs/common';
import { AuditLogService } from './audit-log.service';
import { randomUUID } from 'crypto';

export interface InputGuardResult {
  allowed: boolean;
  sanitizedText: string;
  blockedReason?: 'EMPTY_INPUT' | 'LENGTH_EXCEEDED' | 'PROMPT_INJECTION';
}

const MAX_INPUT_LENGTH = 2000;

// High-confidence attempts to override the agent's instructions.
const INJECTION_PATTERNS = [
  /ignore\s+(all\s+)?(previous|prior|above)\s+(instructions|prompts|rules)/i,
  /bỏ\s*qua\s*(tất\s*cả\s*)?(hướng\s*dẫn|chỉ\s*dẫn|câu\s*lệnh|quy\s*định)\s*(trước|cũ)/i,
  /system\s*prompt/i,
  /reveal\s*(your\s*)?(initial\s*)?(prompt|instructions)/i,
  /cho\s*(tôi\s*)?(xem\s*)?(câu\s*lệnh|system\s*prompt|hướng\s*dẫn\s*hệ\s*thống)/i,
  /you\s+are\s+now\s+(in\s+)?(developer\s+mode|dan|jailbreak|unrestricted)/i,
  /bây\s*giờ\s*bạn\s*là\s*(developer|quản\s*trị\s*viên|admin)/i,
];

/** Checks a member's question before a turn opens: empty, too long, control characters, instruction overrides. */
@Injectable()
export class InputGuardService {
  constructor(private readonly audit: AuditLogService) {}

  check(rawText: string, conversationId: string, actorId: string, role: 'moderator' | 'admin'): InputGuardResult {
    if (!rawText || rawText.trim().length === 0) return { allowed: false, sanitizedText: '', blockedReason: 'EMPTY_INPUT' };
    const block = (reason: 'LENGTH_EXCEEDED' | 'PROMPT_INJECTION', detail: string, text: string): InputGuardResult => {
      this.audit.write({ trace_id: randomUUID(), conversation_id: conversationId, actor_id: actorId, role,
        event: 'input_blocked', status: 'blocked', block_reason: `${reason}: ${detail}`, ts: new Date().toISOString() });
      return { allowed: false, sanitizedText: text, blockedReason: reason };
    };
    if (rawText.length > MAX_INPUT_LENGTH) return block('LENGTH_EXCEEDED', `${rawText.length} > ${MAX_INPUT_LENGTH}`, rawText.slice(0, MAX_INPUT_LENGTH));

    const clean = rawText
      .replace(/[​-‍﻿]/g, '') // Zero-width spaces
      .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '') // Control characters
      .replace(/<[^>]*>/g, ''); // Basic HTML tags
    if (!clean.trim()) return { allowed: false, sanitizedText: '', blockedReason: 'EMPTY_INPUT' };

    const pattern = INJECTION_PATTERNS.find(p => p.test(clean));
    if (pattern) return block('PROMPT_INJECTION', pattern.source, clean);
    return { allowed: true, sanitizedText: clean };
  }
}
