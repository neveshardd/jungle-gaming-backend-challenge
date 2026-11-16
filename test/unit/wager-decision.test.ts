import { describe, expect, it } from 'bun:test';
import { Money } from '../../src/shared/domain/money';
import { FailureCode } from '../../src/wagering/domain/failure-code';
import { decideWager, type WagerDecision } from '../../src/wagering/domain/wager-decision';
import { type CreateWagerTransactionProps, WagerTransaction } from '../../src/wagering/domain/wager-transaction';
import { WagerTransactionKind as K } from '../../src/wagering/domain/wager-transaction-kind';
import { LedgerDirection } from '../../src/wallet/domain/ledger-direction';
import { Wallet } from '../../src/wallet/domain/wallet';

const at = new Date('2026-01-01T00:00:00Z');
const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
let seq = 0;

function wallet(balance = '100.00'): Wallet {
  return Wallet.rehydrate({
    id: 'w-1',
    playerId: 'p-1',
    currency: 'BRL',
    balance: brl(balance),
    version: 1,
    createdAt: at,
    updatedAt: at,
  });
}

function tx(kind: K, amount: string, overrides: Partial<CreateWagerTransactionProps> = {}): WagerTransaction {
  const ext = `ext-${++seq}`;
  return WagerTransaction.create({
    id: `id-${seq}`,
    providerId: 'provider-a',
    externalTransactionId: ext,
    idempotencyKey: `provider-a:${ext}`,
    payloadHash: 'b'.repeat(64),
    walletId: 'w-1',
    playerId: 'p-1',
    roundId: 'round-1',
    gameId: 'g',
    kind,
    money: brl(amount),
    createdAt: at,
    ...overrides,
  });
}

function processed(t: WagerTransaction): WagerTransaction {
  t.markProcessed(t.requiresReference() ? 'some-ref' : undefined, at, brl('0.00'));
  return t;
}

function decide(
  t: WagerTransaction,
  w = wallet(),
  reference?: WagerTransaction,
  referenceAlreadyReversed = false,
): WagerDecision {
  return decideWager({ transaction: t, wallet: w, reference, referenceAlreadyReversed });
}

const rejected = (code: FailureCode): WagerDecision => ({ type: 'REJECT', code });

describe('BET', () => {
  it('debits when funds are sufficient', () => {
    expect(decide(tx(K.Bet, '100.00'))).toEqual({ type: 'APPLY', direction: LedgerDirection.Debit, reference: undefined });
  });

  it('rejects with INSUFFICIENT_FUNDS', () => {
    expect(decide(tx(K.Bet, '100.01'))).toEqual(rejected(FailureCode.InsufficientFunds));
  });

  it('rejects currency conflicts', () => {
    expect(decide(tx(K.Bet, '1.00', { money: Money.from({ amount: '1.00', currency: 'USD' }) }))).toEqual(
      rejected(FailureCode.CurrencyMismatch),
    );
  });

  it('rejects wallet/player mismatch', () => {
    expect(decide(tx(K.Bet, '1.00', { playerId: 'someone-else' }))).toEqual(rejected(FailureCode.WalletPlayerMismatch));
  });
});

describe('WIN', () => {
  it('credits without reference', () => {
    expect(decide(tx(K.Win, '50.00'))).toMatchObject({ type: 'APPLY', direction: LedgerDirection.Credit });
  });

  it('credits with a valid BET reference of the same round', () => {
    const bet = processed(tx(K.Bet, '10.00'));
    const win = tx(K.Win, '30.00', { referenceExternalTransactionId: bet.externalTransactionId });
    expect(decide(win, wallet(), bet)).toMatchObject({ type: 'APPLY', direction: LedgerDirection.Credit, reference: bet });
  });

  it('waits for a referenced BET that has not arrived', () => {
    expect(decide(tx(K.Win, '30.00', { referenceExternalTransactionId: 'missing' }))).toEqual({ type: 'AWAIT_REFERENCE' });
  });

  it('rejects a reference from another round', () => {
    const bet = processed(tx(K.Bet, '10.00', { roundId: 'other' }));
    const win = tx(K.Win, '30.00', { referenceExternalTransactionId: bet.externalTransactionId });
    expect(decide(win, wallet(), bet)).toEqual(rejected(FailureCode.ReferenceMismatch));
  });
});

describe('LOSS', () => {
  it('is recorded without balance movement, even with zero balance', () => {
    expect(decide(tx(K.Loss, '10.00'), wallet('0.00'))).toEqual({ type: 'RECORD', reference: undefined });
  });
});

describe('REFUND', () => {
  it('credits a PROCESSED BET exactly once', () => {
    const bet = processed(tx(K.Bet, '10.00'));
    const refund = tx(K.Refund, '10.00', { referenceExternalTransactionId: bet.externalTransactionId });
    expect(decide(refund, wallet(), bet)).toMatchObject({ type: 'APPLY', direction: LedgerDirection.Credit });
    expect(decide(refund, wallet(), bet, true)).toEqual(rejected(FailureCode.AlreadyReversed));
  });

  it('only references BET', () => {
    const win = processed(tx(K.Win, '10.00'));
    const refund = tx(K.Refund, '10.00', { referenceExternalTransactionId: win.externalTransactionId });
    expect(decide(refund, wallet(), win)).toEqual(rejected(FailureCode.ReferenceKindNotAllowed));
  });

  it('amount must equal the reference amount', () => {
    const bet = processed(tx(K.Bet, '10.00'));
    const refund = tx(K.Refund, '9.99', { referenceExternalTransactionId: bet.externalTransactionId });
    expect(decide(refund, wallet(), bet)).toEqual(rejected(FailureCode.ReferenceAmountMismatch));
  });

  it('cannot refund a REJECTED bet', () => {
    const bet = tx(K.Bet, '10.00');
    bet.reject(FailureCode.InsufficientFunds, at, brl('0.00'));
    const refund = tx(K.Refund, '10.00', { referenceExternalTransactionId: bet.externalTransactionId });
    expect(decide(refund, wallet(), bet)).toEqual(rejected(FailureCode.ReferenceNotProcessed));
  });

  it('waits when the reference is missing (out of order)', () => {
    const refund = tx(K.Refund, '10.00', { referenceExternalTransactionId: 'not-yet' });
    expect(decide(refund)).toEqual({ type: 'AWAIT_REFERENCE' });
  });

  it.each([
    ['providerId', { providerId: 'provider-b' }],
    ['playerId', { playerId: 'p-2' }],
    ['walletId', { walletId: 'w-2' }],
    ['roundId', { roundId: 'round-2' }],
  ])('reference must belong to the same %s', (_field, override) => {
    const bet = processed(tx(K.Bet, '10.00', override as Partial<CreateWagerTransactionProps>));
    const refund = tx(K.Refund, '10.00', { referenceExternalTransactionId: bet.externalTransactionId });
    expect(decide(refund, wallet(), bet)).toEqual(rejected(FailureCode.ReferenceMismatch));
  });
});

describe('ROLLBACK', () => {
  it('of a BET credits', () => {
    const bet = processed(tx(K.Bet, '10.00'));
    const rb = tx(K.Rollback, '10.00', { referenceExternalTransactionId: bet.externalTransactionId });
    expect(decide(rb, wallet(), bet)).toMatchObject({ type: 'APPLY', direction: LedgerDirection.Credit });
  });

  it('of a WIN debits, and is rejected with a DISTINCT code when it would overdraw', () => {
    const win = processed(tx(K.Win, '50.00'));
    const rb = tx(K.Rollback, '50.00', { referenceExternalTransactionId: win.externalTransactionId });
    expect(decide(rb, wallet('50.00'), win)).toMatchObject({ type: 'APPLY', direction: LedgerDirection.Debit });
    const decision = decide(rb, wallet('49.99'), win);
    expect(decision).toEqual(rejected(FailureCode.ReversalWouldOverdraw));
    expect(FailureCode.ReversalWouldOverdraw).not.toBe(FailureCode.InsufficientFunds);
  });

  it('of a REFUND debits', () => {
    const refund = processed(tx(K.Refund, '10.00', { referenceExternalTransactionId: 'bet-x' }));
    const rb = tx(K.Rollback, '10.00', { referenceExternalTransactionId: refund.externalTransactionId });
    expect(decide(rb, wallet(), refund)).toMatchObject({ type: 'APPLY', direction: LedgerDirection.Debit });
  });

  it('cannot target LOSS or another ROLLBACK', () => {
    const loss = processed(tx(K.Loss, '10.00'));
    const rb = tx(K.Rollback, '10.00', { referenceExternalTransactionId: loss.externalTransactionId });
    expect(decide(rb, wallet(), loss)).toEqual(rejected(FailureCode.ReferenceKindNotAllowed));
  });

  it('waits while the reference is itself PENDING_REFERENCE', () => {
    const refund = tx(K.Refund, '10.00', { referenceExternalTransactionId: 'bet-x' });
    refund.markPendingReference(at, at);
    const rb = tx(K.Rollback, '10.00', { referenceExternalTransactionId: refund.externalTransactionId });
    expect(decide(rb, wallet(), refund)).toEqual({ type: 'AWAIT_REFERENCE' });
  });

  it('cannot reverse twice', () => {
    const bet = processed(tx(K.Bet, '10.00'));
    const rb = tx(K.Rollback, '10.00', { referenceExternalTransactionId: bet.externalTransactionId });
    expect(decide(rb, wallet(), bet, true)).toEqual(rejected(FailureCode.AlreadyReversed));
  });
});
