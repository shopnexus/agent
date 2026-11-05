/**
 * PII detection and masking utilities.
 * Used by both input guard and output verifier.
 */

/** Regex patterns for Vietnamese PII */
const PHONE_RE = /(\+84|0)(3[2-9]|5[6-9]|7[0-9]|8[0-9]|9[0-9])\d{7}/g;
const EMAIL_RE = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;
const CARD_RE = /\b\d{4}[\s\-]?\d{4}[\s\-]?\d{4}[\s\-]?\d{4}\b/g;
const CCCD_RE = /\b\d{9}(\d{3})?\b/g;  // 9 or 12 digit national ID

export interface PiiScanResult {
  hasPii: boolean;
  types: string[];
  masked: string;
}

export function scanAndMaskPii(text: string): PiiScanResult {
  const types: string[] = [];
  let masked = text;

  if (PHONE_RE.test(text)) { types.push('phone'); PHONE_RE.lastIndex = 0; }
  if (EMAIL_RE.test(text)) { types.push('email'); EMAIL_RE.lastIndex = 0; }
  if (CARD_RE.test(text)) { types.push('card'); CARD_RE.lastIndex = 0; }
  if (CCCD_RE.test(text)) { types.push('cccd'); CCCD_RE.lastIndex = 0; }

  masked = masked.replace(PHONE_RE, (m) => `****${m.slice(-3)}`);
  masked = masked.replace(EMAIL_RE, (m) => `${m[0]}***@***.${m.split('.').pop()}`);
  masked = masked.replace(CARD_RE, (m) => `****-****-****-${m.replace(/\D/g, '').slice(-4)}`);
  masked = masked.replace(CCCD_RE, (m) => `***${m.slice(-3)}`);

  return { hasPii: types.length > 0, types, masked };
}
