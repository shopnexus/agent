import { Logger } from '@nestjs/common';
import { tool } from '@strands-agents/sdk';
import { z } from 'zod';
import { MemoryService } from './memory.service';
import { MemoryCategory, UserRole } from './types';

const log = new Logger('RememberFact');

const CATEGORIES: [MemoryCategory, ...MemoryCategory[]] = [
  'profile',
  'preference',
  'size_fit',
  'feedback',
  'shop_policy',
];

interface GuardrailRule {
  label: string;
  pattern: RegExp;
}

const GUARDRAIL_RULES: GuardrailRule[] = [
  {
    // Visa / Mastercard / Amex - 13-19 digits
    label: 'credit/debit card number',
    pattern: /\b(?:\d[ -]?){13,19}\b/,
  },
  {
    // 4-8 digit OTP / PIN code
    label: 'OTP or PIN code',
    pattern: /\b(?:otp|pin|verification[\s_-]?code|code)[\s:=]+\d{4,8}\b/i,
  },
  {
    // Passwords / secrets
    label: 'password or secret',
    pattern: /\b(?:password|passwd|secret|token|api[\s_-]?key)[\s:=]+\S+/i,
  },
  {
    // Vietnamese CCCD / CMND - 9 or 12 digits
    label: 'national ID (CCCD/CMND)',
    pattern: /\b(?:cccd|cmnd)[\s:=]*\d{9}(?:\d{3})?\b/i,
  },
  {
    // Bank account numbers
    label: 'bank account number',
    pattern: /\b(?:stk|account[\s_-]?no\.?|bank[\s_-]?acc(?:ount)?)[\s:=]+\d{9,20}\b/i,
  },
  {
    // CVV / CVC
    label: 'CVV/CVC security code',
    pattern: /\b(?:cvv|cvc|security[\s_-]?code)[\s:=]+\d{3,4}\b/i,
  },
];

function detectSensitiveData(fact: string): string | null {
  const normalised = fact.trim();
  for (const rule of GUARDRAIL_RULES) {
    if (rule.pattern.test(normalised)) {
      return rule.label;
    }
  }
  return null;
}

export function rememberFactTool(
  memory: MemoryService,
  userId: string,
  _sessionId: string,
  role: UserRole = 'buyer',
) {
  return tool({
    name: 'remember_fact',
    description:
      'Save an important fact about the buyer or seller for future personalisation. ' +
      'For BUYERS: save size/fit (shoes, clothing), brand/color preferences, budget, location, feedback. ' +
      'For SELLERS: save shop policies (returns, warranty, packaging speed), tone preferences. ' +
      'Do NOT save transient info (prices, current stock, order status). ' +
      'Do NOT save sensitive PII (card numbers, OTPs, passwords, bank accounts, national IDs).',
    inputSchema: z.object({
      category: z
        .enum(CATEGORIES)
        .describe(
          'Fact category: "size_fit" (clothing/shoes), "preference" (brand, style, budget), ' +
          '"profile" (name, default area), "feedback" (past complaints/loves), ' +
          '"shop_policy" (seller return/warranty policies).',
        ),
      fact: z
        .string()
        .min(3)
        .max(500)
        .describe("The concise fact to remember in the user's language."),
      importance: z
        .number()
        .min(1)
        .max(5)
        .default(3)
        .describe('Importance from 1 to 5 (5 = critical, e.g. strict size or material allergy).'),
    }),
    callback: async ({ category, fact, importance }) => {
      const violation = detectSensitiveData(fact);
      if (violation) {
        log.warn(`Guardrail blocked remember_fact for user=${userId}: matched [${violation}]`);
        return (
          `[Guardrail] Cannot save this fact - it appears to contain sensitive information ` +
          `(${violation}). Card numbers, OTPs, passwords, and bank accounts must never be stored.`
        );
      }

      try {
        await memory.recordFact({
          userId,
          role,
          category,
          content: fact,
          importance,
        });
        log.log(`Saved [${category}] for ${role} (${userId}): ${fact}`);
        return `Remembered [${category}]: ${fact}`;
      } catch (e) {
        log.warn(`remember_fact failed: ${(e as Error).message}`);
        return `Failed to save fact: ${(e as Error).message}`;
      }
    },
  });
}
