import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Container } from '../../src/bootstrap/container';
import { ConflictError, NotFoundError } from '../../src/shared/application/errors';
import type { UnitOfWork } from '../../src/shared/application/unit-of-work';
import { InvalidMoneyError, InvalidWagerTransactionError } from '../../src/shared/domain/errors';
import {
  createTestContainer,
  expectAllWalletsConsistent,
  expectWalletConsistent,
  ledgerCount,
  openWallet,
  resetDatabase,
  sql,
  submit,
  uniqueQueueEnv,
  wager,
} from '../support/harness';

let container: Container;

beforeAll(async () => {
  await resetDatabase();
  container = await createTestContainer(uniqueQueueEnv('flow'));
});

afterAll(async () => {
  await expectAllWalletsConsistent(container);
  await container.close();
});

async function outboxTypes(aggregateOrWallet: string): Promise<string[]> {
  const rows = await sql(container).query<{ event_type: string }>(
    `SELECT event_type FROM outbox_messages WHERE partition_key = ? ORDER BY occurred_at, event_type`,
    [aggregateOrWallet],
  );
  return rows.map((r) => r.event_type);
}

describe('wallet opening', () => {
  it('creates wallet, OPENING transaction, CREDIT ledger line and events atomically', async () => {
    const wallet = await openWallet(container, '1000.00');
    expect(wallet.version).toBe(1);
    expect(wallet.balance).toEqual({ amount: '1000.00', currency: 'BRL' });
    expect(await ledgerCount(container, wallet.id, 'CREDIT')).toBe(1);
    const opening = await container.wageringQueries.getByExternalId('internal', `opening:${wallet.id}`);
    expect(opening.kind).toBe('OPENING');
    expect(opening.status).toBe('PROCESSED');
    expect(await outboxTypes(wallet.id)).toEqual(['WagerTransactionProcessed', 'WalletBalanceChanged'].sort());
    await expectWalletConsistent(container, wallet.id);
  });

  it('zero initial balance: no OPENING, no ledger', async () => {
    const wallet = await openWallet(container, '0.00');
    expect(await ledgerCount(container, wallet.id)).toBe(0);
    await expectWalletConsistent(container, wallet.id);
  });

  it('duplicate wallet for player + currency is a conflict', async () => {
    const wallet = await openWallet(container, '1.00');
    await expect(openWallet(container, '1.00', wallet.playerId)).rejects.toBeInstanceOf(ConflictError);
  });

  it('rejects invalid money', async () => {
    await expect(openWallet(container, '10')).rejects.toBeInstanceOf(InvalidMoneyError);
  });
});

describe('business rules end to end', () => {
  it('BET debits; replay returns the ORIGINAL result and balance', async () => {
    const wallet = await openWallet(container, '1000.00');
    const bet = wager(wallet, 'BET', '25.00');
    const first = await submit(container, bet);
    expect(first).toMatchObject({ status: 'PROCESSED', balance: { amount: '975.00', currency: 'BRL' }, idempotentReplay: false });

    await submit(container, wager(wallet, 'BET', '100.00')); // balance moves on
    const replay = await submit(container, bet);
    expect(replay).toEqual({ ...first, idempotentReplay: true });
    expect(replay.balance?.amount).toBe('975.00');
    expect(await ledgerCount(container, wallet.id, 'DEBIT')).toBe(2);
    await expectWalletConsistent(container, wallet.id);
  });

  it('same key with a divergent payload is a conflict, not a replay', async () => {
    const wallet = await openWallet(container, '100.00');
    const bet = wager(wallet, 'BET', '10.00');
    await submit(container, bet);
    const tampered = { ...bet, payload: { ...bet.payload, money: { amount: '11.00', currency: 'BRL' } } };
    const err = await submit(container, tampered).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConflictError);
    expect((err as ConflictError).code).toBe('IDEMPOTENCY_CONFLICT');
    // same external id under another key
    const otherKey = await submit(container, { ...bet, idempotencyKey: 'another-key' }).catch((e: unknown) => e);
    expect((otherKey as ConflictError).code).toBe('EXTERNAL_ID_CONFLICT');
    expect(await ledgerCount(container, wallet.id, 'DEBIT')).toBe(1);
  });

  it('BET without funds is REJECTED (persisted, no ledger, rejection event)', async () => {
    const wallet = await openWallet(container, '10.00');
    const result = await submit(container, wager(wallet, 'BET', '10.01'));
    expect(result).toMatchObject({ status: 'REJECTED', failureCode: 'INSUFFICIENT_FUNDS', balance: { amount: '10.00' } });
    expect(await ledgerCount(container, wallet.id, 'DEBIT')).toBe(0);
    const tx = await container.wageringQueries.getById(result.transactionId);
    expect(tx.status).toBe('REJECTED');
    await expectWalletConsistent(container, wallet.id);
  });

  it('WIN credits; LOSS is PROCESSED without ledger and without WalletBalanceChanged', async () => {
    const wallet = await openWallet(container, '50.00');
    const bet = wager(wallet, 'BET', '10.00', { roundId: 'r-win' });
    await submit(container, bet);
    const win = await submit(
      container,
      wager(wallet, 'WIN', '30.00', { roundId: 'r-win', referenceExternalTransactionId: bet.payload.externalTransactionId }),
    );
    expect(win).toMatchObject({ status: 'PROCESSED', balance: { amount: '70.00' } });

    const before = await ledgerCount(container, wallet.id);
    const loss = await submit(container, wager(wallet, 'LOSS', '10.00', { roundId: 'r-loss' }));
    expect(loss).toMatchObject({ status: 'PROCESSED', balance: { amount: '70.00' } });
    expect(await ledgerCount(container, wallet.id)).toBe(before);
    const lossEvents = await sql(container).query<{ event_type: string }>(
      `SELECT event_type FROM outbox_messages WHERE aggregate_id = ?`,
      [loss.transactionId],
    );
    expect(lossEvents.map((e) => e.event_type)).toEqual(['WagerTransactionProcessed']);
    expect((await container.walletQueries.getWallet(wallet.id)).version).toBe(3); // opening(1) + bet + win
    await expectWalletConsistent(container, wallet.id);
  });

  it('REFUND reverses a BET exactly once', async () => {
    const wallet = await openWallet(container, '100.00');
    const bet = wager(wallet, 'BET', '40.00');
    await submit(container, bet);
    const refund = wager(wallet, 'REFUND', '40.00', { referenceExternalTransactionId: bet.payload.externalTransactionId });
    expect(await submit(container, refund)).toMatchObject({ status: 'PROCESSED', balance: { amount: '100.00' } });
    const second = await submit(
      container,
      wager(wallet, 'REFUND', '40.00', { referenceExternalTransactionId: bet.payload.externalTransactionId }),
    );
    expect(second).toMatchObject({ status: 'REJECTED', failureCode: 'ALREADY_REVERSED' });
    const rollbackAfterRefund = await submit(
      container,
      wager(wallet, 'ROLLBACK', '40.00', { referenceExternalTransactionId: bet.payload.externalTransactionId }),
    );
    expect(rollbackAfterRefund).toMatchObject({ status: 'REJECTED', failureCode: 'ALREADY_REVERSED' });
    await expectWalletConsistent(container, wallet.id);
  });

  it('ROLLBACK of a WIN that would overdraw is rejected with a distinct code', async () => {
    const wallet = await openWallet(container, '10.00');
    const win = wager(wallet, 'WIN', '100.00');
    await submit(container, win);
    await submit(container, wager(wallet, 'BET', '105.00'));
    const rollback = await submit(
      container,
      wager(wallet, 'ROLLBACK', '100.00', { referenceExternalTransactionId: win.payload.externalTransactionId }),
    );
    expect(rollback).toMatchObject({ status: 'REJECTED', failureCode: 'REVERSAL_WOULD_OVERDRAW', balance: { amount: '5.00' } });
    await expectWalletConsistent(container, wallet.id);
  });

  it('reference validation: round, amount, kind', async () => {
    const wallet = await openWallet(container, '100.00');
    const bet = wager(wallet, 'BET', '10.00', { roundId: 'round-A' });
    await submit(container, bet);
    const ref = bet.payload.externalTransactionId;
    expect(await submit(container, wager(wallet, 'REFUND', '10.00', { roundId: 'round-B', referenceExternalTransactionId: ref }))).toMatchObject({
      failureCode: 'REFERENCE_MISMATCH',
    });
    expect(await submit(container, wager(wallet, 'REFUND', '9.00', { roundId: 'round-A', referenceExternalTransactionId: ref }))).toMatchObject({
      failureCode: 'REFERENCE_AMOUNT_MISMATCH',
    });
    const win = wager(wallet, 'WIN', '5.00', { roundId: 'round-A' });
    await submit(container, win);
    expect(
      await submit(container, wager(wallet, 'REFUND', '5.00', { roundId: 'round-A', referenceExternalTransactionId: win.payload.externalTransactionId })),
    ).toMatchObject({ failureCode: 'REFERENCE_KIND_NOT_ALLOWED' });
    await expectWalletConsistent(container, wallet.id);
  });

  it('currency and ownership conflicts are rejected and audited', async () => {
    const wallet = await openWallet(container, '100.00');
    const usd = wager(wallet, 'BET', '1.00');
    usd.payload.money = { amount: '1.00', currency: 'USD' };
    expect(await submit(container, usd)).toMatchObject({ status: 'REJECTED', failureCode: 'CURRENCY_MISMATCH' });
    expect(await submit(container, wager({ ...wallet, playerId: 'intruder' }, 'BET', '1.00'))).toMatchObject({
      status: 'REJECTED',
      failureCode: 'WALLET_PLAYER_MISMATCH',
    });
  });

  it('contract errors are not persisted', async () => {
    const wallet = await openWallet(container, '100.00');
    await expect(submit(container, wager(wallet, 'OPENING', '1.00'))).rejects.toBeInstanceOf(InvalidWagerTransactionError);
    await expect(submit(container, wager(wallet, 'BET', '1.001'))).rejects.toBeInstanceOf(InvalidMoneyError);
    await expect(submit(container, wager(wallet, 'REFUND', '1.00'))).rejects.toBeInstanceOf(InvalidWagerTransactionError);
    await expect(
      submit(container, wager({ id: '0192f291-27dd-7d3f-8071-5f8685deef37', playerId: 'x' }, 'BET', '1.00')),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('atomicity', () => {
  it('a failure after all writes rolls back transaction, wallet, ledger, inbox and outbox together', async () => {
    const wallet = await openWallet(container, '100.00');
    const failingUow = (inner: UnitOfWork): UnitOfWork => ({
      read: (work) => inner.read(work),
      run: (work, options) =>
        inner.run(async (repos) => {
          await work(repos);
          throw new Error('crash right before COMMIT');
        }, options),
    });
    const faulty = await createTestContainer(uniqueQueueEnv('atom'), { wrapUnitOfWork: failingUow });
    try {
      const bet = wager(wallet, 'BET', '30.00');
      await expect(
        faulty.processWager.execute({
          ...bet,
          source: 'sqs',
          correlationId: 'c',
          inbox: { consumerName: 'test', messageId: 'atomic-1', payloadHash: 'f'.repeat(64) },
        }),
      ).rejects.toThrow('crash right before COMMIT');

      const db = sql(container);
      expect(await db.one(`SELECT 1 FROM wager_transactions WHERE idempotency_key = ?`, [bet.idempotencyKey])).toBeUndefined();
      expect(await db.one(`SELECT 1 FROM inbox_messages WHERE message_id = 'atomic-1'`)).toBeUndefined();
      expect(await ledgerCount(container, wallet.id, 'DEBIT')).toBe(0);
      expect(await outboxTypes(wallet.id)).toEqual(['WagerTransactionProcessed', 'WalletBalanceChanged'].sort()); // opening only
      expect((await container.walletQueries.getWallet(wallet.id)).balance.amount).toBe('100.00');

      // The same request succeeds afterwards on a healthy instance.
      expect(await submit(container, bet)).toMatchObject({ status: 'PROCESSED', idempotentReplay: false });
    } finally {
      await faulty.close();
    }
    await expectWalletConsistent(container, wallet.id);
  });
});

describe('ledger pagination', () => {
  it('stable opaque cursor', async () => {
    const wallet = await openWallet(container, '100.00');
    for (let i = 0; i < 7; i++) await submit(container, wager(wallet, 'BET', '1.00'));
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await container.walletQueries.getLedger(wallet.id, cursor, 3);
      seen.push(...page.entries.map((e) => e.id));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(seen).toHaveLength(8);
    expect(new Set(seen).size).toBe(8);
  });
});
