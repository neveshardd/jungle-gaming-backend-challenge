import { LedgerDirection } from '../../wallet/domain/ledger-direction';
import type { Wallet } from '../../wallet/domain/wallet';
import { FailureCode } from './failure-code';
import type { WagerTransaction } from './wager-transaction';
import { WagerTransactionStatus } from './wager-transaction-status';

export type WagerDecision =
  /** Move balance: one ledger entry in `direction`. */
  | { type: 'APPLY'; direction: LedgerDirection; reference: WagerTransaction | undefined }
  /** Accepted without balance effect (LOSS). */
  | { type: 'RECORD'; reference: WagerTransaction | undefined }
  | { type: 'REJECT'; code: FailureCode }
  | { type: 'AWAIT_REFERENCE' };

export interface DecisionInput {
  transaction: WagerTransaction;
  /** Wallet locked for update by the caller. */
  wallet: Wallet;
  /** Transaction resolved by (providerId, referenceExternalTransactionId), if any. */
  reference: WagerTransaction | undefined;
  /** Whether the reference already has a PROCESSED reversal (REFUND or ROLLBACK). */
  referenceAlreadyReversed: boolean;
}

/**
 * Pure business rules (section 7). Order of checks matters and is part of the contract:
 * ownership → currency → reference → balance.
 */
export function decideWager(input: DecisionInput): WagerDecision {
  const { transaction: tx, wallet, reference } = input;

  if (tx.walletId !== wallet.id || tx.playerId !== wallet.playerId) {
    return reject(FailureCode.WalletPlayerMismatch);
  }
  if (tx.money.currency !== wallet.currency) {
    return reject(FailureCode.CurrencyMismatch);
  }

  if (tx.referenceExternalTransactionId !== undefined) {
    if (!reference) return { type: 'AWAIT_REFERENCE' };
    const problem = validateReference(tx, reference, input.referenceAlreadyReversed);
    if (problem) return problem;
  }

  if (!tx.affectsBalance()) {
    return { type: 'RECORD', reference };
  }

  const direction = tx.ledgerDirectionFor(reference);
  if (direction === LedgerDirection.Debit && !wallet.canDebit(tx.money)) {
    // Rule 9: a reversal that would overdraw is operationally different from a bet without funds.
    return reject(tx.isReversal() ? FailureCode.ReversalWouldOverdraw : FailureCode.InsufficientFunds);
  }
  return { type: 'APPLY', direction, reference };
}

function validateReference(
  tx: WagerTransaction,
  reference: WagerTransaction,
  alreadyReversed: boolean,
): WagerDecision | undefined {
  if (
    reference.providerId !== tx.providerId ||
    reference.playerId !== tx.playerId ||
    reference.walletId !== tx.walletId ||
    reference.roundId !== tx.roundId ||
    reference.money.currency !== tx.money.currency
  ) {
    return reject(FailureCode.ReferenceMismatch);
  }
  if (!tx.canReference(reference.kind)) {
    return reject(FailureCode.ReferenceKindNotAllowed);
  }
  if (
    reference.status === WagerTransactionStatus.PendingReference ||
    reference.status === WagerTransactionStatus.Pending
  ) {
    // e.g. ROLLBACK of a REFUND that is itself still waiting for its BET.
    return { type: 'AWAIT_REFERENCE' };
  }
  if (reference.status !== WagerTransactionStatus.Processed) {
    return reject(FailureCode.ReferenceNotProcessed);
  }
  if (tx.isReversal()) {
    if (!reference.money.equals(tx.money)) {
      return reject(FailureCode.ReferenceAmountMismatch);
    }
    if (alreadyReversed) {
      return reject(FailureCode.AlreadyReversed);
    }
  }
  return undefined;
}

function reject(code: FailureCode): WagerDecision {
  return { type: 'REJECT', code };
}
