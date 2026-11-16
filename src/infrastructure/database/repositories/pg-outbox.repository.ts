import type { OutboxRepository, OutboxStore } from '../../../messaging/application/ports';
import { OutboxMessage } from '../../../messaging/domain/outbox-message';
import { type SqlExecutor, toDate, toOptionalDate } from '../sql-executor';

interface OutboxRow {
  id: string;
  aggregate_id: string;
  partition_key: string;
  event_type: string;
  payload: Record<string, unknown>;
  occurred_at: Date;
  attempts: number;
  next_attempt_at: Date;
  published_at: Date | null;
}

function toDomain(row: OutboxRow): OutboxMessage {
  return OutboxMessage.rehydrate({
    id: row.id,
    aggregateId: row.aggregate_id,
    partitionKey: row.partition_key,
    eventType: row.event_type,
    payload: row.payload,
    occurredAt: toDate(row.occurred_at),
    attempts: row.attempts,
    nextAttemptAt: toDate(row.next_attempt_at),
    publishedAt: toOptionalDate(row.published_at),
  });
}

/** Write side, used inside the business transaction. */
export class PgOutboxRepository implements OutboxRepository {
  constructor(private readonly sql: SqlExecutor) {}

  async enqueue(messages: readonly OutboxMessage[]): Promise<void> {
    for (const m of messages) {
      await this.sql.execute(
        `INSERT INTO outbox_messages
           (id, aggregate_id, partition_key, event_type, payload, occurred_at, attempts, next_attempt_at)
         VALUES (?, ?, ?, ?, ?::jsonb, ?, ?, ?)`,
        [
          m.id,
          m.aggregateId,
          m.partitionKey,
          m.eventType,
          JSON.stringify(m.payload),
          m.occurredAt,
          m.attempts,
          m.nextAttemptAt ?? m.occurredAt,
        ],
      );
    }
  }
}

/**
 * Publisher side (autocommit statements). Claiming is a lease: rows are stamped with
 * locked_by/locked_until in a single UPDATE over a `FOR UPDATE SKIP LOCKED` sub-select, so
 * concurrent publishers never pick the same row, and a publisher that dies after claiming
 * only delays the rows until the lease expires — another instance then takes them over.
 * All time comparisons use the database clock.
 */
export class PgOutboxStore implements OutboxStore {
  constructor(private readonly sql: SqlExecutor) {}

  async claimDue(owner: string, limit: number, leaseMs: number): Promise<OutboxMessage[]> {
    const rows = await this.sql.query<OutboxRow>(
      `UPDATE outbox_messages o
         SET locked_by = ?, locked_until = now() + (?::int * interval '1 millisecond')
       WHERE o.id IN (
         SELECT id FROM outbox_messages
         WHERE published_at IS NULL
           AND next_attempt_at <= now()
           AND (locked_until IS NULL OR locked_until < now())
         ORDER BY occurred_at, id
         LIMIT ?
         FOR UPDATE SKIP LOCKED)
       RETURNING o.id, o.aggregate_id, o.partition_key, o.event_type, o.payload, o.occurred_at,
                 o.attempts, o.next_attempt_at, o.published_at`,
      [owner, leaseMs, limit],
    );
    return rows.map(toDomain).sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime());
  }

  async markPublished(messages: readonly OutboxMessage[], owner: string): Promise<number> {
    if (messages.length === 0) return 0;
    return this.sql.execute(
      `UPDATE outbox_messages
         SET published_at = now(), locked_by = NULL, locked_until = NULL, last_error = NULL
       WHERE id = ANY(?::uuid[]) AND locked_by = ? AND published_at IS NULL`,
      [messages.map((m) => m.id), owner],
    );
  }

  async reschedule(message: OutboxMessage, owner: string, error: string): Promise<void> {
    await this.sql.execute(
      `UPDATE outbox_messages
         SET attempts = ?, next_attempt_at = ?, locked_by = NULL, locked_until = NULL, last_error = ?
       WHERE id = ? AND locked_by = ? AND published_at IS NULL`,
      [message.attempts, message.nextAttemptAt, error.slice(0, 1000), message.id, owner],
    );
  }

  async stats(): Promise<{ pending: number; oldestAgeSeconds: number }> {
    const row = await this.sql.one<{ pending: number; lag: number }>(
      `SELECT count(*)::int AS pending,
              COALESCE(EXTRACT(EPOCH FROM (now() - min(occurred_at))), 0)::float8 AS lag
       FROM outbox_messages WHERE published_at IS NULL`,
    );
    return { pending: row?.pending ?? 0, oldestAgeSeconds: row?.lag ?? 0 };
  }
}
