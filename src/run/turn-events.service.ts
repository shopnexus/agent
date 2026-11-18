import { Injectable, Logger } from '@nestjs/common';
import { TurnEventStore } from '../db/turn-event.repository';
import { errorDetails } from '../observability/error-details';
import { controlKey, eventsKey, EVENTS_MAXLEN, RunBus, STREAM_TTL_S } from './run-bus';
import { STOP_EVENTS, type TurnEvent, type TurnEventType } from './events';

/**
 * Publishes a turn's events: each is written to turn_events first (its seq),
 * then added to the `turn:{id}` stream for readers on any replica. A Redis
 * failure is logged and the event stays readable from PostgreSQL.
 */
@Injectable()
export class TurnEventService {
  private readonly log = new Logger(TurnEventService.name);

  constructor(private readonly store: TurnEventStore, private readonly bus: RunBus) {}

  async publish(turnId: string, type: TurnEventType, body: Record<string, unknown> = {}): Promise<TurnEvent> {
    const event = await this.store.append(turnId, type, body);
    try {
      await this.bus.add(eventsKey(turnId), { seq: String(event.seq), type, at: event.at, body: JSON.stringify(body) }, EVENTS_MAXLEN);
      // The streams go 1 h after the turn stops writing; a continued turn persists them again.
      if (STOP_EVENTS.has(type)) {
        await this.bus.expire(eventsKey(turnId), STREAM_TTL_S);
        await this.bus.expire(controlKey(turnId), STREAM_TTL_S);
      }
    } catch (error) {
      this.log.warn(JSON.stringify({ event: 'turn_event_bus_failed', turn_id: turnId, type, ...errorDetails(error) }));
    }
    return event;
  }

  /** Keeps a continued turn's streams from expiring while it runs. */
  async keep(turnId: string): Promise<void> {
    try { await this.bus.persist(eventsKey(turnId)); await this.bus.persist(controlKey(turnId)); }
    catch (error) { this.log.warn(JSON.stringify({ event: 'turn_event_bus_failed', turn_id: turnId, ...errorDetails(error) })); }
  }

  emitter(turnId: string): RunEmitter { return new RunEmitter(this, turnId); }
}

const DELTA_FLUSH_MS = 120;
const DELTA_FLUSH_CHARS = 400;

/**
 * One run's writer: events go out in the order emitted, and text deltas are
 * merged (about every 120 ms or 400 characters) so a streamed draft is tens
 * of rows, not thousands.
 */
export class RunEmitter {
  private readonly log = new Logger('RunEmitter');
  private queue: Promise<unknown> = Promise.resolve();
  private delta = '';
  private timer?: NodeJS.Timeout;

  constructor(private readonly events: TurnEventService, private readonly turnId: string) {}

  emit(type: TurnEventType, body: Record<string, unknown> = {}): void {
    this.flushDelta();
    this.push(type, body);
  }

  textDelta(text: string): void {
    if (!text) return;
    this.delta += text;
    if (this.delta.length >= DELTA_FLUSH_CHARS) this.flushDelta();
    else if (!this.timer) this.timer = setTimeout(() => this.flushDelta(), DELTA_FLUSH_MS);
  }

  /** Waits until every emitted event is written. */
  async flush(): Promise<void> {
    this.flushDelta();
    await this.queue;
  }

  private flushDelta() {
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
    if (!this.delta) return;
    const delta = this.delta;
    this.delta = '';
    this.push('text.delta', { delta });
  }

  private push(type: TurnEventType, body: Record<string, unknown>) {
    this.queue = this.queue.then(() => this.events.publish(this.turnId, type, body)).catch(error => {
      this.log.error(JSON.stringify({ event: 'turn_event_write_failed', turn_id: this.turnId, type, ...errorDetails(error) }));
    });
  }
}
