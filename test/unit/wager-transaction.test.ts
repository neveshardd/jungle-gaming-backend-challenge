import { describe, expect, it } from 'bun:test';
import { InvalidTransactionStateError, InvalidWagerTransactionError } from '../../src/shared/domain/errors';
import { Money } from '../../src/shared/domain/money';
import { FailureCode } from '../../src/wagering/domain/failure-code';
import { hashWagerPayload } from '../../src/wagering/domain/payload-hash';
import { ReferenceRetryPolicy } from '../../src/wagering/domain/reference-retry-policy';
import { type CreateWagerTransactionProps, WagerTransaction } from '../../src/wagering/domain/wager-transaction';
import { WagerTransactionKind as K } from '../../src/wagering/domain/wager-transaction-kind';
import { WagerTransactionStatus as S } from '../../src/wagering/domain/wager-transaction-status';
import { LedgerDirection } from '../../src/wallet/domain/ledger-direction';

const at = new Date('2026-01-01T00:00:00Z');
const HASH = 'a'.repeat(64);

export function props(overrides: Partial<CreateWagerTransactionProps> = {}): CreateWagerTransactionProps {
  return {
    id: 'tx-1',
    providerId: 'provider-a',
    externalTransactionId: 'ext-1',
    idempotencyKey: 'provider-a:ext-1',
    payloadHash: HASH,
    walletId: 'w-1',
    playerId: 'p-1',
    roundId: 'round-1',
    gameId: 'game-1',
    kind: K.Bet,
    money: Money.from({ amount: '10.00', currency: 'BRL' }),
    createdAt: at,
    ...overrides,
  };
}

describe('WagerTransaction.create', () => {
  it('is born PENDING', () => {
    const tx = WagerTransaction.create(props());
    expect(tx.status).toBe(S.Pending);
    expect(tx.isTerminal()).toBe(false);
    expect(tx.referenceAttempts).toBe(0);
  });

  it('rejects OPENING from external sources', () => {
    expect(() => WagerTransaction.create(props({ kind: K.Opening }))).toThrow(InvalidWagerTransactionError);
  });

  it.each([K.Refund, K.Rollback])('%s requires a reference', (kind) => {
    expect(() => WagerTransaction.create(props({ kind }))).toThrow(InvalidWagerTransactionError);
    expect(WagerTransaction.create(props({ kind, referenceExternalTransactionId: 'ext-0' })).requiresReference()).toBe(true);
  });

  it('BET cannot reference another transaction', () => {
    expect(() => WagerTransaction.create(props({ referenceExternalTransactionId: 'x' }))).toThrow(
      InvalidWagerTransactionError,
    );
  });

  it('WIN and LOSS may optionally reference a BET', () => {
    expect(WagerTransaction.create(props({ kind: K.Win, referenceExternalTransactionId: 'b' })).canReference(K.Bet)).toBe(
      true,
    );
    expect(WagerTransaction.create(props({ kind: K.Loss })).referenceExternalTransactionId).toBeUndefined();
  });

  it('a transaction cannot reference itself', () => {
    expect(() =>
      WagerTransaction.create(props({ kind: K.Rollback, referenceExternalTransactionId: 'ext-1' })),
    ).toThrow(InvalidWagerTransactionError);
  });

  it('rejects zero amounts and empty identifiers', () => {
    expect(() => WagerTransaction.create(props({ money: Money.zero('BRL') }))).toThrow(InvalidWagerTransactionError);
    expect(() => WagerTransaction.create(props({ roundId: '' }))).toThrow(InvalidWagerTransactionError);
    expect(() => WagerTransaction.create(props({ payloadHash: 'nope' }))).toThrow(InvalidWagerTransactionError);
  });
});

describe('WagerTransaction transitions', () => {
  const balance = Money.from({ amount: '90.00', currency: 'BRL' });

  it('PENDING -> PROCESSED stores result balance', () => {
    const tx = WagerTransaction.create(props());
    tx.markProcessed(undefined, at, balance);
    expect(tx.status).toBe(S.Processed);
    expect(tx.resultBalance?.amount).toBe('90.00');
    expect(tx.processedAt).toEqual(at);
  });

  it('PENDING -> PENDING_REFERENCE -> PENDING_REFERENCE -> PROCESSED', () => {
    const tx = WagerTransaction.create(props({ kind: K.Refund, referenceExternalTransactionId: 'b' }));
    tx.markPendingReference(new Date(at.getTime() + 1000), at);
    tx.markPendingReference(new Date(at.getTime() + 2000), at);
    expect(tx.status).toBe(S.PendingReference);
    expect(tx.referenceAttempts).toBe(2);
    tx.markProcessed('ref-id', at, balance);
    expect(tx.status).toBe(S.Processed);
    expect(tx.referenceTransactionId).toBe('ref-id');
    expect(tx.nextAttemptAt).toBeUndefined();
  });

  it('a reversal cannot be processed without its resolved reference', () => {
    const tx = WagerTransaction.create(props({ kind: K.Refund, referenceExternalTransactionId: 'b' }));
    expect(() => tx.markProcessed(undefined, at, balance)).toThrow(InvalidTransactionStateError);
  });

  it('PENDING_REFERENCE requires a reference', () => {
    expect(() => WagerTransaction.create(props()).markPendingReference(at, at)).toThrow(InvalidTransactionStateError);
  });

  it.each([
    ['PROCESSED', (tx: WagerTransaction) => tx.markProcessed(undefined, at, balance)],
    ['REJECTED', (tx: WagerTransaction) => tx.reject(FailureCode.InsufficientFunds, at, balance)],
    ['FAILED', (tx: WagerTransaction) => tx.fail(FailureCode.ProcessingError, at)],
  ])('%s is terminal: every further transition throws', (_label, terminate) => {
    const tx = WagerTransaction.create(props({ kind: K.Win, referenceExternalTransactionId: 'b' }));
    terminate(tx);
    expect(tx.isTerminal()).toBe(true);
    expect(() => tx.markProcessed('r', at, balance)).toThrow(InvalidTransactionStateError);
    expect(() => tx.markPendingReference(at, at)).toThrow(InvalidTransactionStateError);
    expect(() => tx.reject(FailureCode.InsufficientFunds, at, balance)).toThrow(InvalidTransactionStateError);
    expect(() => tx.fail(FailureCode.ProcessingError, at)).toThrow(InvalidTransactionStateError);
  });
});

describe('WagerTransaction queries', () => {
  it('affectsBalance is false only for LOSS', () => {
    expect(WagerTransaction.create(props({ kind: K.Loss })).affectsBalance()).toBe(false);
    expect(WagerTransaction.create(props({ kind: K.Win })).affectsBalance()).toBe(true);
  });

  it('ledger direction per kind', () => {
    const bet = WagerTransaction.create(props());
    const win = WagerTransaction.create(props({ kind: K.Win }));
    const refund = WagerTransaction.create(props({ kind: K.Refund, referenceExternalTransactionId: 'b' }));
    const rollback = WagerTransaction.create(props({ kind: K.Rollback, referenceExternalTransactionId: 'b' }));
    expect(bet.ledgerDirectionFor()).toBe(LedgerDirection.Debit);
    expect(win.ledgerDirectionFor()).toBe(LedgerDirection.Credit);
    expect(refund.ledgerDirectionFor(bet)).toBe(LedgerDirection.Credit);
    expect(rollback.ledgerDirectionFor(bet)).toBe(LedgerDirection.Credit);
    expect(rollback.ledgerDirectionFor(win)).toBe(LedgerDirection.Debit);
    expect(rollback.ledgerDirectionFor(refund)).toBe(LedgerDirection.Debit);
    expect(() => rollback.ledgerDirectionFor()).toThrow(InvalidTransactionStateError);
    expect(() => WagerTransaction.create(props({ kind: K.Loss })).ledgerDirectionFor()).toThrow(
      InvalidTransactionStateError,
    );
  });
});

describe('idempotency payload hash', () => {
  const payload = {
    providerId: 'provider-a',
    externalTransactionId: 'transaction-123',
    playerId: 'p',
    walletId: 'w',
    roundId: 'r',
    gameId: 'g',
    kind: 'BET',
    money: { amount: '25.00', currency: 'BRL' },
  };

  it('is independent of key order and of extra fields', () => {
    const reordered = {
      money: { currency: 'BRL', amount: '25.00' },
      kind: 'BET',
      gameId: 'g',
      roundId: 'r',
      walletId: 'w',
      playerId: 'p',
      externalTransactionId: 'transaction-123',
      providerId: 'provider-a',
      somethingElse: 'ignored',
    };
    expect(hashWagerPayload(reordered)).toBe(hashWagerPayload(payload));
  });

  it('same key with a divergent payload produces a different hash (conflict, not replay)', () => {
    const tx = WagerTransaction.create(props({ payloadHash: hashWagerPayload(payload) }));
    expect(tx.matchesPayload(hashWagerPayload(payload))).toBe(true);
    expect(tx.matchesPayload(hashWagerPayload({ ...payload, money: { amount: '25.01', currency: 'BRL' } }))).toBe(false);
    expect(tx.matchesPayload(hashWagerPayload({ ...payload, kind: 'WIN' }))).toBe(false);
    expect(tx.matchesPayload(hashWagerPayload({ ...payload, referenceExternalTransactionId: 'x' }))).toBe(false);
  });

  it('is a sha-256 hex digest', () => {
    expect(hashWagerPayload(payload)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('ReferenceRetryPolicy', () => {
  it('exponential backoff with cap and bounded attempts', () => {
    const policy = new ReferenceRetryPolicy({ maxAttempts: 3, baseDelayMs: 1000, maxDelayMs: 3000 });
    expect(policy.nextAttemptAt(1, at).getTime() - at.getTime()).toBe(1000);
    expect(policy.nextAttemptAt(2, at).getTime() - at.getTime()).toBe(2000);
    expect(policy.nextAttemptAt(3, at).getTime() - at.getTime()).toBe(3000);
    expect(policy.nextAttemptAt(9, at).getTime() - at.getTime()).toBe(3000);
    expect(policy.isExhausted(2)).toBe(false);
    expect(policy.isExhausted(3)).toBe(true);
  });
});
