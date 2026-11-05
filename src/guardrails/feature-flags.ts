/**
 * Dynamic Feature Flags / Kill Switches for the Agent Harness.
 * Loaded from environment variables with hot runtime override capability.
 */
export class FeatureFlags {
  private static _orderStatusEnabled: boolean = process.env.FEATURE_ORDER_STATUS !== 'false';
  private static _llmEnabled: boolean = process.env.FEATURE_LLM !== 'false';
  private static _agentEnabled: boolean = process.env.FEATURE_ALL_AGENT !== 'false';

  static get isAgentEnabled(): boolean {
    return this._agentEnabled;
  }

  static get isLlmEnabled(): boolean {
    return this._llmEnabled;
  }

  static get isOrderStatusEnabled(): boolean {
    return this._orderStatusEnabled;
  }

  /** Hot-reload / toggle kill switches without restarting process */
  static setAgentEnabled(val: boolean): void {
    this._agentEnabled = val;
  }

  static setLlmEnabled(val: boolean): void {
    this._llmEnabled = val;
  }

  static setOrderStatusEnabled(val: boolean): void {
    this._orderStatusEnabled = val;
  }
}
