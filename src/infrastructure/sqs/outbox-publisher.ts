import { type SendMessageBatchRequestEntry, SendMessageBatchCommand, type SQSClient } from '@aws-sdk/client-sqs';
import type { AppConfig } from '../../config/config';
import { injectTraceContext, withSpan } from '../../observability/tracing';
import type { Logger } from '../../shared/application/logger';
import type { AppMetrics } from '../../shared/application/metrics';
import type { Clock } from '../../shared/domain/clock';
import type { OutboxStore } from '../../messaging/application/ports';
import type { OutboxMessage } from '../../messaging/domain/outbox-message';

const SQS_BATCH_LIMIT = 10;

/**
 * Publishes committed outbox rows to wallet-events.fifo.
 *
 * - Many publishers may run concurrently (one per instance): rows are leased with
 *   FOR UPDATE SKIP LOCKED, so each row is handled by one publisher at a time.
 * - A publisher that crashes after publishing but before marking the row leaves it leased;
 *   when the lease expires another instance republishes it. Delivery is therefore
 *   at-least-once: MessageDeduplicationId = eventId lets SQS FIFO drop most duplicates and
 *   consumers deduplicate by eventId for the rest.
 * - Failures are rescheduled with exponential backoff (OutboxMessage.scheduleRetry).
 */
export class OutboxPublisher {
  constructor(
    private readonly deps: {
      store: OutboxStore;
      sqs: SQSClient;
      queueUrl: string;
      owner: string;
      config: AppConfig['outbox'];
      clock: Clock;
      metrics: AppMetrics;
      logger: Logger;
    },
  ) {}

  /** One claim/publish cycle. Returns true when a full batch was processed (more may be waiting). */
  async publishOnce(): Promise<boolean> {
    const { store, owner, config } = this.deps;
    const claimed = await store.claimDue(owner, config.batchSize, config.leaseMs);
    if (claimed.length === 0) return false;

    await withSpan('outbox.publish', { 'outbox.batch_size': claimed.length }, async () => {
      for (let i = 0; i < claimed.length; i += SQS_BATCH_LIMIT) {
        await this.publishChunk(claimed.slice(i, i + SQS_BATCH_LIMIT));
      }
    });
    return claimed.length >= config.batchSize;
  }

  private async publishChunk(chunk: OutboxMessage[]): Promise<void> {
    const trace = injectTraceContext();
    const entries: SendMessageBatchRequestEntry[] = chunk.map((m, index) => ({
      Id: `m${index}`,
      MessageBody: JSON.stringify(m.payload),
      MessageGroupId: m.partitionKey,
      MessageDeduplicationId: m.id,
      MessageAttributes: {
        eventType: { DataType: 'String', StringValue: m.eventType },
        eventId: { DataType: 'String', StringValue: m.id },
        ...Object.fromEntries(
          Object.entries(trace).map(([k, v]) => [k, { DataType: 'String', StringValue: v }]),
        ),
      },
    }));

    const failed = new Map<string, string>();
    try {
      const result = await this.deps.sqs.send(new SendMessageBatchCommand({ QueueUrl: this.deps.queueUrl, Entries: entries }));
      for (const failure of result.Failed ?? []) {
        if (failure.Id) failed.set(failure.Id, `${failure.Code ?? 'error'}: ${failure.Message ?? ''}`);
      }
    } catch (err) {
      for (const entry of entries) failed.set(entry.Id ?? '', String(err));
    }

    const published = chunk.filter((_, index) => !failed.has(`m${index}`));
    if (published.length > 0) {
      const now = this.deps.clock.now();
      for (const m of published) m.markPublished(now);
      await this.deps.store.markPublished(published, this.deps.owner);
      this.deps.metrics.outboxPublished(published.length);
    }

    for (const [index, m] of chunk.entries()) {
      const reason = failed.get(`m${index}`);
      if (reason === undefined) continue;
      m.scheduleRetry(this.deps.clock.now(), {
        baseDelayMs: this.deps.config.retryBaseMs,
        maxDelayMs: this.deps.config.retryMaxMs,
      });
      await this.deps.store.reschedule(m, this.deps.owner, reason);
      this.deps.metrics.outboxPublishFailed(1);
      this.deps.metrics.retry('outbox');
      this.deps.logger.warn({ eventId: m.id, eventType: m.eventType, attempts: m.attempts, reason }, 'outbox publish failed; rescheduled');
    }
  }
}
