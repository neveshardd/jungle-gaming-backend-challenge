import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Container } from '../../src/bootstrap/container';
import {
  createTestContainer,
  expectAllWalletsConsistent,
  expectWalletConsistent,
  ledgerCount,
  openWallet,
  receiveAll,
  resetDatabase,
  sql,
  startServiceProcess,
  submit,
  uniqueQueueEnv,
  waitFor,
  wager,
} from '../support/harness';

let a: Container;
let b: Container;

beforeAll(async () => {
  await resetDatabase();
  const queues = uniqueQueueEnv('pubs');
  a = await createTestContainer({ ...queues, INSTANCE_ID: 'pub-a' });
  b = await createTestContainer({ ...queues, INSTANCE_ID: 'pub-b' });
});

afterAll(async () => {
  await expectAllWalletsConsistent(a);
  await a.close();
  await b.close();
});

describe('scenario 6 — two publishers over the same outbox', () => {
  it('two separate processes drain 300 events: every event published at least once, none lost', async () => {
    const queues = uniqueQueueEnv('pubproc');
    const writer = await createTestContainer(queues);
    try {
      const wallets = await Promise.all(Array.from({ length: 50 }, () => openWallet(writer, '100.00')));
      await Promise.all(wallets.flatMap((w) => [submit(writer, wager(w, 'BET', '1.00')), submit(writer, wager(w, 'LOSS', '1.00'))]));
      const expected = await sql(writer).query<{ id: string }>(`SELECT id FROM outbox_messages WHERE published_at IS NULL`);
      expect(expected.length).toBeGreaterThanOrEqual(250);

      const env = { ...queues, APP_ROLE: 'worker', OUTBOX_BATCH_SIZE: '20' };
      const [p1, p2] = await Promise.all([startServiceProcess(env, 3501), startServiceProcess(env, 3502)]);
      try {
        await waitFor(
          async () => {
            const row = await sql(writer).one<{ n: number }>(`SELECT count(*)::int AS n FROM outbox_messages WHERE published_at IS NULL`);
            return row?.n === 0;
          },
          { timeoutMs: 60_000, description: 'outbox drained by two processes' },
        );
      } finally {
        await Promise.all([p1.stop('SIGKILL'), p2.stop('SIGKILL')]);
      }
      const ids = new Set(
        (await receiveAll(writer.sqs, writer.queues.events, { waitMs: 8000, max: 100_000 })).map(
          (m) => (JSON.parse(m.Body ?? '{}') as { eventId: string }).eventId,
        ),
      );
      expect(expected.filter((row) => !ids.has(row.id))).toHaveLength(0);
    } finally {
      await writer.close();
    }
  });

  it('claims never overlap: concurrent claimDue calls lease disjoint sets', async () => {
    const wallets = await Promise.all(Array.from({ length: 30 }, () => openWallet(a, '10.00')));
    await Promise.all(wallets.map((w) => submit(a, wager(w, 'BET', '1.00'))));
    const claims = await Promise.all(
      Array.from({ length: 6 }, (_, i) => (i % 2 ? a : b).outboxStore.claimDue(`claimer-${i}`, 25, 60_000)),
    );
    const all = claims.flat().map((m) => m.id);
    expect(new Set(all).size).toBe(all.length);
    expect(all.length).toBe(120);
  });
});

describe('scenario 7 — REFUND / ROLLBACK delivered before (or concurrently with) the reference', () => {
  it('20 wallets: reversal and reference raced in parallel on two instances, all resolve exactly once', async () => {
    a.startWorkers({ consumer: false, outbox: false, outboxMonitor: false });
    b.startWorkers({ consumer: false, outbox: false, outboxMonitor: false });
    try {
      const cases = await Promise.all(
        Array.from({ length: 20 }, async (_, i) => {
          const wallet = await openWallet(a, '100.00');
          const bet = wager(wallet, 'BET', '10.00');
          const reversal = wager(wallet, i % 2 ? 'REFUND' : 'ROLLBACK', '10.00', {
            referenceExternalTransactionId: bet.payload.externalTransactionId,
          });
          await Promise.all([submit(i % 2 ? a : b, reversal), submit(i % 2 ? b : a, bet)]);
          return { wallet, reversal };
        }),
      );
      for (const { wallet, reversal } of cases) {
        await waitFor(
          async () => {
            const row = await sql(a).one<{ status: string }>(`SELECT status FROM wager_transactions WHERE idempotency_key = ?`, [
              reversal.idempotencyKey,
            ]);
            return row?.status === 'PROCESSED';
          },
          { description: 'reversal processed' },
        );
        expect((await a.walletQueries.getWallet(wallet.id)).balance.amount).toBe('100.00');
        expect(await ledgerCount(a, wallet.id)).toBe(3);
        await expectWalletConsistent(a, wallet.id);
      }
    } finally {
      await a.stopWorkers(2000);
      await b.stopWorkers(2000);
    }
  });
});
