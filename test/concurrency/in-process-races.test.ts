import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Container } from '../../src/bootstrap/container';
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

/**
 * Real parallelism: every call below runs its own SQL transaction on its own pooled
 * connection, so the races happen inside PostgreSQL — nothing is serialized in JS.
 * Two containers (two independent pools / "instances") are used to also exercise
 * cross-instance contention.
 */
let a: Container;
let b: Container;

beforeAll(async () => {
  await resetDatabase();
  const queues = uniqueQueueEnv('race');
  a = await createTestContainer({ ...queues, DB_POOL_MAX: '40', INSTANCE_ID: 'race-a' });
  b = await createTestContainer({ ...queues, DB_POOL_MAX: '40', INSTANCE_ID: 'race-b' });
});

afterAll(async () => {
  await expectAllWalletsConsistent(a);
  await a.close();
  await b.close();
});

describe('scenario 1 — the same BET sent 50 times in parallel', () => {
  it('produces exactly one debit; every other call is an idempotent replay of it', async () => {
    const wallet = await openWallet(a, '1000.00');
    const bet = wager(wallet, 'BET', '25.00');
    const results = await Promise.all(Array.from({ length: 50 }, (_, i) => submit(i % 2 ? a : b, bet)));

    const originals = results.filter((r) => !r.idempotentReplay);
    expect(originals).toHaveLength(1);
    expect(new Set(results.map((r) => r.transactionId)).size).toBe(1);
    for (const r of results) {
      expect(r.status).toBe('PROCESSED');
      expect(r.balance?.amount).toBe('975.00');
    }
    expect(await ledgerCount(a, wallet.id, 'DEBIT')).toBe(1);
    expect((await a.walletQueries.getWallet(wallet.id)).balance.amount).toBe('975.00');
    await expectWalletConsistent(a, wallet.id);
  });
});

describe('scenario 2 — concurrent operations competing for the same balance (hot wallet)', () => {
  it('100.00 and two simultaneous BETs of 80.00: one PROCESSED, one REJECTED, balance 20.00 (repeated 20x)', async () => {
    for (let round = 0; round < 20; round++) {
      const wallet = await openWallet(a, '100.00');
      const bet1 = wager(wallet, 'BET', '80.00');
      const bet2 = wager(wallet, 'BET', '80.00');
      const results = await Promise.all([submit(a, bet1), submit(b, bet2)]);

      expect(results.filter((r) => r.status === 'PROCESSED')).toHaveLength(1);
      const rejected = results.filter((r) => r.status === 'REJECTED');
      expect(rejected).toHaveLength(1);
      expect(rejected[0]?.failureCode).toBe('INSUFFICIENT_FUNDS');
      expect((await a.walletQueries.getWallet(wallet.id)).balance.amount).toBe('20.00');
      expect(await ledgerCount(a, wallet.id, 'DEBIT')).toBe(1);

      // retries of both requests never duplicate the debit
      const retries = await Promise.all([submit(b, bet1), submit(a, bet2), submit(a, bet1), submit(b, bet2)]);
      expect(retries.every((r) => r.idempotentReplay)).toBe(true);
      expect(await ledgerCount(a, wallet.id, 'DEBIT')).toBe(1);
      await expectWalletConsistent(a, wallet.id);
    }
  });

  it('200 parallel 1.00 BETs on a 150.00 wallet: exactly 150 succeed and the balance hits 0.00, never below', async () => {
    const wallet = await openWallet(a, '150.00');
    const results = await Promise.all(
      Array.from({ length: 200 }, (_, i) => submit(i % 2 ? a : b, wager(wallet, 'BET', '1.00'))),
    );
    expect(results.filter((r) => r.status === 'PROCESSED')).toHaveLength(150);
    expect(results.filter((r) => r.failureCode === 'INSUFFICIENT_FUNDS')).toHaveLength(50);
    expect((await a.walletQueries.getWallet(wallet.id)).balance.amount).toBe('0.00');
    const negatives = await sql(a).one<{ n: number }>(
      `SELECT count(*)::int AS n FROM wallet_ledger_entries WHERE wallet_id = ? AND balance_after < 0`,
      [wallet.id],
    );
    expect(negatives?.n).toBe(0);
    await expectWalletConsistent(a, wallet.id);
  });

  it('mixed BET / WIN / LOSS / REFUND / ROLLBACK storm on one wallet stays consistent', async () => {
    const wallet = await openWallet(a, '500.00');
    const bets = Array.from({ length: 40 }, () => wager(wallet, 'BET', '5.00'));
    await Promise.all(bets.map((bet, i) => submit(i % 2 ? a : b, bet)));
    const followUps = bets.flatMap((bet, i) => {
      const ref = bet.payload.externalTransactionId;
      switch (i % 4) {
        case 0:
          return [wager(wallet, 'WIN', '12.34', { referenceExternalTransactionId: ref })];
        case 1:
          return [wager(wallet, 'LOSS', '5.00', { referenceExternalTransactionId: ref })];
        case 2: // both reversals race for the same bet: only one may win
          return [
            wager(wallet, 'REFUND', '5.00', { referenceExternalTransactionId: ref }),
            wager(wallet, 'ROLLBACK', '5.00', { referenceExternalTransactionId: ref }),
          ];
        default:
          return [wager(wallet, 'ROLLBACK', '5.00', { referenceExternalTransactionId: ref })];
      }
    });
    const results = await Promise.all(followUps.map((w, i) => submit(i % 2 ? a : b, w)));
    expect(results.filter((r) => r.failureCode === 'ALREADY_REVERSED')).toHaveLength(10);
    await expectWalletConsistent(a, wallet.id);
  });
});

describe('scenario 3 — distinct wallets processed in parallel', () => {
  it('50 wallets x 10 operations each, all in parallel, no cross-wallet blocking or leakage', async () => {
    const wallets = await Promise.all(Array.from({ length: 50 }, () => openWallet(a, '100.00')));
    const started = performance.now();
    await Promise.all(
      wallets.flatMap((w, wi) =>
        Array.from({ length: 10 }, (_, i) => submit((wi + i) % 2 ? a : b, wager(w, i % 3 === 0 ? 'WIN' : 'BET', '3.00'))),
      ),
    );
    const elapsed = performance.now() - started;
    for (const w of wallets) {
      // 4 WIN (+12.00) and 6 BET (-18.00)  => 94.00
      expect((await a.walletQueries.getWallet(w.id)).balance.amount).toBe('94.00');
      await expectWalletConsistent(a, w.id);
    }
    // Generous bound: 500 transactions must not be serialized behind a global lock.
    expect(elapsed).toBeLessThan(60_000);
  });
});
