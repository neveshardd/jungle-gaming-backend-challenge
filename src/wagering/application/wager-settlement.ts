import { OutboxMessage } from '../../messaging/domain/outbox-message';
import type { EventContext, IntegrationEvent } from '../../messaging/domain/integration-event';
import {
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WalletBalanceChanged,
} from '../../messaging/domain/wagering-events';
import type { TransactionalRepositories } from '../../shared/application/unit-of-work';
import type { IdGenerator } from '../../shared/domain/ids';
import { LedgerDirection } from '../../wallet/domain/ledger-direction';
import type { Wallet } from '../../wallet/domain/wallet';
import { FailureCode } from '../domain/failure-code';
import type { ReferenceRetryPolicy } from '../domain/reference-retry-policy';
import { decideWager, type WagerDecision } from '../domain/wager-decision';
import type { WagerTransaction } from '../domain/wager-transaction';
import { WagerTransactionStatus } from '../domain/wager-transaction-status';

export interface SettlementContext {
  correlationId: string;
  causationId?: string | undefined;
  now: Date;
}

/**
 * Applies the business decision for one non-terminal transaction, inside the caller's SQL
 * transaction and with the wallet ALREADY LOCKED (SELECT ... FOR NO KEY UPDATE). Shared by the
 * synchronous path (HTTP/SQS) and by the pending-reference worker, so both follow exactly
 * the same rules.
 *
 * Writes: transaction state, wallet balance/version, ledger entry, outbox events.
 */
export class WagerSettlement {
  constructor(
    private readonly ids: IdGenerator,
    private readonly retryPolicy: ReferenceRetryPolicy,
  ) {}

  async settle(r: TransactionalRepositories, tx: WagerTransaction, wallet: Wallet, ctx: SettlementContext): Promise<void> {
    const reference =
      tx.referenceExternalTransactionId !== undefined
        ? await r.transactions.findByExternalId(tx.providerId, tx.referenceExternalTransactionId)
        : undefined;
    const referenceAlreadyReversed =
      reference !== undefined && tx.isReversal() ? await r.transactions.hasProcessedReversal(reference.id) : false;

    let decision: WagerDecision = decideWager({ transaction: tx, wallet, reference, referenceAlreadyReversed });
    if (decision.type === 'AWAIT_REFERENCE' && this.retryPolicy.isExhausted(tx.referenceAttempts)) {
      decision = {
        type: 'REJECT',
        code: reference ? FailureCode.ReferenceNotProcessed : FailureCode.ReferenceNotFound,
      };
    }

    const eventCtx: EventContext = {
      correlationId: ctx.correlationId,
      causationId: ctx.causationId,
      occurredAt: ctx.now,
      ids: this.ids,
    };
    const events: IntegrationEvent<unknown>[] = [];

    switch (decision.type) {
      case 'APPLY': {
        const expectedVersion = wallet.version;
        const movement = { transactionId: tx.id, entryId: this.ids.next(), money: tx.money, at: ctx.now };
        const entry =
          decision.direction === LedgerDirection.Debit ? wallet.debit(movement) : wallet.credit(movement);
        tx.markProcessed(decision.reference?.id, ctx.now, wallet.balance);
        await r.transactions.save(tx);
        await r.wallets.update(wallet, expectedVersion);
        await r.ledger.append(entry);
        events.push(WagerTransactionProcessed.from(tx, eventCtx), WalletBalanceChanged.from(wallet, entry, eventCtx));
        break;
      }
      case 'RECORD':
        tx.markProcessed(decision.reference?.id, ctx.now, wallet.balance);
        await r.transactions.save(tx);
        events.push(WagerTransactionProcessed.from(tx, eventCtx));
        break;
      case 'REJECT':
        tx.reject(decision.code, ctx.now, wallet.balance);
        await r.transactions.save(tx);
        events.push(WagerTransactionRejected.from(tx, eventCtx));
        break;
      case 'AWAIT_REFERENCE':
        tx.markPendingReference(this.retryPolicy.nextAttemptAt(tx.referenceAttempts + 1, ctx.now), ctx.now);
        await r.transactions.save(tx);
        events.push(WagerTransactionPendingReference.from(tx, eventCtx));
        break;
    }

    if (tx.status === WagerTransactionStatus.Processed) {
      // Out-of-order dependents (e.g. a REFUND that arrived before this BET) are retried right away.
      await r.transactions.expediteDependents(tx.walletId, tx.providerId, tx.externalTransactionId, ctx.now);
    }
    await r.outbox.enqueue(events.map((event) => OutboxMessage.enqueue(event)));
  }
}
