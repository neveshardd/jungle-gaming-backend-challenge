import { collectDefaultMetrics, Counter, Gauge, Histogram, Registry } from 'prom-client';
import type { AppMetrics, DuplicateKind, RetryComponent } from '../shared/application/metrics';

/** Prometheus adapter. Exposed on GET /metrics. Labels are low-cardinality (no ids, no amounts). */
export class PrometheusMetrics implements AppMetrics {
  readonly registry = new Registry();

  private readonly transactions = new Counter({
    name: 'wagering_transactions_total',
    help: 'Wager transactions completed, by kind, resulting status, source and replay flag',
    labelNames: ['kind', 'status', 'source', 'replay'] as const,
    registers: [this.registry],
  });
  private readonly latency = new Histogram({
    name: 'wagering_processing_duration_seconds',
    help: 'End-to-end processing latency of a wager transaction (validation + SQL transaction)',
    labelNames: ['source', 'status'] as const,
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
    registers: [this.registry],
  });
  private readonly duplicates = new Counter({
    name: 'wagering_duplicates_detected_total',
    help: 'Duplicates detected (idempotent replays and inbox duplicates)',
    labelNames: ['kind'] as const,
    registers: [this.registry],
  });
  private readonly idempotencyConflicts = new Counter({
    name: 'wagering_idempotency_conflicts_total',
    help: 'Same idempotency key received with a different payload',
    registers: [this.registry],
  });
  private readonly lockConflicts = new Counter({
    name: 'wagering_lock_conflicts_total',
    help: 'Database lock conflicts (deadlock, lock timeout, serialization, unique race)',
    labelNames: ['reason'] as const,
    registers: [this.registry],
  });
  private readonly retries = new Counter({
    name: 'wagering_retries_total',
    help: 'Retries by component',
    labelNames: ['component'] as const,
    registers: [this.registry],
  });
  private readonly dlq = new Counter({
    name: 'wagering_dlq_messages_total',
    help: 'Messages sent to the dead-letter queue',
    labelNames: ['reason'] as const,
    registers: [this.registry],
  });
  private readonly consumed = new Counter({
    name: 'wagering_sqs_messages_total',
    help: 'Messages handled by the SQS consumer, by outcome',
    labelNames: ['outcome'] as const,
    registers: [this.registry],
  });
  private readonly outboxPublishedTotal = new Counter({
    name: 'wagering_outbox_published_total',
    help: 'Outbox events published',
    registers: [this.registry],
  });
  private readonly outboxFailures = new Counter({
    name: 'wagering_outbox_publish_failures_total',
    help: 'Outbox events whose publication failed and were rescheduled',
    registers: [this.registry],
  });
  private readonly outboxPending = new Gauge({
    name: 'wagering_outbox_pending',
    help: 'Outbox events not yet published',
    registers: [this.registry],
  });
  private readonly outboxLag = new Gauge({
    name: 'wagering_outbox_lag_seconds',
    help: 'Age of the oldest unpublished outbox event',
    registers: [this.registry],
  });
  private readonly pendingReference = new Counter({
    name: 'wagering_pending_reference_resolutions_total',
    help: 'Outcomes of PENDING_REFERENCE re-evaluations',
    labelNames: ['outcome'] as const,
    registers: [this.registry],
  });
  private readonly reconciliations = new Counter({
    name: 'wagering_reconciliations_total',
    help: 'Wallet reconciliations by result',
    labelNames: ['result'] as const,
    registers: [this.registry],
  });

  constructor(instanceId?: string) {
    // Lets a scraper behind a load balancer tell replicas apart (load test aggregates per instance).
    if (instanceId) this.registry.setDefaultLabels({ instance: instanceId });
    try {
      collectDefaultMetrics({ register: this.registry, prefix: 'wagering_process_' });
    } catch {
      // Some runtime collectors may be unavailable under Bun; business metrics still work.
    }
  }

  transactionCompleted(labels: { kind: string; status: string; source: string; replay: boolean }, seconds: number): void {
    this.transactions.inc({ ...labels, replay: String(labels.replay) });
    this.latency.observe({ source: labels.source, status: labels.status }, seconds);
  }
  duplicateDetected(kind: DuplicateKind): void {
    this.duplicates.inc({ kind });
  }
  idempotencyConflict(): void {
    this.idempotencyConflicts.inc();
  }
  lockConflict(reason: string): void {
    this.lockConflicts.inc({ reason });
  }
  retry(component: RetryComponent): void {
    this.retries.inc({ component });
  }
  deadLettered(reason: string): void {
    this.dlq.inc({ reason });
  }
  messageConsumed(outcome: string): void {
    this.consumed.inc({ outcome });
  }
  outboxPublished(count: number): void {
    this.outboxPublishedTotal.inc(count);
  }
  outboxPublishFailed(count: number): void {
    this.outboxFailures.inc(count);
  }
  outboxState(pending: number, lagSeconds: number): void {
    this.outboxPending.set(pending);
    this.outboxLag.set(lagSeconds);
  }
  pendingReferenceResolved(outcome: string): void {
    this.pendingReference.inc({ outcome });
  }
  reconciliationChecked(consistent: boolean): void {
    this.reconciliations.inc({ result: consistent ? 'consistent' : 'divergent' });
  }

  /** Reads a counter value (tests / load report). */
  async counterValue(name: string, labels: Record<string, string> = {}): Promise<number> {
    const metric = await this.registry.getSingleMetric(name)?.get();
    if (!metric) return 0;
    return metric.values
      .filter((v) => Object.entries(labels).every(([k, val]) => String(v.labels[k]) === val))
      .reduce((sum, v) => sum + v.value, 0);
  }
}
