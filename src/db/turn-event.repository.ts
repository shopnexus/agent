import { Injectable } from '@nestjs/common';
import { PrismaService } from './prisma.service';
import type { TurnEvent, TurnEventType } from '../run/events';

/** Where a turn's events are kept; the reader replays from it. */
export abstract class TurnEventStore {
  /** Writes the event with the turn's next seq. */
  abstract append(turnId: string, type: TurnEventType, body: Record<string, unknown>): Promise<TurnEvent>;
  /** Events with seq > afterSeq (and <= untilSeq when given), oldest first. */
  abstract after(turnId: string, afterSeq: number, limit: number, untilSeq?: number): Promise<TurnEvent[]>;
}

@Injectable()
export class TurnEventRepository extends TurnEventStore {
  constructor(private readonly prisma: PrismaService) { super(); }

  async append(turnId: string, type: TurnEventType, body: Record<string, unknown>): Promise<TurnEvent> {
    // turns.event_seq hands out seq atomically, whichever replica writes.
    const rows = await this.prisma.$queryRaw<Array<{ seq: bigint; at: Date }>>`
      WITH next AS (
        UPDATE turns SET event_seq = event_seq + 1 WHERE id = ${turnId}::uuid RETURNING event_seq
      )
      INSERT INTO turn_events (turn_id, seq, type, body)
      SELECT ${turnId}::uuid, event_seq, ${type}, ${JSON.stringify(body)}::jsonb FROM next
      RETURNING seq, at`;
    if (!rows.length) throw new Error('Turn not found');
    return { seq: Number(rows[0].seq), type, at: rows[0].at.toISOString(), body };
  }

  async after(turnId: string, afterSeq: number, limit: number, untilSeq?: number): Promise<TurnEvent[]> {
    const rows = await this.prisma.turnEvent.findMany({
      where: { turnId, seq: { gt: BigInt(afterSeq), ...(untilSeq !== undefined ? { lte: BigInt(untilSeq) } : {}) } },
      orderBy: { seq: 'asc' }, take: limit,
    });
    return rows.map(r => ({ seq: Number(r.seq), type: r.type as TurnEventType, at: r.at.toISOString(), body: (r.body ?? {}) as Record<string, unknown> }));
  }
}

/** The store in memory, for offline tests. */
export class MemoryTurnEventStore extends TurnEventStore {
  readonly events = new Map<string, TurnEvent[]>();
  async append(turnId: string, type: TurnEventType, body: Record<string, unknown>): Promise<TurnEvent> {
    const list = this.events.get(turnId) ?? [];
    const event = { seq: list.length + 1, type, at: new Date().toISOString(), body: JSON.parse(JSON.stringify(body)) };
    list.push(event);
    this.events.set(turnId, list);
    return event;
  }
  async after(turnId: string, afterSeq: number, limit: number, untilSeq?: number): Promise<TurnEvent[]> {
    return (this.events.get(turnId) ?? []).filter(e => e.seq > afterSeq && (untilSeq === undefined || e.seq <= untilSeq)).slice(0, limit);
  }
}
