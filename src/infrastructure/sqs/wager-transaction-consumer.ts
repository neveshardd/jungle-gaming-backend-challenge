import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  type Message,
  ReceiveMessageCommand,
  SendMessageCommand,
  type SQSClient,
} from '@aws-sdk/client-sqs';
import type { AppConfig } from '../../config/config';
import { runWithContext } from '../../observability/context';
import { withExtractedTraceContext, withSpan } from '../../observability/tracing';
import { ApplicationError } from '../../shared/application/errors';
import type { Logger } from '../../shared/application/logger';
import type { AppMetrics } from '../../shared/application/metrics';
import { DomainError } from '../../shared/domain/errors';
import { exponentialBackoffMs, jittered, sleep } from '../../shared/util/async';
import type { ProcessWagerTransactionUseCase } from '../../wagering/application/process-wager-transaction';
import { hashMessage, wagerMessageSchema, type WagerMessage } from './message-contract';
import type { QueueUrls } from './queue-topology';

export type ErrorDisposition = 'business' | 'transient' | 'permanent';

/**
 * Business errors are terminal: ack. Transient errors: retry with backoff (visibility).
 * Permanent errors (broken contract, inbox payload mismatch, programming errors): DLQ.
 * Unknown errors are treated as transient until the attempt budget is exhausted, then DLQ.
 */
export function classifyConsumerError(err: unknown): ErrorDisposition {
  if (err instanceof ApplicationError) {
    switch (err.category) {
      case 'not_found':
      case 'conflict':
        return 'business';
      case 'transient':
        return 'transient';
      case 'validation':
      case 'permanent':
        return 'permanent';
    }
  }
  if (err instanceof DomainError) return 'permanent';
  return 'transient';
}

export type HandleOutcome = 'processed' | 'duplicate' | 'business_error' | 'retry' | 'dead_lettered';

export interface ConsumerDeps {
  sqs: SQSClient;
  queues: QueueUrls;
  config: AppConfig['sqs'];
  faults: AppConfig['faults'];
  useCase: ProcessWagerTransactionUseCase;
  metrics: AppMetrics;
  logger: Logger;
}

/**
 * Long-polling consumer of wager-transactions.fifo. Reuses ProcessWagerTransactionUseCase
 * (same code path as HTTP), deduplicates through the persistent inbox inside the same SQL
 * transaction, and deletes (acks) a message only after that transaction committed.
 */
export class WagerTransactionConsumer {
  private running = false;
  private abort = new AbortController();
  private loops: Promise<void>[] = [];

  constructor(private readonly deps: ConsumerDeps) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.abort = new AbortController();
    for (let i = 0; i < this.deps.config.concurrency; i++) this.loops.push(this.pollLoop(i));
    this.deps.logger.info({ concurrency: this.deps.config.concurrency }, 'sqs consumer started');
  }

  /**
   * Graceful stop (SIGTERM): stop polling, let in-flight messages finish, return the
   * visibility of received-but-not-started messages. If the grace period expires, pending
   * work is abandoned — unacked messages simply reappear after their visibility timeout.
   */
  async stop(graceMs: number): Promise<void> {
    if (!this.running) return;
    this.running = false;
    this.abort.abort();
    const loops = Promise.allSettled(this.loops);
    await Promise.race([loops, sleep(graceMs)]);
    this.loops = [];
    this.deps.logger.info({}, 'sqs consumer stopped');
  }

  private async pollLoop(worker: number): Promise<void> {
    while (this.running) {
      let messages: Message[];
      try {
        const result = await this.deps.sqs.send(
          new ReceiveMessageCommand({
            QueueUrl: this.deps.queues.input,
            MaxNumberOfMessages: this.deps.config.batchSize,
            WaitTimeSeconds: this.deps.config.waitTimeSeconds,
            AttributeNames: ['All'],
            MessageAttributeNames: ['All'],
          }),
          { abortSignal: this.abort.signal },
        );
        messages = result.Messages ?? [];
      } catch (err) {
        if (!this.running) break;
        this.deps.metrics.retry('sqs_consumer');
        this.deps.logger.warn({ worker, reason: String(err) }, 'sqs receive failed; backing off');
        await sleep(1000);
        continue;
      }
      for (const [index, message] of messages.entries()) {
        if (!this.running) {
          await this.release(messages.slice(index));
          break;
        }
        await this.handle(message);
      }
    }
  }

  /** Processes one SQS message end to end. Public for deterministic tests. */
  async handle(message: Message): Promise<HandleOutcome> {
    const receiveCount = Number.parseInt(message.Attributes?.ApproximateReceiveCount ?? '1', 10);
    const traceCarrier: Record<string, string> = {};
    for (const [key, value] of Object.entries(message.MessageAttributes ?? {})) {
      if (value.StringValue) traceCarrier[key] = value.StringValue;
    }

    let envelope: WagerMessage;
    try {
      envelope = wagerMessageSchema.parse(JSON.parse(message.Body ?? ''));
    } catch (err) {
      this.deps.logger.error({ sqsMessageId: message.MessageId, reason: summarize(err) }, 'invalid message contract');
      await this.deadLetter(message, 'INVALID_MESSAGE');
      return 'dead_lettered';
    }

    const { data } = envelope;
    return runWithContext(
      { correlationId: envelope.messageId, messageId: envelope.messageId, walletId: data.walletId, providerId: data.providerId },
      () =>
        withExtractedTraceContext(traceCarrier, () =>
          withSpan('sqs.consume.wager_transaction', { 'messaging.message.id': envelope.messageId }, async () => {
            const stopHeartbeat = this.startHeartbeat(message);
            try {
              const { idempotencyKey, ...payload } = data;
              const outcome = await this.deps.useCase.execute({
                idempotencyKey,
                payload,
                source: 'sqs',
                correlationId: envelope.messageId,
                causationId: envelope.messageId,
                inbox: {
                  consumerName: this.deps.config.consumerName,
                  messageId: envelope.messageId,
                  payloadHash: hashMessage(envelope),
                },
              });
              stopHeartbeat();
              if (this.deps.faults.crashAfterCommitBeforeAck) {
                // Test-only: simulate the process dying after COMMIT and before the ack.
                this.deps.logger.warn({}, 'FAULT INJECTION: killing process after commit, before ack');
                process.kill(process.pid, 'SIGKILL');
                await sleep(10_000);
              }
              await this.ack(message);
              const result: HandleOutcome = outcome.type === 'duplicate_message' ? 'duplicate' : 'processed';
              this.deps.metrics.messageConsumed(result);
              return result;
            } catch (err) {
              stopHeartbeat();
              return this.onFailure(message, receiveCount, err);
            }
          }),
        ),
    );
  }

  private async onFailure(message: Message, receiveCount: number, err: unknown): Promise<HandleOutcome> {
    const disposition = classifyConsumerError(err);
    const code = err instanceof ApplicationError || err instanceof DomainError ? err.code : 'UNEXPECTED';
    if (disposition === 'business') {
      this.deps.logger.warn({ code, receiveCount }, 'business rejection; acking message');
      await this.ack(message);
      this.deps.metrics.messageConsumed('business_error');
      return 'business_error';
    }
    if (disposition === 'permanent' || receiveCount >= this.deps.config.maxAttempts) {
      const reason = disposition === 'permanent' ? code : 'MAX_ATTEMPTS_EXCEEDED';
      this.deps.logger.error({ code, receiveCount, reason }, 'moving message to DLQ');
      await this.deadLetter(message, reason);
      return 'dead_lettered';
    }
    const delaySeconds = Math.ceil(
      jittered(
        exponentialBackoffMs(receiveCount, this.deps.config.retryBaseSeconds * 1000, this.deps.config.retryMaxSeconds * 1000),
      ) / 1000,
    );
    this.deps.metrics.retry('sqs_consumer');
    this.deps.metrics.messageConsumed('retry');
    this.deps.logger.warn({ code, receiveCount, delaySeconds, reason: summarize(err) }, 'transient failure; message will be retried');
    await this.changeVisibility(message, delaySeconds);
    return 'retry';
  }

  private startHeartbeat(message: Message): () => void {
    const visibility = this.deps.config.visibilityTimeoutSeconds;
    const timer = setInterval(() => {
      void this.changeVisibility(message, visibility);
    }, Math.max(1000, (visibility * 1000) / 2));
    return () => clearInterval(timer);
  }

  private async ack(message: Message): Promise<void> {
    await this.deps.sqs.send(
      new DeleteMessageCommand({ QueueUrl: this.deps.queues.input, ReceiptHandle: message.ReceiptHandle }),
    );
  }

  private async changeVisibility(message: Message, seconds: number): Promise<void> {
    try {
      await this.deps.sqs.send(
        new ChangeMessageVisibilityCommand({
          QueueUrl: this.deps.queues.input,
          ReceiptHandle: message.ReceiptHandle,
          VisibilityTimeout: Math.max(0, Math.min(seconds, 43_200)),
        }),
      );
    } catch (err) {
      // Not fatal: the message returns after its current visibility timeout anyway.
      this.deps.logger.warn({ reason: String(err) }, 'could not change message visibility');
    }
  }

  private async release(messages: Message[]): Promise<void> {
    await Promise.all(messages.map((m) => this.changeVisibility(m, 0)));
  }

  private async deadLetter(message: Message, reason: string): Promise<void> {
    await this.deps.sqs.send(
      new SendMessageCommand({
        QueueUrl: this.deps.queues.deadLetter,
        MessageBody: message.Body ?? '',
        MessageGroupId: message.Attributes?.MessageGroupId ?? 'dead-letter',
        MessageDeduplicationId: message.MessageId ?? `${Date.now()}`,
        MessageAttributes: {
          failureReason: { DataType: 'String', StringValue: reason },
          receiveCount: { DataType: 'Number', StringValue: message.Attributes?.ApproximateReceiveCount ?? '1' },
        },
      }),
    );
    await this.ack(message);
    this.deps.metrics.deadLettered(reason);
    this.deps.metrics.messageConsumed('dead_lettered');
  }
}

function summarize(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}`.slice(0, 300) : String(err).slice(0, 300);
}
