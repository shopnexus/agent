import { AsyncLocalStorage } from 'node:async_hooks';

export interface TraceContext {
  trace_id: string;
  conversation_id: string;
  turn_id?: string;
}
const storage = new AsyncLocalStorage<TraceContext>();

/** Internal IDs only: no request bodies or actor/private data in this context. */
export function withTraceContext<T>(context: TraceContext, action: () => T): T {
  return storage.run({...context}, action);
}
export function traceContext(): Partial<TraceContext> {
  return {...storage.getStore()};
}
export function attachTurnId(turnId: string): void {
  const context=storage.getStore();
  if (context) context.turn_id=turnId;
}
