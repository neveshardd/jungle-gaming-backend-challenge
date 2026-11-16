import type { MoneyProps } from '../../shared/domain/money';
import type { FailureCode } from '../../wagering/domain/failure-code';
import type { WagerTransaction } from '../../wagering/domain/wager-transaction';
import type { LedgerDirection } from '../../wallet/domain/ledger-direction';
import type { Wallet } from '../../wallet/domain/wallet';
import type { WalletLedgerEntry } from '../../wallet/domain/wallet-ledger-entry';
import { type EventContext, IntegrationEvent } from './integration-event';

interface TransactionRef {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: MoneyProps;
  referenceExternalTransactionId?: string;
}

function transactionRef(tx: WagerTransaction): TransactionRef {
  const ref: TransactionRef = {
    transactionId: tx.id,
    providerId: tx.providerId,
    externalTransactionId: tx.externalTransactionId,
    walletId: tx.walletId,
    playerId: tx.playerId,
    roundId: tx.roundId,
    gameId: tx.gameId,
    kind: tx.kind,
    money: tx.money.toJSON(),
  };
  if (tx.referenceExternalTransactionId !== undefined) {
    ref.referenceExternalTransactionId = tx.referenceExternalTransactionId;
  }
  return ref;
}

function baseProps<T>(aggregateId: string, data: T, ctx: EventContext) {
  return {
    eventId: ctx.ids.next(),
    aggregateId,
    correlationId: ctx.correlationId,
    causationId: ctx.causationId,
    occurredAt: ctx.occurredAt,
    data,
  };
}

// ---------------------------------------------------------------------------

export interface WagerTransactionProcessedData extends TransactionRef {
  status: string;
  referenceTransactionId?: string;
  balanceAfter: MoneyProps;
  processedAt: string;
}

/** Any applied transaction, including LOSS (no balance change) and OPENING. */
export class WagerTransactionProcessed extends IntegrationEvent<WagerTransactionProcessedData> {
  readonly eventType = 'WagerTransactionProcessed';
  readonly version = 1;

  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionProcessed {
    if (!tx.resultBalance || !tx.processedAt) throw new Error('WagerTransactionProcessed requires a processed transaction');
    const data: WagerTransactionProcessedData = {
      ...transactionRef(tx),
      status: tx.status,
      balanceAfter: tx.resultBalance.toJSON(),
      processedAt: tx.processedAt.toISOString(),
    };
    if (tx.referenceTransactionId) data.referenceTransactionId = tx.referenceTransactionId;
    return new WagerTransactionProcessed(baseProps(tx.id, data, ctx));
  }

  get partitionKey(): string {
    return this.data.walletId;
  }
}

export interface WagerTransactionRejectedData extends TransactionRef {
  status: string;
  failureCode: FailureCode;
  balance?: MoneyProps;
}

/** Business rule rejection (terminal). */
export class WagerTransactionRejected extends IntegrationEvent<WagerTransactionRejectedData> {
  readonly eventType = 'WagerTransactionRejected';
  readonly version = 1;

  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionRejected {
    if (!tx.failureCode) throw new Error('WagerTransactionRejected requires a failure code');
    const data: WagerTransactionRejectedData = { ...transactionRef(tx), status: tx.status, failureCode: tx.failureCode };
    if (tx.resultBalance) data.balance = tx.resultBalance.toJSON();
    return new WagerTransactionRejected(baseProps(tx.id, data, ctx));
  }

  get partitionKey(): string {
    return this.data.walletId;
  }
}

export interface WagerTransactionPendingReferenceData extends TransactionRef {
  referenceAttempts: number;
  nextAttemptAt: string;
}

export class WagerTransactionPendingReference extends IntegrationEvent<WagerTransactionPendingReferenceData> {
  readonly eventType = 'WagerTransactionPendingReference';
  readonly version = 1;

  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionPendingReference {
    if (!tx.nextAttemptAt) throw new Error('pending reference requires nextAttemptAt');
    return new WagerTransactionPendingReference(
      baseProps(
        tx.id,
        { ...transactionRef(tx), referenceAttempts: tx.referenceAttempts, nextAttemptAt: tx.nextAttemptAt.toISOString() },
        ctx,
      ),
    );
  }

  get partitionKey(): string {
    return this.data.walletId;
  }
}

export interface WagerTransactionFailedData extends TransactionRef {
  failureCode: FailureCode;
}

/** Extra event (not in the minimum list): FAILED is terminal and auditable, consumers must know. */
export class WagerTransactionFailed extends IntegrationEvent<WagerTransactionFailedData> {
  readonly eventType = 'WagerTransactionFailed';
  readonly version = 1;

  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionFailed {
    if (!tx.failureCode) throw new Error('WagerTransactionFailed requires a failure code');
    return new WagerTransactionFailed(baseProps(tx.id, { ...transactionRef(tx), failureCode: tx.failureCode }, ctx));
  }

  get partitionKey(): string {
    return this.data.walletId;
  }
}

export interface WalletBalanceChangedData {
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  walletVersion: number;
}

/** Emitted ONLY when the balance actually changes (one per ledger entry). */
export class WalletBalanceChanged extends IntegrationEvent<WalletBalanceChangedData> {
  readonly eventType = 'WalletBalanceChanged';
  readonly version = 1;

  static from(wallet: Wallet, entry: WalletLedgerEntry, ctx: EventContext): WalletBalanceChanged {
    return new WalletBalanceChanged(
      baseProps(
        wallet.id,
        {
          walletId: wallet.id,
          transactionId: entry.transactionId,
          direction: entry.direction,
          money: entry.money.toJSON(),
          balanceBefore: entry.balanceBefore.toJSON(),
          balanceAfter: entry.balanceAfter.toJSON(),
          walletVersion: wallet.version,
        },
        ctx,
      ),
    );
  }

  get partitionKey(): string {
    return this.data.walletId;
  }
}
