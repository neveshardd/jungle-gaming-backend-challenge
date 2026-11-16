import { InvalidLedgerEntryError } from '../../shared/domain/errors';
import type { Money } from '../../shared/domain/money';
import { LedgerDirection } from './ledger-direction';

export interface LedgerEntryState {
  id: string;
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: Money;
  balanceBefore: Money;
  balanceAfter: Money;
  createdAt: Date;
}

export type CreateLedgerEntryProps = LedgerEntryState;

/**
 * Immutable ledger line. No mutable fields and no transition methods: immutability is
 * structural (readonly + frozen), and the database rejects UPDATE/DELETE as well.
 */
export class WalletLedgerEntry {
  private constructor(
    public readonly id: string,
    public readonly walletId: string,
    public readonly transactionId: string,
    public readonly direction: LedgerDirection,
    public readonly money: Money,
    public readonly balanceBefore: Money,
    public readonly balanceAfter: Money,
    public readonly createdAt: Date,
  ) {
    Object.freeze(this);
  }

  /** Validates the arithmetic: balanceBefore ± money === balanceAfter, all non-negative, same currency. */
  static create(props: CreateLedgerEntryProps): WalletLedgerEntry {
    if (props.direction !== LedgerDirection.Credit && props.direction !== LedgerDirection.Debit) {
      throw new InvalidLedgerEntryError(`unknown ledger direction ${String(props.direction)}`);
    }
    const { money, balanceBefore, balanceAfter } = props;
    if (money.currency !== balanceBefore.currency || money.currency !== balanceAfter.currency) {
      throw new InvalidLedgerEntryError('ledger entry amounts must share the same currency');
    }
    if (!money.isPositive()) {
      throw new InvalidLedgerEntryError('ledger entry amount must be greater than zero');
    }
    if (balanceBefore.isNegative() || balanceAfter.isNegative()) {
      throw new InvalidLedgerEntryError('ledger balances can never be negative');
    }
    const entry = WalletLedgerEntry.rehydrate(props);
    if (!entry.isBalanced()) {
      throw new InvalidLedgerEntryError(
        `unbalanced ledger entry: ${balanceBefore.amount} ${props.direction} ${money.amount} != ${balanceAfter.amount}`,
      );
    }
    return entry;
  }

  /** Reconstruction from persistence — no validation. */
  static rehydrate(state: LedgerEntryState): WalletLedgerEntry {
    return new WalletLedgerEntry(
      state.id,
      state.walletId,
      state.transactionId,
      state.direction,
      state.money,
      state.balanceBefore,
      state.balanceAfter,
      state.createdAt,
    );
  }

  isBalanced(): boolean {
    const expected =
      this.direction === LedgerDirection.Credit
        ? this.balanceBefore.add(this.money)
        : this.balanceBefore.subtract(this.money);
    return expected.equals(this.balanceAfter);
  }
}
