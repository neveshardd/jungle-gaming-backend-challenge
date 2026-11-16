import {
  CreateQueueCommand,
  GetQueueAttributesCommand,
  GetQueueUrlCommand,
  type SQSClient,
} from '@aws-sdk/client-sqs';
import type { AppConfig } from '../../config/config';

export interface QueueUrls {
  input: string;
  deadLetter: string;
  events: string;
}

/**
 * Declares (idempotently) the FIFO queues:
 *   - wager-transactions.fifo      input, redrive to the DLQ after maxReceiveCount
 *   - wager-transactions-dlq.fifo  dead letters
 *   - wallet-events.fifo           integration events published by the outbox
 *
 * The consumer moves messages to the DLQ itself after SQS_MAX_ATTEMPTS; the native redrive
 * policy (maxAttempts + 2) is a safety net for crash loops where the consumer never gets
 * the chance to decide.
 */
export class QueueTopology {
  constructor(
    private readonly sqs: SQSClient,
    private readonly config: AppConfig['sqs'],
  ) {}

  async ensure(): Promise<QueueUrls> {
    const deadLetter = await this.create(this.config.deadLetterQueue, {});
    const dlqArn = await this.arnOf(deadLetter);
    const input = await this.create(this.config.inputQueue, {
      VisibilityTimeout: String(this.config.visibilityTimeoutSeconds),
      RedrivePolicy: JSON.stringify({
        deadLetterTargetArn: dlqArn,
        maxReceiveCount: String(this.config.maxAttempts + 2),
      }),
    });
    const events = await this.create(this.config.eventsQueue, {});
    return { input, deadLetter, events };
  }

  async resolve(): Promise<QueueUrls> {
    const [input, deadLetter, events] = await Promise.all([
      this.urlOf(this.config.inputQueue),
      this.urlOf(this.config.deadLetterQueue),
      this.urlOf(this.config.eventsQueue),
    ]);
    return { input, deadLetter, events };
  }

  private async create(name: string, attributes: Record<string, string>): Promise<string> {
    try {
      const result = await this.sqs.send(
        new CreateQueueCommand({
          QueueName: name,
          Attributes: { FifoQueue: 'true', ContentBasedDeduplication: 'false', ...attributes },
        }),
      );
      if (!result.QueueUrl) throw new Error(`could not create queue ${name}`);
      return result.QueueUrl;
    } catch (err) {
      // The queue already exists with other attributes (e.g. another instance configured a different
      // visibility timeout): keep the existing queue. The consumer sets visibility per message anyway.
      const errorName = err instanceof Error ? err.name : '';
      if (errorName === 'QueueNameExists' || errorName === 'QueueAlreadyExists') return this.urlOf(name);
      throw err;
    }
  }

  private async urlOf(name: string): Promise<string> {
    const result = await this.sqs.send(new GetQueueUrlCommand({ QueueName: name }));
    if (!result.QueueUrl) throw new Error(`queue ${name} not found`);
    return result.QueueUrl;
  }

  private async arnOf(queueUrl: string): Promise<string> {
    const result = await this.sqs.send(
      new GetQueueAttributesCommand({ QueueUrl: queueUrl, AttributeNames: ['QueueArn'] }),
    );
    const arn = result.Attributes?.QueueArn;
    if (!arn) throw new Error(`queue ${queueUrl} has no ARN`);
    return arn;
  }
}
