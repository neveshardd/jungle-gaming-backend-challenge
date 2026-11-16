import { describe, expect, it } from 'bun:test';
import {
  CurrencyMismatchError,
  InsufficientFundsError,
  InvalidLedgerEntryError,
  InvalidMoneyError,
  InvalidWalletError,
} from '../../src/shared/domain/errors';
import { Money } from '../../src/shared/domain/money';
import { LedgerDirection } from '../../src/wallet/domain/ledger-direction';
import { Wallet } from '../../src/wallet/domain/wallet';
import { WalletLedgerEntry } from '../../src/wallet/domain/wallet-ledger-entry';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
const at = new Date('2026-01-01T00:00:00Z');
let n = 0;
const mv = (amount: string) => ({ transactionId: `tx-${++n}`, entryId: `e-${n}`, money: brl(amount), at });

function openWallet(initial = '100.00') {
  return Wallet.open({
    id: 'w-1',
    playerId: 'p-1',
    initialBalance: brl(initial),
    at,
    opening: { transactionId: 'open-tx', entryId: 'open-entry' },
  });
}

describe('Wallet', () => {
  it('opens with version 1 and an OPENING credit entry when balance > 0', () => {
    const { wallet, openingEntry } = openWallet('1000.00');
    expect(wallet.version).toBe(1);
    expect(wallet.balance.amount).toBe('1000.00');
    expect(wallet.currency).toBe('BRL');
    expect(openingEntry?.direction).toBe(LedgerDirection.Credit);
    expect(openingEntry?.balanceBefore.amount).toBe('0.00');
    expect(openingEntry?.balanceAfter.amount).toBe('1000.00');
  });

  it('opens with zero balance and no ledger entry', () => {
    const { wallet, openingEntry } = Wallet.open({ id: 'w', playerId: 'p', initialBalance: Money.zero('BRL'), at });
    expect(wallet.version).toBe(1);
    expect(openingEntry).toBeUndefined();
  });

  it('rejects positive initial balance without an OPENING transaction', () => {
    expect(() => Wallet.open({ id: 'w', playerId: 'p', initialBalance: brl('1.00'), at })).toThrow(InvalidWalletError);
  });

  it('rejects empty playerId and negative initial balance', () => {
    expect(() => Wallet.open({ id: 'w', playerId: '', initialBalance: Money.zero('BRL'), at })).toThrow(InvalidWalletError);
    expect(() =>
      Wallet.open({ id: 'w', playerId: 'p', initialBalance: Money.rehydrate('-1.00', 'BRL'), at }),
    ).toThrow(InvalidMoneyError);
  });

  it('debit produces exactly one balanced DEBIT entry and bumps version', () => {
    const { wallet } = openWallet('100.00');
    const entry = wallet.debit(mv('80.00'));
    expect(wallet.balance.amount).toBe('20.00');
    expect(wallet.version).toBe(2);
    expect(entry.direction).toBe(LedgerDirection.Debit);
    expect(entry.balanceBefore.amount).toBe('100.00');
    expect(entry.balanceAfter.amount).toBe('20.00');
    expect(entry.isBalanced()).toBe(true);
  });

  it('never goes negative: debit beyond balance throws and leaves state untouched', () => {
    const { wallet } = openWallet('100.00');
    wallet.debit(mv('80.00'));
    expect(() => wallet.debit(mv('80.00'))).toThrow(InsufficientFundsError);
    expect(wallet.balance.amount).toBe('20.00');
    expect(wallet.version).toBe(2);
  });

  it('allows debiting the exact balance down to zero', () => {
    const { wallet } = openWallet('10.00');
    wallet.debit(mv('10.00'));
    expect(wallet.balance.isZero()).toBe(true);
  });

  it('credit bumps version; balance equals sum of ledger movements', () => {
    const { wallet, openingEntry } = openWallet('100.00');
    const entries = [openingEntry!, wallet.debit(mv('25.00')), wallet.credit(mv('50.00')), wallet.debit(mv('0.01'))];
    expect(wallet.version).toBe(4);
    const rebuilt = entries.reduce(
      (acc, e) => (e.direction === LedgerDirection.Credit ? acc.add(e.money) : acc.subtract(e.money)),
      Money.zero('BRL'),
    );
    expect(rebuilt.equals(wallet.balance)).toBe(true);
  });

  it('rejects operations in another currency', () => {
    const { wallet } = openWallet();
    const usd = { ...mv('1.00'), money: Money.from({ amount: '1.00', currency: 'USD' }) };
    expect(() => wallet.debit(usd)).toThrow(CurrencyMismatchError);
    expect(() => wallet.credit(usd)).toThrow(CurrencyMismatchError);
    expect(() => wallet.canDebit(usd.money)).toThrow(CurrencyMismatchError);
    expect(wallet.version).toBe(1);
  });

  it('rejects zero-amount movements (no empty ledger lines)', () => {
    const { wallet } = openWallet();
    expect(() => wallet.credit(mv('0.00'))).toThrow(InvalidLedgerEntryError);
    expect(wallet.version).toBe(1);
  });

  it('rehydrate restores state without validation', () => {
    const wallet = Wallet.rehydrate({
      id: 'w',
      playerId: 'p',
      currency: 'BRL',
      balance: brl('5.00'),
      version: 7,
      createdAt: at,
      updatedAt: at,
    });
    expect(wallet.version).toBe(7);
    expect(wallet.balance.amount).toBe('5.00');
  });
});

describe('WalletLedgerEntry', () => {
  const base = {
    id: 'e',
    walletId: 'w',
    transactionId: 't',
    createdAt: at,
  };

  it('validates arithmetic in the factory', () => {
    expect(() =>
      WalletLedgerEntry.create({
        ...base,
        direction: LedgerDirection.Credit,
        money: brl('10.00'),
        balanceBefore: brl('5.00'),
        balanceAfter: brl('14.99'),
      }),
    ).toThrow(InvalidLedgerEntryError);
    expect(() =>
      WalletLedgerEntry.create({
        ...base,
        direction: LedgerDirection.Debit,
        money: brl('10.00'),
        balanceBefore: brl('5.00'),
        balanceAfter: Money.rehydrate('-5.00', 'BRL'),
      }),
    ).toThrow(InvalidLedgerEntryError);
  });

  it('is structurally immutable', () => {
    const entry = WalletLedgerEntry.create({
      ...base,
      direction: LedgerDirection.Debit,
      money: brl('1.00'),
      balanceBefore: brl('3.00'),
      balanceAfter: brl('2.00'),
    });
    expect(Object.isFrozen(entry)).toBe(true);
    expect(() => {
      (entry as unknown as { direction: string }).direction = 'CREDIT';
    }).toThrow();
  });
});
