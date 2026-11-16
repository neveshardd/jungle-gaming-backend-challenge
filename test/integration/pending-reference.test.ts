import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Container } from '../../src/bootstrap/container';
import {
  createTestContainer,
  expectAllWalletsConsistent,
  expectWalletConsistent,
  ledgerCount,
  openWallet,
  resetDatabase,
  sendWagerMessage,
  sql,
  submit,
  uniqueQueueEnv,
  waitFor,
  wager,
  wagerMessage,
} from '../support/harness';

let c: Container;

beforeAll(async () => {
  await resetDatabase();
  c = await createTestContainer({ ...uniqueQueueEnv('pending'), PENDING_REF_MAX_ATTEMPTS: '3' });
});

afterAll(async () => {
  await expectAllWalletsConsistent(c);
  await c.close();
});

async function statusOf(externalId: string) {
  return sql(c).one<{ status: string; failure_code: string | null; reference_attempts: number }>(
    `SELECT status, failure_code, reference_attempts FROM wager_transactions WHERE provider_id = 'provider-a' AND external_transaction_id = ?`,
    [externalId],
  );
}

describe('out-of-order references', () => {
  it('REFUND before its BET: PENDING_REFERENCE, then resolved by the worker once the BET arrives', async () => {
    const wallet = await openWallet(c, '100.00');
    const bet = wager(wallet, 'BET', '40.00');
    const refund = wager(wallet, 'REFUND', '40.00', { referenceExternalTransactionId: bet.payload.externalTransactionId });

    expect(await submit(c, refund)).toMatchObject({ status: 'PENDING_REFERENCE' });
    const pendingEvent = await sql(c).one(`SELECT 1 FROM outbox_messages WHERE event_type = 'WagerTransactionPendingReference'`);
    expect(pendingEvent).toBeDefined();

    expect(await submit(c, bet)).toMatchObject({ status: 'PROCESSED', balance: { amount: '60.00' } });
    c.startWorkers({ consumer: false, outbox: false, outboxMonitor: false });
    try {
      await waitFor(async () => (await statusOf(refund.payload.externalTransactionId))?.status === 'PROCESSED', {
        description: 'refund resolved',
      });
    } finally {
      await c.stopWorkers(2000);
    }
    expect((await c.walletQueries.getWallet(wallet.id)).balance.amount).toBe('100.00');
    // Replay of the refund now returns the final state
    expect(await submit(c, refund)).toMatchObject({ status: 'PROCESSED', idempotentReplay: true });
    await expectWalletConsistent(c, wallet.id);
  });

  it('ROLLBACK via SQS before the BET (both through the queue)', async () => {
    const wallet = await openWallet(c, '100.00');
    const bet = wager(wallet, 'BET', '25.00');
    const rollback = wager(wallet, 'ROLLBACK', '25.00', { referenceExternalTransactionId: bet.payload.externalTransactionId });
    await sendWagerMessage(c, wagerMessage(rollback));
    await sendWagerMessage(c, wagerMessage(bet));
    c.startWorkers({ outbox: false, outboxMonitor: false });
    try {
      await waitFor(async () => (await statusOf(rollback.payload.externalTransactionId))?.status === 'PROCESSED', {
        description: 'rollback resolved',
      });
    } finally {
      await c.stopWorkers(2000);
    }
    expect((await c.walletQueries.getWallet(wallet.id)).balance.amount).toBe('100.00');
    expect(await ledgerCount(c, wallet.id)).toBe(3); // opening, bet debit, rollback credit
    await expectWalletConsistent(c, wallet.id);
  });

  it('reference never arrives: REJECTED with REFERENCE_NOT_FOUND after the retry budget, event published', async () => {
    const wallet = await openWallet(c, '100.00');
    const orphan = wager(wallet, 'ROLLBACK', '5.00', { referenceExternalTransactionId: 'never-arrives' });
    await submit(c, orphan);
    c.startWorkers({ consumer: false, outbox: false, outboxMonitor: false });
    try {
      const row = await waitFor(
        async () => {
          const r = await statusOf(orphan.payload.externalTransactionId);
          return r?.status === 'REJECTED' ? r : undefined;
        },
        { timeoutMs: 15_000, description: 'orphan rejected' },
      );
      expect(row.failure_code).toBe('REFERENCE_NOT_FOUND');
      expect(row.reference_attempts).toBe(3);
    } finally {
      await c.stopWorkers(2000);
    }
    const rejected = await sql(c).one(
      `SELECT 1 FROM outbox_messages WHERE event_type = 'WagerTransactionRejected' AND payload->'data'->>'externalTransactionId' = ?`,
      [orphan.payload.externalTransactionId],
    );
    expect(rejected).toBeDefined();
    expect(await ledgerCount(c, wallet.id)).toBe(1);
    await expectWalletConsistent(c, wallet.id);
  });

  it('concurrent workers resolve a pending transaction exactly once', async () => {
    const wallet = await openWallet(c, '100.00');
    const bet = wager(wallet, 'BET', '10.00');
    const refund = wager(wallet, 'REFUND', '10.00', { referenceExternalTransactionId: bet.payload.externalTransactionId });
    const pending = await submit(c, refund);
    await submit(c, bet);
    const outcomes = await Promise.all(Array.from({ length: 8 }, () => c.resolvePendingReference.resolve(pending.transactionId)));
    expect(outcomes.filter((o) => o === 'processed')).toHaveLength(1);
    expect(await ledgerCount(c, wallet.id, 'CREDIT')).toBe(2); // opening + refund
    await expectWalletConsistent(c, wallet.id);
  });
});
