import { Injectable, Logger } from '@nestjs/common';
import { scanAndMaskPii } from './pii-utils';

const ALLOWED_DOMAIN = 'shopnexus.hopto.org';

/** A number extracted from the agent's answer text */
interface ExtractedNumber {
  raw: string;
  value: number;
}

export interface VerificationContext {
  toolNumbers?: number[];
  policySources?: string[];
  calledTools?: string[];
}

export interface VerifierResult {
  text: string;         // final safe text (may be rewritten or fallback)
  modified: boolean;    // true if any rule rewrote the text
  rulesTriggered: string[]; // which rules fired
  handoffRecommended?: boolean;
}

const FALLBACK_VI = 'Xin lỗi, tôi không thể cung cấp thông tin này lúc này. Vui lòng thử lại hoặc liên hệ bộ phận hỗ trợ.';

@Injectable()
export class OutputVerifierService {
  private readonly log = new Logger(OutputVerifierService.name);

  /**
   * Run all output verification rules on the agent's answer.
   * contextOrNumbers: numeric grounding context or full VerificationContext.
   * Fail-closed: any unexpected error → return FALLBACK.
   */
  verify(rawAnswer: string, contextOrNumbers: number[] | VerificationContext = []): VerifierResult {
    const ctx: VerificationContext = Array.isArray(contextOrNumbers)
      ? { toolNumbers: contextOrNumbers }
      : (contextOrNumbers ?? {});

    try {
      return this.runRules(rawAnswer, ctx);
    } catch (e) {
      this.log.error(`OutputVerifier internal error: ${(e as Error).message}`);
      return { text: FALLBACK_VI, modified: true, rulesTriggered: ['verifier_error_fallback'] };
    }
  }

  private runRules(text: string, ctx: VerificationContext): VerifierResult {
    let current = text;
    const triggered: string[] = [];
    const toolNumbers = ctx.toolNumbers ?? [];

    // Rule 1: link_allowlist — remove URLs not from allowed domain
    const linkResult = this.applyLinkAllowlist(current);
    if (linkResult.modified) { current = linkResult.text; triggered.push('link_allowlist'); }

    // Rule 2: no_external_images — remove external image markdown/html
    const imgResult = this.applyNoExternalImages(current);
    if (imgResult.modified) { current = imgResult.text; triggered.push('no_external_images'); }

    // Rule 3: pii_redaction — mask phone/email/card/cccd
    const piiResult = scanAndMaskPii(current);
    if (piiResult.hasPii) { current = piiResult.masked; triggered.push('pii_redaction'); }

    // Rule 4: no_internal_leak — detect system prompt / internal field leakage
    const leakResult = this.applyNoInternalLeak(current);
    if (leakResult.blocked) {
      this.log.warn(`no_internal_leak triggered — returning fallback`);
      return { text: FALLBACK_VI, modified: true, rulesTriggered: [...triggered, 'no_internal_leak'] };
    }

    // Rule 5: no_absolute_claims — soften or flag absolute claims
    const absResult = this.applyNoAbsoluteClaims(current);
    if (absResult.modified) { current = absResult.text; triggered.push('no_absolute_claims'); }

    // Rule 6: scope_check — add disclaimer for out-of-scope topics
    const scopeResult = this.applyScopeCheck(current);
    if (scopeResult.modified) { current = scopeResult.text; triggered.push('scope_check'); }

    // Rule 7: policy_cited — policy answers must cite approved RAG source; no source -> handoff
    if (ctx.calledTools?.includes('get_policy')) {
      const validSources = (ctx.policySources ?? []).filter(Boolean);
      if (validSources.length === 0) {
        current = 'Chính sách bạn hỏi hiện chưa có trong tài liệu chính thức đã duyệt trên hệ thống ShopNexus. Mình xin phép chuyển thông tin này cho nhân viên hỗ trợ để giải đáp cụ thể cho bạn nhé.';
        triggered.push('policy_cited_no_source_handoff');
      } else {
        const hasCite = validSources.some(src => current.includes(src) || current.includes('Chính sách') || current.includes('policy'));
        if (!hasCite) {
          current += `\n\n*(Nguồn tham chiếu đã duyệt: ${validSources.join(', ')})*`;
          triggered.push('policy_cited_appended');
        }
      }
    }

    // Rule 8: numbers_grounded — warn if answer contains numbers not from tool results
    if (toolNumbers.length > 0) {
      const groundResult = this.applyNumbersGrounded(current, toolNumbers);
      if (groundResult.ungrounded) { triggered.push('numbers_grounded_warn'); }
    }

    return { text: current, modified: triggered.length > 0, rulesTriggered: triggered };
  }

  // ── Rule implementations ────────────────────────────────────────────────────

  private applyLinkAllowlist(text: string): { text: string; modified: boolean } {
    // Match markdown links [text](url) and bare URLs
    const URL_RE = /https?:\/\/[^\s)\]"']+/g;
    let modified = false;
    const result = text.replace(URL_RE, (url) => {
      try {
        const hostname = new URL(url).hostname;
        if (hostname === ALLOWED_DOMAIN || hostname.endsWith(`.${ALLOWED_DOMAIN}`)) return url;
      } catch { /* invalid URL — remove it */ }
      modified = true;
      return '[link đã bị gỡ]';
    });
    // Clean up empty markdown links like [text]([link đã bị gỡ])
    return { text: result, modified };
  }

  private applyNoExternalImages(text: string): { text: string; modified: boolean } {
    let modified = false;
    // Remove ![alt](external_url)
    let result = text.replace(/!\[[^\]]*\]\(https?:\/\/[^)]+\)/g, (match) => {
      try {
        const urlMatch = match.match(/\(https?:\/\/([^/)]+)/);
        const hostname = urlMatch?.[1] ?? '';
        if (hostname === ALLOWED_DOMAIN || hostname.endsWith(`.${ALLOWED_DOMAIN}`)) return match;
      } catch { /* */ }
      modified = true;
      return '';
    });
    // Remove <img src="external">
    result = result.replace(/<img[^>]+src=["']https?:\/\/(?!shopnexus\.hopto\.org)[^"']+["'][^>]*>/gi, () => {
      modified = true;
      return '';
    });
    return { text: result, modified };
  }

  private applyNoInternalLeak(text: string): { blocked: boolean } {
    const FORBIDDEN = [
      /system\s*prompt/i,
      /giá\s*vốn/i,
      /cost\s*price/i,
      /supplier/i,
      /nhà\s*cung\s*cấp/i,
      /tool_name/i,
      /toolUseId/i,
      /\bmargin\b/i,
      /internal\s*field/i,
      /ignore\s*(previous|prior|above)/i,
      /bỏ\s*qua\s*hướng\s*dẫn/i,
    ];
    return { blocked: FORBIDDEN.some(re => re.test(text)) };
  }

  private applyNoAbsoluteClaims(text: string): { text: string; modified: boolean } {
    const ABSOLUTE_PATTERNS: Array<[RegExp, string]> = [
      [/tốt\s*nhất\s*thị\s*trường/gi, 'tốt'],
      [/an\s*toàn\s*100\s*%/gi, 'an toàn'],
      [/đảm\s*bảo\s*100\s*%/gi, 'thường đảm bảo'],
      [/không\s*tác\s*dụng\s*phụ/gi, 'ít tác dụng phụ hơn (tham khảo nhà sản xuất)'],
      [/chắc\s*chắn\s*sẽ\s*giao/gi, 'dự kiến sẽ giao'],
      [/guaranteed\s*delivery/gi, 'estimated delivery'],
      [/100%\s*safe/gi, 'generally considered safe'],
    ];
    let result = text;
    let modified = false;
    for (const [pattern, replacement] of ABSOLUTE_PATTERNS) {
      const before = result;
      result = result.replace(pattern, replacement);
      if (result !== before) modified = true;
    }
    return { text: result, modified };
  }

  private applyScopeCheck(text: string): { text: string; modified: boolean } {
    const MEDICAL_RE = /\b(thuốc|liều\s*dùng|tác\s*dụng\s*phụ|dị\s*ứng|bệnh|thai\s*kỳ|mang\s*thai|kê\s*đơn|bác\s*sĩ)\b/i;
    const LEGAL_RE = /\b(kiện\s*tụng|pháp\s*lý|luật\s*sư|tòa\s*án|vi\s*phạm\s*pháp\s*luật)\b/i;
    const FINANCIAL_RE = /\b(đầu\s*tư\s*tài\s*chính|cổ\s*phiếu|crypto|tiền\s*số|tư\s*vấn\s*tài\s*chính)\b/i;

    const DISCLAIMER_VI = '\n\n> ⚠️ *Lưu ý: Thông tin trên chỉ mang tính tham khảo. Vui lòng tham khảo chuyên gia chuyên môn để được tư vấn chính xác.*';

    let result = text;
    let modified = false;

    if (MEDICAL_RE.test(text) && !result.includes('chuyên gia')) {
      result += DISCLAIMER_VI;
      modified = true;
    } else if (LEGAL_RE.test(text) && !result.includes('chuyên gia')) {
      result += DISCLAIMER_VI;
      modified = true;
    } else if (FINANCIAL_RE.test(text) && !result.includes('chuyên gia')) {
      result += DISCLAIMER_VI;
      modified = true;
    }

    return { text: result, modified };
  }

  private applyNumbersGrounded(text: string, toolNumbers: number[]): { ungrounded: boolean } {
    // Extract numbers from answer (prices in VND, percentages, quantities)
    const NUMBER_RE = /\b(\d{1,3}(?:[.,]\d{3})*|\d+)(?:\s*(?:đ|VNĐ|VND|%|giờ|ngày|tháng))?\b/g;
    const extracted: number[] = [];
    let m: RegExpExecArray | null;
    while ((m = NUMBER_RE.exec(text)) !== null) {
      const val = parseFloat(m[1].replace(/[.,]/g, ''));
      if (!isNaN(val) && val > 100) extracted.push(val); // skip small counts like 1, 2, 3
    }

    // Check each extracted number is within ±5% of at least one tool number
    const ungrounded = extracted.some(n =>
      !toolNumbers.some(t => Math.abs(n - t) / Math.max(t, 1) <= 0.05)
    );

    if (ungrounded) {
      this.log.warn(`numbers_grounded: answer contains number not from tool results (extracted=${extracted.join(',')}, tool=${toolNumbers.join(',')})`);
    }

    return { ungrounded };
  }
}
