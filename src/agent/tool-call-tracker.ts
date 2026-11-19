import { Logger } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { Agent, AfterToolCallEvent, BeforeToolCallEvent, BeforeToolsEvent, ToolResultEvent } from '@strands-agents/sdk';
import { traceContext } from '../observability/trace-context';
import type { ToolCallLine } from '../run/run-stream';

export interface ToolCallTracker {
  /** The tool call row id of a call of this segment. */
  callId(toolUseId: string): string | undefined;
}

/** Attempts and timing a call ends with, supplied by the run. */
export interface AttemptError { attempt: number; error: string; at: string }
export interface ToolCallMeta { attempts?: number; timing?: Record<string, unknown>; attemptErrors?: AttemptError[]; label?: string }

export interface TrackerOptions {
  turnId: string;
  conversationId?: string;
  ownedOutputIds?: ReadonlySet<string>;
  maxPayloadChars?: number;
  signal?: AbortSignal;
  skip?: (name: string) => boolean;
  label?: (name: string) => string | undefined;
  meta?: (toolUseId: string) => ToolCallMeta | undefined;
}

/** Provider ids may be longer than the server's 64 characters: hashed, never cut, so shared prefixes stay distinct. */
export function boundedToolUseId(id: string): string {
  return id.length > 64 ? `tc_${createHash('sha256').update(id).digest('base64url')}` : id;
}

function snapshot(value: unknown, max: number): unknown {
  const scrub = (item: unknown, depth = 0): unknown => {
    if (depth > 8) return '[depth limit]';
    if (typeof item === 'string') return item.slice(0, max).replace(/\bBearer\s+\S+|\bsk-[A-Za-z0-9_-]+/gi, '[redacted]');
    if (Array.isArray(item)) return item.slice(0, 100).map(x => scrub(x, depth + 1));
    if (item && typeof item === 'object') {
      return Object.fromEntries(Object.entries(item).slice(0, 100)
        .filter(([k]) => !/reasoning|chain.?of.?thought|signature/i.test(k))
        .map(([k, v]) => [k, /password|secret|token|api.?key|authorization|cookie/i.test(k) ? '[redacted]' : scrub(v, depth + 1)]));
    }
    return item ?? null;
  };
  const safe = scrub(value), text = JSON.stringify(safe);
  return text.length <= max ? safe : { truncated: true, preview: text.slice(0, max - 40) };
}

/**
 * Writes a row for each tool call of a segment as it changes: pending when the
 * model asks for it, running when it starts, then its end with bounded,
 * redacted input and output. A finished row never goes back to running.
 */
export function installToolCallTracker(agent: Agent, write: (row: ToolCallLine) => void, options: TrackerOptions): ToolCallTracker {
  const log = new Logger('ToolCall');
  const max = Math.max(128, Math.min(options.maxPayloadChars ?? 16000, 64000));
  const context = { ...traceContext(), conversation_id: options.conversationId ?? traceContext().conversation_id, turn_id: options.turnId };
  const metadata = (row: ToolCallLine) => ({
    tool: /^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(row.tool) ? row.tool : 'invalid_tool_name',
    // Some providers append an opaque thought signature to their id. Never log it.
    tool_call_id: `tc_${createHash('sha256').update(row.tool_use_id).digest('base64url')}`,
    status: row.status,
  });
  type Call = { row: ToolCallLine; started: number; cancelled?: boolean };
  const calls = new Map<string, Call>();

  const start = (use: { toolUseId: string; name: string; input: unknown }): Call => {
    const known = calls.get(use.toolUseId);
    if (known) return known;
    const raw = snapshot(use.input, max);
    const row: ToolCallLine = {
      kind: 'tool_call', id: randomUUID(), tool_use_id: boundedToolUseId(use.toolUseId), tool: use.name.slice(0, 128),
      label: options.label?.(use.name) ?? null, source: use.name === 'read_output' ? 'utility' : 'mcp',
      input: (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : { value: raw }) as Record<string, unknown>,
      status: 'pending', output: null, content: null, output_spilled: false, latency_ms: null, attempts: null,
      attempt_errors: null, timing: null, finished_at: null,
    };
    const call = { row, started: Date.now() };
    calls.set(use.toolUseId, call);
    return call;
  };

  agent.addHook(BeforeToolsEvent, event => {
    if (options.signal?.aborted) { event.cancel = 'Turn cancelled'; return; }
    for (const block of event.message.content) {
      if (block.type !== 'toolUseBlock' || options.skip?.(block.name)) continue;
      if (calls.has(block.toolUseId)) throw new Error('Duplicate tool_use_id in turn');
      write(start(block).row);
    }
  });

  agent.addHook(BeforeToolCallEvent, event => {
    if (options.skip?.(event.toolUse.name)) return;
    const call = start(event.toolUse);
    if (options.signal?.aborted) event.cancel = 'Turn cancelled';
    call.cancelled = !!event.cancel;
    if (call.row.status !== 'pending' && call.row.status !== 'running') return;
    call.row.status = 'running';
    write(call.row);
    log.log(JSON.stringify({ event: 'tool_call_started', ...context, ...metadata(call.row), cancelled: call.cancelled }));
  }, { order: 100 });

  const complete = (useId: string, status: string, content: unknown) => {
    const call = calls.get(useId);
    if (!call) return;
    const row = call.row;
    row.status = call.cancelled ? 'cancelled' : status === 'success' ? 'success' : 'failed';
    row.latency_ms = Date.now() - call.started;
    const bounded = snapshot(content, max);
    row.content = Array.isArray(bounded) ? bounded : [{ text: JSON.stringify(bounded) }];
    row.output = JSON.stringify(bounded).slice(0, max);
    row.output_spilled = [...(options.ownedOutputIds ?? [])].some(id => JSON.stringify(content).includes(id));
    const meta = options.meta?.(useId);
    row.attempts = meta?.attempts ?? 1;
    row.timing = meta?.timing ?? null;
    row.attempt_errors = meta?.attemptErrors ?? [];
    if (meta?.label) row.label = meta.label;
    row.finished_at = new Date().toISOString();
    write(row);
    log.log(JSON.stringify({ event: 'tool_call_completed', ...context, ...metadata(row), duration_ms: row.latency_ms }));
  };

  agent.addHook(AfterToolCallEvent, event => {
    if (event.retry) return;
    complete(event.toolUse.toolUseId, event.result.status, event.result.toJSON().toolResult.content);
  }, { order: 100 });
  // A result the SDK made without running the tool (unknown tool, cancelled batch).
  agent.addHook(ToolResultEvent, event => {
    const call = calls.get(event.result.toolUseId);
    if (call && (call.row.status === 'pending' || call.row.status === 'running')) {
      complete(event.result.toolUseId, event.result.status, event.result.toJSON().toolResult.content);
    }
  });
  return { callId: id => calls.get(id)?.row.id };
}
