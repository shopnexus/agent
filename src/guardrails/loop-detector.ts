/**
 * Detects tool call loops within a single agent turn.
 * Same (tool, serialized-input) pair ≥ 3 times → throw.
 */
export class LoopDetector {
  private readonly calls = new Map<string, number>();
  private readonly MAX_REPEATS = 3;

  record(toolName: string, input: Record<string, unknown>): void {
    const key = `${toolName}::${JSON.stringify(input)}`;
    const count = (this.calls.get(key) ?? 0) + 1;
    this.calls.set(key, count);
    if (count >= this.MAX_REPEATS) {
      throw new LoopDetectedError(toolName, count);
    }
  }
}

export class LoopDetectedError extends Error {
  constructor(public readonly toolName: string, public readonly count: number) {
    super(`Loop detected: tool "${toolName}" called ${count} times with same input`);
    this.name = 'LoopDetectedError';
  }
}
