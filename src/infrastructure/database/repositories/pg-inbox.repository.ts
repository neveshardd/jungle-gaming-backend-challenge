import type { InboxReceipt, InboxRepository } from '../../../messaging/application/ports';
import { InboxMessage } from '../../../messaging/domain/inbox-message';
import { type SqlExecutor, toDate, toOptionalDate } from '../sql-executor';

interface InboxRow {
  consumer_name: string;
  message_id: string;
  payload_hash: string;
  received_at: Date;
  processed_at: Date | null;
}

export class PgInboxRepository implements InboxRepository {
  constructor(private readonly sql: SqlExecutor) {}

  async receive(message: InboxMessage): Promise<InboxReceipt> {
    // A concurrent delivery of the same message blocks on the primary key until the first commits.
    const inserted = await this.sql.query<{ message_id: string }>(
      `INSERT INTO inbox_messages (consumer_name, message_id, payload_hash, received_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (consumer_name, message_id) DO NOTHING
       RETURNING message_id`,
      [message.consumerName, message.messageId, message.payloadHash, message.receivedAt],
    );
    if (inserted.length === 1) return { duplicate: false };
    const row = await this.sql.one<InboxRow>(
      `SELECT consumer_name, message_id, payload_hash, received_at, processed_at
       FROM inbox_messages WHERE consumer_name = ? AND message_id = ?`,
      [message.consumerName, message.messageId],
    );
    if (!row) throw new Error(`inbox row ${message.messageId} disappeared`);
    return {
      duplicate: true,
      existing: InboxMessage.rehydrate({
        consumerName: row.consumer_name,
        messageId: row.message_id,
        payloadHash: row.payload_hash,
        receivedAt: toDate(row.received_at),
        processedAt: toOptionalDate(row.processed_at),
      }),
    };
  }

  async markProcessed(message: InboxMessage): Promise<void> {
    await this.sql.execute(`UPDATE inbox_messages SET processed_at = ? WHERE consumer_name = ? AND message_id = ?`, [
      message.processedAt,
      message.consumerName,
      message.messageId,
    ]);
  }
}
