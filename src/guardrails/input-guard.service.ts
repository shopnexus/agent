import { Injectable, Logger } from '@nestjs/common';
import { scanAndMaskPii } from './pii-utils';
import { AuditLogService } from './audit-log.service';
import { randomUUID } from 'crypto';

export interface InputGuardResult {
  allowed: boolean;
  sanitizedText: string;
  blockedReason?: string;
  userFacingMessage?: string;
  hasPiiWarning?: string;
}

const MAX_INPUT_LENGTH = 2000;

// High-confidence prompt injection & jailbreak patterns
const INJECTION_PATTERNS = [
  /ignore\s+(all\s+)?(previous|prior|above)\s+(instructions|prompts|rules)/i,
  /bỏ\s*qua\s*(tất\s*cả\s*)?(hướng\s*dẫn|chỉ\s*dẫn|câu\s*lệnh|quy\s*định)\s*(trước|cũ)/i,
  /system\s*prompt/i,
  /reveal\s*(your\s*)?(initial\s*)?(prompt|instructions)/i,
  /cho\s*(tôi\s*)?(xem\s*)?(câu\s*lệnh|system\s*prompt|hướng\s*dẫn\s*hệ\s*thống)/i,
  /you\s+are\s+now\s+(in\s+)?(developer\s+mode|dan|jailbreak|unrestricted)/i,
  /bây\s*giờ\s*bạn\s*là\s*(developer|quản\s*trị\s*viên|admin)/i,
  /giá\s*vốn/i,
  /cost\s*price/i,
  /supplier\s*info/i,
];

// Mass catalog / scrape scraping patterns
const SCRAPE_PATTERNS = [
  /(xuất|tải|lấy|liệt\s*kê|cho\s*xem)\s*(toàn\s*bộ|tất\s*cả|danh\s*sách)?\s*(danh\s*mục|sản\s*phẩm|bảng\s*giá|database|kho\s*hàng)/i,
  /(dump|export|extract)\s*(all|entire|full)?\s*(catalog|products|database)/i,
];

@Injectable()
export class InputGuardService {
  private readonly log = new Logger(InputGuardService.name);

  constructor(private readonly audit: AuditLogService) {}

  check(
    rawText: string,
    conversationId: string,
    actorId: string,
    userType: 'authenticated' | 'anonymous',
  ): InputGuardResult {
    // 1. Length check
    if (!rawText || rawText.trim().length === 0) {
      return {
        allowed: false,
        sanitizedText: '',
        blockedReason: 'EMPTY_INPUT',
        userFacingMessage: 'Tin nhắn không được để trống.',
      };
    }

    if (rawText.length > MAX_INPUT_LENGTH) {
      this.audit.write({
        trace_id: randomUUID(),
        conversation_id: conversationId,
        actor_id: actorId,
        user_type: userType,
        event: 'input_blocked',
        status: 'blocked',
        block_reason: `INPUT_LENGTH_EXCEEDED: ${rawText.length} > ${MAX_INPUT_LENGTH}`,
        ts: new Date().toISOString(),
      });
      return {
        allowed: false,
        sanitizedText: rawText.slice(0, MAX_INPUT_LENGTH),
        blockedReason: 'LENGTH_EXCEEDED',
        userFacingMessage: `Tin nhắn quá dài (tối đa ${MAX_INPUT_LENGTH} ký tự). Vui lòng rút ngắn nội dung.`,
      };
    }

    // 2. Sanitize: remove zero-width chars, control chars, and HTML tags
    const clean = rawText
      .replace(/[\u200B-\u200D\uFEFF]/g, '') // Zero-width spaces
      .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '') // Control characters
      .replace(/<[^>]*>/g, ''); // Basic HTML tags

    // 3. Prompt injection detection
    for (const pattern of INJECTION_PATTERNS) {
      if (pattern.test(clean)) {
        this.audit.write({
          trace_id: randomUUID(),
          conversation_id: conversationId,
          actor_id: actorId,
          user_type: userType,
          event: 'input_blocked',
          status: 'blocked',
          block_reason: `PROMPT_INJECTION_DETECTED: ${pattern.source}`,
          ts: new Date().toISOString(),
        });
        return {
          allowed: false,
          sanitizedText: clean,
          blockedReason: 'PROMPT_INJECTION',
          userFacingMessage: 'Yêu cầu của bạn chứa câu lệnh không hợp lệ hoặc vi phạm chính sách sử dụng.',
        };
      }
    }

    // 4. Scrape detection (mass dumping)
    for (const pattern of SCRAPE_PATTERNS) {
      if (pattern.test(clean)) {
        this.audit.write({
          trace_id: randomUUID(),
          conversation_id: conversationId,
          actor_id: actorId,
          user_type: userType,
          event: 'input_blocked',
          status: 'blocked',
          block_reason: `SCRAPE_ATTEMPT_DETECTED: ${pattern.source}`,
          ts: new Date().toISOString(),
        });
        return {
          allowed: false,
          sanitizedText: clean,
          blockedReason: 'SCRAPE_ATTEMPT',
          userFacingMessage: 'ShopNexus không hỗ trợ xuất toàn bộ danh mục sản phẩm. Bạn vui lòng tìm kiếm theo từ khóa hoặc danh mục cụ thể.',
        };
      }
    }

    // 5. PII scan on input (warn if sensitive payment card/CCCD is pasted)
    let piiWarning: string | undefined;
    const piiResult = scanAndMaskPii(clean);
    if (piiResult.types.includes('card') || piiResult.types.includes('cccd')) {
      piiWarning = '⚠️ Lưu ý an toàn: Vui lòng không chia sẻ số thẻ ngân hàng, mã OTP hoặc số CCCD vào ô chat.';
    }

    return {
      allowed: true,
      sanitizedText: clean,
      hasPiiWarning: piiWarning,
    };
  }
}
