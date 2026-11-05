import { MemoryCategory } from './types';
import { scanAndMaskPii } from '../guardrails/pii-utils';

export interface ExtractedFact {
  category: MemoryCategory;
  factKey: string;
  content: string;
  importance: number;
}

const NAME_PATTERNS = [
  /(?:tên tôi là|tôi tên là|tên mình là|mình tên là)\s+([\p{L}][\p{L}\p{M}'’-]{0,39}(?:\s+[\p{L}][\p{L}\p{M}'’-]{0,39}){0,2})/iu,
  /my name is\s+([\p{L}][\p{L}\p{M}'’-]{0,39}(?:\s+[\p{L}][\p{L}\p{M}'’-]{0,39}){0,2})/iu,
  /call me\s+([\p{L}][\p{L}\p{M}'’-]{0,39}(?:\s+[\p{L}][\p{L}\p{M}'’-]{0,39}){0,2})/iu,
];

/** Extracts only explicit, durable first-person facts from a completed user message. */
export function extractUserFacts(text: string): ExtractedFact[] {
  const normalized = text.normalize('NFC').trim();
  if (!normalized || normalized.length > 2000 || isSensitiveOrUncertain(normalized)) return [];

  const facts: ExtractedFact[] = [];
  for (const pattern of NAME_PATTERNS) {
    const name = pattern.exec(normalized)?.[1]?.trim().replace(/[.,!?;:]+$/, '');
    if (name && !/(?:\b(?:and|or|but)\b|và|hoặc|nhưng)/iu.test(name)) {
      facts.push({ category: 'profile', factKey: 'profile.name', content: `name: ${name}`, importance: 3 });
      break;
    }
  }

  const preference = normalized.match(/\b(?:tôi|mình|I)\s+(?:rất\s+)?(?:thích|ưa thích|prefer|like)\s+([^.!?\n]{3,120})/iu);
  if (preference?.[1]) {
    const value = preference[1].trim().replace(/[.,;:]+$/, '');
    if (value) facts.push({ category: 'preference', factKey: `preference.${stableKey(value)}`, content: `preference: ${value}`, importance: 3 });
  }

  const size = normalized.match(/(?:size|cỡ)\s+(?:giày|shoe|áo|quần)?\s*(?:của tôi\s+)?(?:là\s+)?([A-Z]{1,3}\b|\d{1,3}(?:\.\d{1,2})?)/iu);
  if (size?.[1] && /\b(?:tôi|mình|my|của tôi)\b/iu.test(normalized)) {
    const kind = /giày|shoe/iu.test(normalized) ? 'shoe' : /áo|quần/iu.test(normalized) ? 'clothing' : 'unspecified';
    facts.push({ category: 'size_fit', factKey: `size_fit.${kind}`, content: `${kind}_size: ${size[1]}`, importance: 4 });
  }

  return facts;
}

function isSensitiveOrUncertain(text: string): boolean {
  return scanAndMaskPii(text).hasPii
    || /(?:password|passwd|otp|pin|token|api[\s_-]?key|cvv|cvc|cccd|cmnd|credit card|debit card|mật khẩu|mã otp|số thẻ|tài khoản ngân hàng)/iu.test(text)
    || /(?:địa chỉ|address|số điện thoại|phone number|email)/iu.test(text)
    || /(?:không phải|not|đùa|joking|giả sử|suppose|ví dụ|for example|my friend|bạn tôi|anh ấy|chị ấy|they are called|his name|her name)/iu.test(text)
    || /(?:giá|tồn kho|đơn hàng|vận chuyển|tracking|order status|stock|price)/iu.test(text);
}

function stableKey(value: string): string {
  return value.normalize('NFC').toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '').slice(0, 48) || 'general';
}
