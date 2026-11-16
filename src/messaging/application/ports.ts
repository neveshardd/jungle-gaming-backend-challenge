import type { InboxMessage } from '../domain/inbox-message';
import type { OutboxMessage } from '../domain/outbox-message';

export type InboxReceipt = { duplicate: false } | { duplicate: true; existing: InboxMessage };

export interface InboxRepository {
  /** INSERT ... ON CONFLICT (consumer_name, message_id) DO NOTHING. */
  receive(message: InboxMessage): Promise<InboxReceipt>;
  markProcessed(message: InboxMessage): Promise<void>;
}

export interface OutboxRepository {
  enqueue(messages: readonly OutboxMessage[]): Promise<void>;
}

/** Publisher-side access to the outbox (runs outside business transactions). */
export interface OutboxStore {
  /** Leases due messages with FOR UPDATE SKIP LOCKED; safe with N concurrent publishers. */
  claimDue(owner: string, limit: number, leaseMs: number): Promise<OutboxMessage[]>;
  markPublished(messages: readonly OutboxMessage[], owner: string): Promise<number>;
  reschedule(message: OutboxMessage, owner: string, error: string): Promise<void>;
  stats(): Promise<{ pending: number; oldestAgeSeconds: number }>;
}
