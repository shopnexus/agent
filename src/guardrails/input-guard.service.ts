import { Injectable } from '@nestjs/common';
import { AuditLogService } from './audit-log.service';
import { randomUUID } from 'crypto';

export interface InputGuardResult {
  allowed: boolean;
  sanitizedText: string;
  blockedReason?: 'EMPTY_INPUT' | 'LENGTH_EXCEEDED';
}

const MAX_INPUT_LENGTH = 2000;


/**
 * Checks a member's question before a turn opens: empty, too long, control characters.
 * A member is trusted, so instruction-like phrases pass: members paste scam messages that
 * contain them. Content from users reaches the model only as quoted tool data.
 */
@Injectable()
export class InputGuardService {
  constructor(private readonly audit: AuditLogService) {}

  check(rawText: string, conversationId: string, actorId: string, role: 'moderator' | 'admin'): InputGuardResult {
    if (!rawText || rawText.trim().length === 0) return { allowed: false, sanitizedText: '', blockedReason: 'EMPTY_INPUT' };
    const block = (reason: 'LENGTH_EXCEEDED', detail: string, text: string): InputGuardResult => {
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

    return { allowed: true, sanitizedText: clean };
  }
}
