import { Logger } from '@nestjs/common';
import { tool } from '@strands-agents/sdk';
import { z } from 'zod';
import { MemoryService } from './memory.service';

/**
 * A `remember_fact` tool that lets the agent actively persist personalisation
 * facts (name, size, brand preference, feedback...) to long-term memory.
 *
 * Unlike the passive server-side extraction that runs on every `saveTurn()`,
 * this tool gives the agent explicit control over WHAT gets stored - producing
 * cleaner, more structured facts in the vector store.
 *
 * The fact is written as a synthetic conversation event so that AgentCore's
 * existing semantic + user-preference extraction strategies pick it up and
 * index it into the `/facts/{actorId}` namespace automatically.
 *
 * Guardrails: sensitive data (card numbers, OTPs, passwords, national IDs,
 * bank accounts) is blocked before anything reaches the memory store.
 */

const log = new Logger('RememberFact');

const CATEGORIES = ['profile', 'preference', 'size_fit', 'feedback'] as const;

// ---------------------------------------------------------------------------
// Guardrail rules - each rule has a human-readable label and a regex.
// The regex is tested against the fact (case-insensitive, trimmed).
// ---------------------------------------------------------------------------
interface GuardrailRule {
  label: string;
  pattern: RegExp;
}

const GUARDRAIL_RULES: GuardrailRule[] = [
  {
    // Visa / Mastercard / Amex / UnionPay - 13-19 contiguous digits (with optional spaces/dashes)
    label: 'credit/debit card number',
    pattern: /\b(?:\d[ -]?){13,19}\b/,
  },
  {
    // 4-8 digit OTP / PIN / verification code (standalone, preceded by keyword)
    label: 'OTP or PIN code',
    pattern: /\b(?:otp|pin|verification[\s_-]?code|code)[\s:=]+\d{4,8}\b/i,
  },
  {
    // Passwords / secrets - any mention of password/mat khau followed by a value
    label: 'password or secret',
    pattern: /\b(?:password|passwd|secret|token|api[\s_-]?key)[\s:=]+\S+/i,
  },
  {
    // Vietnamese CCCD / CMND - 9 or 12 digit national ID
    label: 'national ID (CCCD/CMND)',
    pattern: /\b(?:cccd|cmnd)[\s:=]*\d{9}(?:\d{3})?\b/i,
  },
  {
    // Bank account numbers - guarded by context keywords to reduce false positives
    label: 'bank account number',
    pattern: /\b(?:stk|account[\s_-]?no\.?|bank[\s_-]?acc(?:ount)?)[\s:=]+\d{9,20}\b/i,
  },
  {
    // CVV / CVC - 3-4 digit security code preceded by keyword
    label: 'CVV/CVC security code',
    pattern: /\b(?:cvv|cvc|security[\s_-]?code)[\s:=]+\d{3,4}\b/i,
  },
];

/**
 * Returns the label of the first guardrail violation found, or null if clean.
 */
function detectSensitiveData(fact: string): string | null {
  const normalised = fact.trim();
  for (const rule of GUARDRAIL_RULES) {
    if (rule.pattern.test(normalised)) {
      return rule.label;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------

export function rememberFactTool(memory: MemoryService, actorId: string, sessionId: string) {
  return tool({
    name: 'remember_fact',
    description:
      'Save an important fact about the user for future personalisation. ' +
      'Use when the user shares personal info (name, location), preferences ' +
      '(brands, styles, budget range), sizing (shoe size, clothing size), or ' +
      'feedback (liked/disliked a past purchase). Do NOT save transient info ' +
      'that tools already return (prices, stock levels, order status). ' +
      'Do NOT save sensitive data such as passwords, card numbers, OTPs, or IDs.',
    inputSchema: z.object({
      category: z
        .enum(CATEGORIES)
        .describe(
          'Fact category: "profile" (name, location, language), ' +
          '"preference" (brand, style, budget), "size_fit" (shoe/clothing size), ' +
          '"feedback" (satisfaction, complaints about past purchases).',
        ),
      fact: z
        .string()
        .min(3)
        .max(500)
        .describe("The fact to remember, concise and in the user's own language."),
    }),
    callback: async ({ category, fact }) => {
      // --- Guardrail check (pre-write) ---
      const violation = detectSensitiveData(fact);
      if (violation) {
        log.warn(
          `Guardrail blocked remember_fact for actor=${actorId}: matched [${violation}]`,
        );
        // Return a message the LLM can relay to the user; do NOT persist.
        return (
          `[Guardrail] Cannot save this fact - it appears to contain sensitive data ` +
          `(${violation}). Personal security information (card numbers, OTPs, ` +
          `passwords, IDs) must never be stored in memory.`
        );
      }

      // --- Persist ---
      try {
        // Write the fact as a synthetic conversation event. The "user" side
        // states the category, and the "assistant" side records the fact.
        // AgentCore's extraction strategies will pick this up and index it.
        await memory.saveTurn(
          actorId,
          sessionId,
          `[memory:${category}] User shared a personal fact.`,
          `[memory:${category}] ${fact}`,
        );
        log.log(`Saved [${category}] for actor=${actorId}: ${fact}`);
        return `Remembered: [${category}] ${fact}`;
      } catch (e) {
        log.warn(`remember_fact failed: ${(e as Error).message}`);
        return `Failed to save fact: ${(e as Error).message}`;
      }
    },
  });
}
