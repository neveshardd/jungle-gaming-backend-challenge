import type { MoneyProps } from '../../shared/domain/money';
import type { WagerTransaction } from '../domain/wager-transaction';

/** Result returned to the provider (HTTP body / logs). Replays return the ORIGINAL result. */
export interface WagerResult {
  transactionId: string;
  status: string;
  balance?: MoneyProps;
  failureCode?: string;
  idempotentReplay: boolean;
}

export function toWagerResult(tx: WagerTransaction, idempotentReplay: boolean): WagerResult {
  const result: WagerResult = { transactionId: tx.id, status: tx.status, idempotentReplay };
  if (tx.resultBalance) result.balance = tx.resultBalance.toJSON();
  if (tx.failureCode) result.failureCode = tx.failureCode;
  return result;
}

export interface WagerTransactionView {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: MoneyProps;
  status: string;
  referenceExternalTransactionId?: string;
  referenceTransactionId?: string;
  failureCode?: string;
  resultBalance?: MoneyProps;
  referenceAttempts: number;
  nextAttemptAt?: string;
  createdAt: string;
  processedAt?: string;
}

export function toWagerTransactionView(tx: WagerTransaction): WagerTransactionView {
  const view: WagerTransactionView = {
    id: tx.id,
    providerId: tx.providerId,
    externalTransactionId: tx.externalTransactionId,
    idempotencyKey: tx.idempotencyKey,
    walletId: tx.walletId,
    playerId: tx.playerId,
    roundId: tx.roundId,
    gameId: tx.gameId,
    kind: tx.kind,
    money: tx.money.toJSON(),
    status: tx.status,
    referenceAttempts: tx.referenceAttempts,
    createdAt: tx.createdAt.toISOString(),
  };
  if (tx.referenceExternalTransactionId) view.referenceExternalTransactionId = tx.referenceExternalTransactionId;
  if (tx.referenceTransactionId) view.referenceTransactionId = tx.referenceTransactionId;
  if (tx.failureCode) view.failureCode = tx.failureCode;
  if (tx.resultBalance) view.resultBalance = tx.resultBalance.toJSON();
  if (tx.nextAttemptAt) view.nextAttemptAt = tx.nextAttemptAt.toISOString();
  if (tx.processedAt) view.processedAt = tx.processedAt.toISOString();
  return view;
}
