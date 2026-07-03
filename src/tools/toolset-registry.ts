import { Injectable } from '@nestjs/common';

/**
 * A revision counter that increments whenever the agent's available toolset
 * changes at runtime — installing an MCP server today, a skill or plugin later.
 *
 * It is deliberately name-agnostic: any dynamic-tool provider just calls
 * `bump()` after mutating its tools. Long-lived agents (the CLI) compare the
 * revision across turns to decide when to rebuild; stateless callers (HTTP)
 * rebuild every request and can ignore it.
 */
@Injectable()
export class ToolsetRegistry {
  private _revision = 0;

  get revision(): number {
    return this._revision;
  }

  /** Signal that the set of available tools changed. */
  bump(): void {
    this._revision++;
  }
}
