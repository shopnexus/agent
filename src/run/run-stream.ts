import { Logger } from '@nestjs/common';
import { errorDetails } from '../observability/error-details';
import type { TurnEventType } from './events';
import type { RunState } from './run-state';
import type { AnswerBlock, DocumentSection } from './answer-blocks';
import type { Source } from './citations';

/** A tool call row as it changes: pending, running, then its end. */
export interface ToolCallLine {
  kind: 'tool_call';
  id: string; tool_use_id: string; tool: string; label: string | null; source: string;
  input: Record<string, unknown>; status: 'pending' | 'running' | 'success' | 'failed' | 'cancelled';
  output: string | null; content: unknown[] | null; output_spilled: boolean;
  latency_ms: number | null; attempts: number | null;
  attempt_errors: Array<{ attempt: number; error: string; at: string }> | null;
  timing: Record<string, unknown> | null; finished_at: string | null;
}

export interface EndUsage {
  input_tokens: number; output_tokens: number; cache_read_tokens: number; cache_write_tokens: number;
  cost_usd: number; first_token_ms: number | null; provider: string | null;
}

export type EndStatus = 'SUCCEEDED' | 'FAILED' | 'TIMED_OUT' | 'PAUSED' | 'AWAITING_INPUT';

/** The last line of a segment. */
export interface EndLine {
  kind: 'end';
  status: EndStatus; error_code: string | null; answer: string | null; blocks: AnswerBlock[]; sources: Source[];
  usage: EndUsage; latency_ms: number; wrote: boolean; state: RunState;
  event: { type: 'turn.finished' | 'turn.paused' | 'clarify'; body: Record<string, unknown> };
}

export type RunLine =
  | { kind: 'event'; type: TurnEventType; body: Record<string, unknown> }
  | { kind: 'checkpoint'; state: RunState }
  | ToolCallLine
  | { kind: 'document'; document_id: string; version: number; title: string; sections: DocumentSection[] }
  | EndLine;

/** Where lines go: the response in production, an array in tests. Resolves once written. */
export type LineSink = (line: RunLine) => void | Promise<void>;

const DELTA_FLUSH_MS = 120;
const DELTA_FLUSH_CHARS = 400;

/**
 * One segment's writer. Lines go out in the order they were written, and text
 * deltas are merged (about every 120 ms or 400 characters).
 */
export class RunStream {
  private readonly log = new Logger('RunStream');
  private queue: Promise<unknown> = Promise.resolve();
  private delta = '';
  private timer?: NodeJS.Timeout;
  private ended = false;

  constructor(private readonly sink: LineSink) {}

  emit(type: TurnEventType, body: Record<string, unknown> = {}): void {
    this.write({ kind: 'event', type, body });
  }

  textDelta(text: string): void {
    if (!text || this.ended) return;
    this.delta += text;
    if (this.delta.length >= DELTA_FLUSH_CHARS) this.flushDelta();
    else if (!this.timer) this.timer = setTimeout(() => this.flushDelta(), DELTA_FLUSH_MS);
  }

  checkpoint(state: RunState): void { this.write({ kind: 'checkpoint', state: structuredClone(state) }); }

  toolCall(row: ToolCallLine): void { this.write(structuredClone(row)); }

  document(doc: { document_id: string; version: number; title: string; sections: DocumentSection[] }): void {
    this.write({ kind: 'document', ...doc });
  }

  /** Writes the end line; nothing is written after it. */
  async end(line: EndLine): Promise<void> {
    this.write(line);
    this.ended = true;
    await this.flush();
  }

  /** Waits until every line so far is written. */
  async flush(): Promise<void> {
    this.flushDelta();
    await this.queue;
  }

  /** Every line written to a closed stream would be dropped: stop writing. */
  close(): void {
    this.ended = true;
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
    this.delta = '';
  }

  private write(line: RunLine) {
    if (this.ended) return;
    if (line.kind !== 'event' || line.type !== 'text.delta') this.flushDelta();
    this.queue = this.queue.then(() => this.sink(line)).catch(error => {
      this.log.error(JSON.stringify({ event: 'run_line_write_failed', kind: line.kind, ...errorDetails(error) }));
    });
  }

  private flushDelta() {
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
    if (!this.delta) return;
    const delta = this.delta;
    this.delta = '';
    this.write({ kind: 'event', type: 'text.delta', body: { delta } });
  }
}
