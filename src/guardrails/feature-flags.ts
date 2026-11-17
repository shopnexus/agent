/**
 * Kill switches for the agent, read from the environment at start-up and
 * changeable at runtime. Off means every turn is refused as agent_unavailable.
 */
export class FeatureFlags {
  private static _llmEnabled: boolean = process.env.FEATURE_LLM !== 'false';
  private static _agentEnabled: boolean = process.env.FEATURE_ALL_AGENT !== 'false';

  static get isAgentEnabled(): boolean { return this._agentEnabled; }
  static get isLlmEnabled(): boolean { return this._llmEnabled; }
  static setAgentEnabled(val: boolean): void { this._agentEnabled = val; }
  static setLlmEnabled(val: boolean): void { this._llmEnabled = val; }
}
