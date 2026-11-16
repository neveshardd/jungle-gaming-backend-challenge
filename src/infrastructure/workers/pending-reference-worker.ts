import type { AppConfig } from '../../config/config';
import { runWithContext } from '../../observability/context';
import { ApplicationError } from '../../shared/application/errors';
import type { Logger } from '../../shared/application/logger';
import type { UnitOfWork } from '../../shared/application/unit-of-work';
import type { ResolvePendingReferenceUseCase } from '../../wagering/application/resolve-pending-reference';

/**
 * Scheduled worker that re-evaluates PENDING_REFERENCE transactions whose backoff expired.
 * Transient errors are left for the next tick (attempts are not consumed because the SQL
 * transaction rolled back). Non-transient unexpected errors mark the transaction FAILED
 * (terminal, auditable) instead of looping forever.
 */
export class PendingReferenceWorker {
  constructor(
    private readonly deps: {
      uow: UnitOfWork;
      resolver: ResolvePendingReferenceUseCase;
      config: AppConfig['pendingReference'];
      logger: Logger;
    },
  ) {}

  async runOnce(): Promise<boolean> {
    const due = await this.deps.uow.read((r) => r.transactions.findDuePendingReferences(this.deps.config.batchSize));
    for (const id of due) {
      await runWithContext({ transactionId: id }, async () => {
        try {
          await this.deps.resolver.resolve(id);
        } catch (err) {
          if (err instanceof ApplicationError && err.category === 'transient') {
            this.deps.logger.warn({ reason: err.message }, 'pending reference resolution deferred (transient)');
            return;
          }
          this.deps.logger.error({ reason: err instanceof Error ? err.message : String(err) }, 'pending reference failed permanently');
          await this.deps.resolver.markFailed(id, err instanceof Error ? err.message : String(err));
        }
      });
    }
    return due.length >= this.deps.config.batchSize;
  }
}
