export type DuplicateKind = 'idempotent_replay' | 'inbox_duplicate';
export type RetryComponent = 'db_transaction' | 'sqs_consumer' | 'outbox' | 'pending_reference';

/** Metrics port implemented by the Prometheus adapter. Labels never carry ids or amounts. */
export interface AppMetrics {
  transactionCompleted(labels: { kind: string; status: string; source: string; replay: boolean }, seconds: number): void;
  duplicateDetected(kind: DuplicateKind): void;
  idempotencyConflict(): void;
  lockConflict(reason: string): void;
  retry(component: RetryComponent): void;
  deadLettered(reason: string): void;
  messageConsumed(outcome: string): void;
  outboxPublished(count: number): void;
  outboxPublishFailed(count: number): void;
  outboxState(pending: number, lagSeconds: number): void;
  pendingReferenceResolved(outcome: string): void;
  reconciliationChecked(consistent: boolean): void;
}
