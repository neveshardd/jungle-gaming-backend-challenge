import { OutboxMessage } from '../../messaging/domain/outbox-message';
import { WagerTransactionFailed } from '../../messaging/domain/wagering-events';
import type { Logger } from '../../shared/application/logger';
import type { AppMetrics } from '../../shared/application/metrics';
import type { UnitOfWork } from '../../shared/application/unit-of-work';
import type { Clock } from '../../shared/domain/clock';
import type { IdGenerator } from '../../shared/domain/ids';
import { FailureCode } from '../domain/failure-code';
import { WagerTransactionStatus } from '../domain/wager-transaction-status';
import type { WagerSettlement } from './wager-settlement';

export type ResolutionOutcome = 'processed' | 'rejected' | 'rescheduled' | 'skipped' | 'failed';

/**
 * Re-evaluates one PENDING_REFERENCE transaction. Safe with many concurrent workers:
 * the wallet row lock serializes them, and the attempt counter read before the lock is
 * compared after it — a worker that lost the race simply skips.
 */
export class ResolvePendingReferenceUseCase {
  constructor(
    private readonly deps: {
      uow: UnitOfWork;
      settlement: WagerSettlement;
      clock: Clock;
      ids: IdGenerator;
      metrics: AppMetrics;
      logger: Logger;
    },
  ) {}

  async resolve(transactionId: string): Promise<ResolutionOutcome> {
    const outcome = await this.deps.uow.run(
      async (r): Promise<ResolutionOutcome> => {
        const snapshot = await r.transactions.findById(transactionId);
        if (!snapshot || snapshot.status !== WagerTransactionStatus.PendingReference) return 'skipped';
        const wallet = await r.wallets.lockById(snapshot.walletId);
        if (!wallet) return 'skipped';
        const tx = await r.transactions.findById(transactionId);
        if (
          !tx ||
          tx.status !== WagerTransactionStatus.PendingReference ||
          tx.referenceAttempts !== snapshot.referenceAttempts
        ) {
          return 'skipped';
        }
        await this.deps.settlement.settle(r, tx, wallet, {
          correlationId: tx.idempotencyKey,
          causationId: tx.id,
          now: this.deps.clock.now(),
        });
        // settle() mutates the aggregate; re-read the status without the earlier narrowing.
        const finalStatus = tx.status as WagerTransactionStatus;
        switch (finalStatus) {
          case WagerTransactionStatus.Processed:
            return 'processed';
          case WagerTransactionStatus.Rejected:
            return 'rejected';
          default:
            return 'rescheduled';
        }
      },
      { label: 'resolve-pending-reference' },
    );
    if (outcome !== 'skipped') {
      this.deps.metrics.pendingReferenceResolved(outcome);
      this.deps.logger.info({ transactionId, outcome }, 'pending reference evaluated');
    }
    return outcome;
  }

  /** Terminal FAILED for a transaction whose processing keeps failing with a non-transient error. */
  async markFailed(transactionId: string, reason: string): Promise<void> {
    await this.deps.uow.run(async (r) => {
      const snapshot = await r.transactions.findById(transactionId);
      if (!snapshot || snapshot.isTerminal()) return;
      await r.wallets.lockById(snapshot.walletId);
      const tx = await r.transactions.findById(transactionId);
      if (!tx || tx.isTerminal()) return;
      const now = this.deps.clock.now();
      tx.fail(FailureCode.ProcessingError, now);
      await r.transactions.save(tx);
      await r.outbox.enqueue([
        OutboxMessage.enqueue(
          WagerTransactionFailed.from(tx, {
            correlationId: tx.idempotencyKey,
            causationId: tx.id,
            occurredAt: now,
            ids: this.deps.ids,
          }),
        ),
      ]);
    });
    this.deps.metrics.pendingReferenceResolved('failed');
    this.deps.logger.error({ transactionId, reason }, 'transaction marked FAILED');
  }
}
