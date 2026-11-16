import { GetQueueAttributesCommand, type SQSClient } from '@aws-sdk/client-sqs';
import { withTimeout } from '../../shared/util/async';
import type { SqlExecutor } from '../database/sql-executor';

export interface ReadinessReport {
  status: 'ok' | 'unavailable';
  checks: Record<string, { status: 'ok' | 'error'; error?: string }>;
}

export class HealthCheck {
  private draining = false;

  constructor(
    private readonly db: SqlExecutor,
    private readonly sqs: SQSClient,
    private readonly queueUrl: string,
  ) {}

  /** Called on SIGTERM: readiness turns red so the load balancer stops routing traffic. */
  markDraining(): void {
    this.draining = true;
  }

  async readiness(): Promise<ReadinessReport> {
    const [postgres, sqs] = await Promise.all([
      this.probe(() => this.db.query('SELECT 1')),
      this.probe(() =>
        this.sqs.send(new GetQueueAttributesCommand({ QueueUrl: this.queueUrl, AttributeNames: ['QueueArn'] })),
      ),
    ]);
    const checks: ReadinessReport['checks'] = { postgres, sqs };
    if (this.draining) checks.lifecycle = { status: 'error', error: 'shutting down' };
    const ok = Object.values(checks).every((c) => c.status === 'ok');
    return { status: ok ? 'ok' : 'unavailable', checks };
  }

  private async probe(fn: () => Promise<unknown>): Promise<{ status: 'ok' | 'error'; error?: string }> {
    try {
      await withTimeout(fn(), 2000, 'health probe');
      return { status: 'ok' };
    } catch (err) {
      return { status: 'error', error: err instanceof Error ? err.message : String(err) };
    }
  }
}
