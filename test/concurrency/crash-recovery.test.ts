import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Container } from '../../src/bootstrap/container';
import {
  createTestContainer,
  expectAllWalletsConsistent,
  expectWalletConsistent,
  httpWager,
  ledgerCount,
  openWallet,
  receiveAll,
  resetDatabase,
  sendWagerMessage,
  sql,
  startServiceProcess,
  submit,
  uniqueQueueEnv,
  waitFor,
  wager,
  wagerMessage,
} from '../support/harness';

let observer: Container;

beforeAll(async () => {
  await resetDatabase();
  observer = await createTestContainer(uniqueQueueEnv('observer'));
});

afterAll(async () => {
  await expectAllWalletsConsistent(observer);
  await observer.close();
});

describe('scenario 5 — worker killed AFTER commit and BEFORE ack', () => {
  it('the redelivered message is recognized by the inbox and the debit is not duplicated', async () => {
    const queues = uniqueQueueEnv('crash');
    const local = await createTestContainer(queues);
    try {
      const wallet = await openWallet(local, '100.00');
      const bet = wager(wallet, 'BET', '40.00');

      // A real process that SIGKILLs itself right after COMMIT, before DeleteMessage.
      const doomed = await startServiceProcess(
        { ...queues, APP_ROLE: 'worker', FAULT_CRASH_AFTER_COMMIT_BEFORE_ACK: 'true', SQS_VISIBILITY_TIMEOUT_SECONDS: '3' },
        3201,
      );
      await sendWagerMessage(local, wagerMessage(bet));
      const exitCode = await waitFor(async () => doomed.proc.exitCode ?? (doomed.proc.signalCode ? -1 : undefined), {
        timeoutMs: 30_000,
        description: 'worker to crash',
      });
      expect(exitCode).not.toBe(0);

      // The effect is committed...
      const tx = await sql(local).one<{ status: string }>(
        `SELECT status FROM wager_transactions WHERE idempotency_key = ?`,
        [bet.idempotencyKey],
      );
      expect(tx?.status).toBe('PROCESSED');
      expect(await ledgerCount(local, wallet.id, 'DEBIT')).toBe(1);

      // ...but the message was never acked: a healthy consumer receives it again after the visibility timeout.
      local.startWorkers({ outbox: false, pendingReferences: false, outboxMonitor: false });
      await waitFor(
        async () => (await local.metrics.counterValue('wagering_duplicates_detected_total', { kind: 'inbox_duplicate' })) === 1,
        { timeoutMs: 30_000, description: 'redelivery deduplicated by the inbox' },
      );
      await local.stopWorkers(2000);
      expect(await ledgerCount(local, wallet.id, 'DEBIT')).toBe(1);
      expect(await receiveAll(local.sqs, local.queues.input, { waitMs: 1500 })).toHaveLength(0);
      await expectWalletConsistent(local, wallet.id);
    } finally {
      await local.close();
    }
  });
});

describe('scenario 8 — service restart with proof of final consistency', () => {
  it('hard crash (SIGKILL) in the middle of HTTP + SQS traffic, restart, everything converges exactly once', async () => {
    const queues = uniqueQueueEnv('restart');
    const local = await createTestContainer(queues);
    try {
      const wallets = await Promise.all(Array.from({ length: 5 }, () => openWallet(local, '500.00')));
      const queued = wallets.flatMap((w) => Array.from({ length: 20 }, () => wager(w, 'BET', '1.00')));
      for (const request of queued) await sendWagerMessage(local, wagerMessage(request));

      const first = await startServiceProcess({ ...queues, APP_ROLE: 'all', SQS_VISIBILITY_TIMEOUT_SECONDS: '3' }, 3301);
      const httpTraffic = wallets.flatMap((w) => Array.from({ length: 10 }, () => wager(w, 'WIN', '2.00')));
      const inflight = Promise.allSettled(httpTraffic.map((r) => httpWager(first.baseUrl, r)));
      await Bun.sleep(300);
      await first.stop('SIGKILL'); // crash mid-flight
      await inflight;

      const second = await startServiceProcess({ ...queues, APP_ROLE: 'all', SQS_VISIBILITY_TIMEOUT_SECONDS: '3' }, 3302);
      try {
        // Providers retry what failed during the crash (same idempotency keys): exactly-once effect.
        const retried = await Promise.all(httpTraffic.map((r) => httpWager(second.baseUrl, r)));
        expect(retried.every((r) => r.status === 200 || r.status === 201)).toBe(true);

        await waitFor(
          async () => {
            const row = await sql(local).one<{ n: number }>(
              `SELECT count(*)::int AS n FROM wager_transactions
               WHERE kind = 'BET' AND status = 'PROCESSED' AND wallet_id = ANY(?::uuid[])`,
              [wallets.map((w) => w.id)],
            );
            return row?.n === queued.length;
          },
          { timeoutMs: 90_000, description: 'all queued BETs processed after restart' },
        );
        await waitFor(
          async () => {
            const row = await sql(local).one<{ n: number }>(`SELECT count(*)::int AS n FROM outbox_messages WHERE published_at IS NULL`);
            return row?.n === 0;
          },
          { timeoutMs: 30_000, description: 'outbox drained after restart' },
        );
      } finally {
        await second.stop('SIGKILL');
      }

      for (const w of wallets) {
        // 500 - 20*1.00 + 10*2.00 = 500.00 ; 1 opening + 20 debits + 10 credits
        const view = await local.walletQueries.getWallet(w.id);
        expect(view.balance.amount).toBe('500.00');
        expect(await ledgerCount(local, w.id)).toBe(31);
        await expectWalletConsistent(local, w.id);
      }
    } finally {
      await local.close();
    }
  });

  it.skipIf(process.platform === 'win32')('graceful SIGTERM: in-flight work completes, exit code 0', async () => {
    const queues = uniqueQueueEnv('sigterm');
    const local = await createTestContainer(queues);
    try {
      const wallet = await openWallet(local, '100.00');
      for (let i = 0; i < 30; i++) await sendWagerMessage(local, wagerMessage(wager(wallet, 'BET', '1.00')));
      const proc = await startServiceProcess({ ...queues, APP_ROLE: 'worker' }, 3401);
      await Bun.sleep(500);
      const code = await proc.stop('SIGTERM');
      expect(code).toBe(0);
      // Whatever was not processed is still in the queue (not lost) and is processed by another instance.
      local.startWorkers({ outbox: false, pendingReferences: false, outboxMonitor: false });
      await waitFor(
        async () => {
          const row = await sql(local).one<{ n: number }>(
            `SELECT count(*)::int AS n FROM wager_transactions WHERE wallet_id = ? AND kind = 'BET'`,
            [wallet.id],
          );
          return row?.n === 30;
        },
        { timeoutMs: 60_000, description: 'remaining messages processed' },
      );
      await local.stopWorkers(2000);
      expect(await ledgerCount(local, wallet.id, 'DEBIT')).toBe(30);
      await expectWalletConsistent(local, wallet.id);
    } finally {
      await local.close();
    }
  });

  it('a restarted container sees the same persisted idempotency (no in-memory state)', async () => {
    const queues = uniqueQueueEnv('replay');
    const before = await createTestContainer(queues);
    const wallet = await openWallet(before, '10.00');
    const bet = wager(wallet, 'BET', '3.00');
    const original = await submit(before, bet);
    await before.close();

    const after = await createTestContainer(queues);
    try {
      expect(await submit(after, bet)).toEqual({ ...original, idempotentReplay: true });
      expect(await ledgerCount(after, wallet.id, 'DEBIT')).toBe(1);
    } finally {
      await after.close();
    }
  });
});
