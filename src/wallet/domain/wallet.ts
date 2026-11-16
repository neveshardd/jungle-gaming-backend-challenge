import { CurrencyMismatchError, InsufficientFundsError, InvalidMoneyError, InvalidWalletError } from '../../shared/domain/errors';
import { Money } from '../../shared/domain/money';
import { LedgerDirection } from './ledger-direction';
import { WalletLedgerEntry } from './wallet-ledger-entry';

export interface WalletState {
  id: string;
  playerId: string;
  currency: string;
  balance: Money;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

/** A balance movement request. The ledger entry id is supplied by the caller (id generation is infra). */
export interface BalanceMovement {
  transactionId: string;
  entryId: string;
  money: Money;
  at: Date;
}

export interface OpenWalletProps {
  id: string;
  playerId: string;
  initialBalance: Money;
  at: Date;
  /** Required when initialBalance > 0: the OPENING transaction and its ledger entry ids. */
  opening?: { transactionId: string; entryId: string };
}

export interface OpenedWallet {
  wallet: Wallet;
  /** CREDIT entry for the OPENING transaction; undefined when initial balance is zero. */
  openingEntry: WalletLedgerEntry | undefined;
}

const MAX_PLAYER_ID_LENGTH = 128;

/**
 * Wallet aggregate root.
 *
 * Invariants:
 *  - balance is never negative;
 *  - every balance change produces exactly one ledger entry (returned by debit/credit);
 *  - version starts at 1 and increments only when the balance changes;
 *  - operations must use the wallet currency.
 */
export class Wallet {
  private constructor(
    public readonly id: string,
    public readonly playerId: string,
    public readonly currency: string,
    private _balance: Money,
    private _version: number,
    public readonly createdAt: Date,
    private _updatedAt: Date,
  ) {}

  static open(props: OpenWalletProps): OpenedWallet {
    if (typeof props.playerId !== 'string' || props.playerId.length === 0 || props.playerId.length > MAX_PLAYER_ID_LENGTH) {
      throw new InvalidWalletError(`playerId must be a non-empty string up to ${MAX_PLAYER_ID_LENGTH} chars`);
    }
    if (props.initialBalance.isNegative()) {
      throw new InvalidMoneyError('initial balance cannot be negative');
    }
    const currency = props.initialBalance.currency;
    const wallet = new Wallet(props.id, props.playerId, currency, props.initialBalance, 1, props.at, props.at);
    if (!props.initialBalance.isPositive()) {
      return { wallet, openingEntry: undefined };
    }
    if (!props.opening) {
      throw new InvalidWalletError('a positive initial balance requires an OPENING transaction');
    }
    // The opening credit is part of creation itself: version stays 1 (spec: version 1 after creation).
    const openingEntry = WalletLedgerEntry.create({
      id: props.opening.entryId,
      walletId: props.id,
      transactionId: props.opening.transactionId,
      direction: LedgerDirection.Credit,
      money: props.initialBalance,
      balanceBefore: Money.zero(currency),
      balanceAfter: props.initialBalance,
      createdAt: props.at,
    });
    return { wallet, openingEntry };
  }

  /** Reconstruction from persistence — does not re-validate transitions. */
  static rehydrate(state: WalletState): Wallet {
    return new Wallet(
      state.id,
      state.playerId,
      state.currency,
      state.balance,
      state.version,
      state.createdAt,
      state.updatedAt,
    );
  }

  get balance(): Money {
    return this._balance;
  }

  get version(): number {
    return this._version;
  }

  get updatedAt(): Date {
    return this._updatedAt;
  }

  canDebit(money: Money): boolean {
    this.assertSameCurrency(money);
    return this._balance.isGreaterThanOrEqual(money);
  }

  debit(movement: BalanceMovement): WalletLedgerEntry {
    this.assertSameCurrency(movement.money);
    if (this._balance.isLessThan(movement.money)) {
      throw new InsufficientFundsError(
        `wallet ${this.id} cannot be debited ${movement.money.amount} (balance ${this._balance.amount})`,
      );
    }
    return this.apply(LedgerDirection.Debit, movement);
  }

  credit(movement: BalanceMovement): WalletLedgerEntry {
    this.assertSameCurrency(movement.money);
    return this.apply(LedgerDirection.Credit, movement);
  }

  private apply(direction: LedgerDirection, movement: BalanceMovement): WalletLedgerEntry {
    const before = this._balance;
    const after = direction === LedgerDirection.Credit ? before.add(movement.money) : before.subtract(movement.money);
    // Entry is built (and validated) before mutating state: a failure leaves the wallet untouched.
    const entry = WalletLedgerEntry.create({
      id: movement.entryId,
      walletId: this.id,
      transactionId: movement.transactionId,
      direction,
      money: movement.money,
      balanceBefore: before,
      balanceAfter: after,
      createdAt: movement.at,
    });
    this._balance = after;
    this._version += 1;
    this._updatedAt = movement.at;
    return entry;
  }

  private assertSameCurrency(money: Money): void {
    if (money.currency !== this.currency) {
      throw new CurrencyMismatchError(`wallet ${this.id} is ${this.currency}, operation is ${money.currency}`);
    }
  }
}
