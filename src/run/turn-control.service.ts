import { Injectable, Logger } from '@nestjs/common';
import { errorDetails } from '../observability/error-details';
import { CONTROL_MAXLEN, controlKey, RunBus } from './run-bus';

/** A message to the replica running a turn, read before its next model call (stop at once). */
export type ControlMessage =
  | { type: 'pause'; at: number }
  | { type: 'stop'; at: number }
  | { type: 'steer'; at: number; steer_id: string; text: string };

export interface ControlWatch { stop(): Promise<void> }

function parse(fields: Record<string, string>): ControlMessage | undefined {
  const at = Number(fields.at) || 0;
  if (fields.type === 'pause' || fields.type === 'stop') return { type: fields.type, at };
  if (fields.type === 'steer' && fields.steer_id && typeof fields.text === 'string') return { type: 'steer', at, steer_id: fields.steer_id, text: fields.text };
  return undefined;
}

/** The `turn:{id}:control` stream: pause, stop and steer for a running turn. */
@Injectable()
export class TurnControlService {
  private readonly log = new Logger(TurnControlService.name);

  constructor(private readonly bus: RunBus) {}

  async send(turnId: string, message: ControlMessage): Promise<void> {
    const fields: Record<string, string> = { type: message.type, at: String(message.at) };
    if (message.type === 'steer') { fields.steer_id = message.steer_id; fields.text = message.text; }
    await this.bus.add(controlKey(turnId), fields, CONTROL_MAXLEN);
  }

  /** The id control messages after which a new run reads. */
  async cursor(turnId: string): Promise<string> {
    try { return await this.bus.lastId(controlKey(turnId)); } catch { return '0-0'; }
  }

  /**
   * Follows the control stream after `cursor` until stopped, calling `onMessage`
   * with each message and its id. A Redis outage is retried every second.
   */
  watch(turnId: string, cursor: string, onMessage: (message: ControlMessage, id: string) => void): ControlWatch {
    const reader = this.bus.reader();
    let stopped = false;
    let position = cursor;
    const loop = (async () => {
      while (!stopped) {
        try {
          const entries = await reader.read(controlKey(turnId), position, 1000, 50);
          for (const entry of entries) {
            position = entry.id;
            const message = parse(entry.fields);
            if (message && !stopped) onMessage(message, entry.id);
          }
        } catch (error) {
          if (stopped) break;
          this.log.warn(JSON.stringify({ event: 'turn_control_read_failed', turn_id: turnId, ...errorDetails(error) }));
          await new Promise(r => setTimeout(r, 1000));
        }
      }
    })();
    return { stop: async () => { stopped = true; await reader.close(); await loop; } };
  }
}
