import { Agent, MessageData } from '@strands-agents/sdk';
import { AgentService, TurnToolInfo } from '../../src/agent/agent.service';
import { ScopeDecision, OutputDecision } from '../../src/guardrails/support-policy';

export function makeAgentScopeHarness(options: { scope?: ScopeDecision; output?: OutputDecision; draft?: string } = {}) {
  const calls = { generated: 0, prepared: 0, persisted: [] as any[], assessed: 0, reviewed: 0, history: 0, memory: 0, scope: undefined as ScopeDecision | undefined, signals: [] as AbortSignal[] };
  const draft = options.draft ?? 'Verified shopping answer';
  const agent = { messages: [], addMiddleware: () => () => {}, invoke: async (_: string, opts: any) => {
    calls.generated++; calls.signals.push(opts.cancelSignal);
    return { stopReason: 'endTurn', lastMessage: { content: [{ type: 'textBlock', text: draft }] } };
  } } as unknown as Agent;
  const turns = { getTurnCount: async () => 0, getRecentMessages: async () => { calls.history++; return []; },
    startTurn: async (_p: any) => ({id:'turn',ordinal:0}),
    finishTurn: async (p: any) => { calls.persisted.push(p); } };
  const verifier = { verify: (text: string, _info: TurnToolInfo) => ({ text, modified: false, rulesTriggered: [] as string[] }) };
  const inputGuard = { check: (text: string) => ({ allowed: true, sanitizedText: text, hasPiiWarning: undefined as string | undefined }) };
  const rateLimiter = { consume: () => ({ allowed: true }) };
  const scope = {
    assess: async (_request: any, signal: AbortSignal) => { calls.assessed++; calls.signals.push(signal); return options.scope ?? { route: 'allow', intents: ['products'], memory: [], reason: 'in_scope' }; },
    review: async (_request: any, signal: AbortSignal) => { calls.reviewed++; calls.signals.push(signal); return options.output ?? { allowed: true, reason: 'in_scope' }; },
  };
  const memory = { createManager: () => { calls.memory++; throw new Error('Unexpected memory'); } };
  const service = new AgentService({} as any, memory as any, {} as any, turns as any, { build: (m: MessageData[]) => m } as any, { assertOwnedConversation: async () => {} } as any, {} as any, { write: () => {} } as any, verifier as any, inputGuard as any, rateLimiter as any, scope as any);
  service.prepareAgent = async (_actor, _session, _ctx, decision, _history) => {
    calls.prepared++; calls.scope = decision;
    return { agent, toolNumbers: [], toolInfo: { toolNumbers: [], calledTools: [], policySources: [] } };
  };
  return { service, calls, agent, turns, verifier, inputGuard, rateLimiter, scope };
}
