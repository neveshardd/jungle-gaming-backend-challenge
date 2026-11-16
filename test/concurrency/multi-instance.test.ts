import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { Container } from '../../src/bootstrap/container';
import {
  createTestContainer,
  expectAllWalletsConsistent,
  expectWalletConsistent,
  httpWager,
  ledgerCount,
  postJson,
  receiveAll,
  resetDatabase,
  sendWagerMessage,
  type ServiceProcess,
  sql,
  startServiceProcess,
  uniqueQueueEnv,
  waitFor,
  wager,
  wagerMessage,
} from '../support/harness';

/**
 * Scenario 4 — three independent OS processes (`bun src/main.ts`, APP_ROLE=all), each with
 * its own connection pool, SQS consumer, outbox publisher and pending-reference worker,
 * sharing one PostgreSQL and one set of queues.
 */
const PORTS = [3101, 3102, 3103];
let instances: ServiceProcess[] = [];
let observer: Container;
let queueEnv: Record<string, string>;

beforeAll(async () => {
  await resetDatabase();
  queueEnv = uniqueQueueEnv('multi');
  observer = await createTestContainer(queueEnv); // no workers: used for assertions and to send messages
  instances = await Promise.all(PORTS.map((port) => startServiceProcess({ ...queueEnv, APP_ROLE: 'all' }, port)));
});

afterAll(async () => {
  await Promise.all(instances.map((i) => i.stop('SIGKILL')));
  await expectAllWalletsConsistent(observer);
  await observer.close();
});

const pick = (i: number) => instances[i % instances.length]!.baseUrl;

async function createWallet(amount: string) {
  const res = await postJson(pick(0), '/wallets', { playerId: randomUUID(), initialBalance: { amount, currency: 'BRL' } });
  expect(res.status).toBe(201);
  return res.body as { id: string; playerId: string };
}

describe('scenario 4 — three instances at the same time', () => {
  it('the same BET 50x spread over 3 instances => one debit', async () => {
    const wallet = await createWallet('1000.00');
    const bet = wager(wallet, 'BET', '25.00');
    const responses = await Promise.all(Array.from({ length: 50 }, (_, i) => httpWager(pick(i), bet)));
    expect(responses.filter((r) => r.status === 201)).toHaveLength(1);
    expect(responses.filter((r) => r.status === 200)).toHaveLength(49);
    expect(await ledgerCount(observer, wallet.id, 'DEBIT')).toBe(1);
    await expectWalletConsistent(observer, wallet.id);
  });

  it('hot wallet 100.00 vs 2 x 80.00 on different instances (repeated)', async () => {
    for (let round = 0; round < 10; round++) {
      const wallet = await createWallet('100.00');
      const [r1, r2] = await Promise.all([
        httpWager(pick(round), wager(wallet, 'BET', '80.00')),
        httpWager(pick(round + 1), wager(wallet, 'BET', '80.00')),
      ]);
      expect([r1.status, r2.status].sort()).toEqual([201, 422]);
      const balance = await sql(observer).one<{ b: string }>(`SELECT balance_amount::text AS b FROM wallets WHERE id = ?`, [wallet.id]);
      expect(balance?.b).toBe('20.00');
      expect(await ledgerCount(observer, wallet.id, 'DEBIT')).toBe(1);
    }
  });

  it('HTTP + SQS traffic (with duplicated deliveries) across instances converges to a consistent state', async () => {
    const wallets = await Promise.all(Array.from({ length: 10 }, () => createWallet('200.00')));
    const httpRequests = wallets.flatMap((w) => Array.from({ length: 5 }, () => wager(w, 'BET', '2.00')));
    const sqsRequests = wallets.flatMap((w) => Array.from({ length: 5 }, () => wager(w, 'WIN', '1.50')));

    const sends = sqsRequests.flatMap((request) => {
      const message = wagerMessage(request);
      return [sendWagerMessage(observer, message), sendWagerMessage(observer, message)]; // every message delivered twice
    });
    await Promise.all([...sends, ...httpRequests.map((r, i) => httpWager(pick(i), r))]);

    await waitFor(
      async () => {
        const row = await sql(observer).one<{ n: number }>(
          `SELECT count(*)::int AS n FROM wager_transactions WHERE kind = 'WIN' AND status = 'PROCESSED'`,
        );
        return (row?.n ?? 0) >= sqsRequests.length;
      },
      { timeoutMs: 60_000, description: 'all queued WINs processed' },
    );
    for (const w of wallets) {
      // 200 - 5*2.00 + 5*1.50 = 197.50
      const balance = await sql(observer).one<{ b: string }>(`SELECT balance_amount::text AS b FROM wallets WHERE id = ?`, [w.id]);
      expect(balance?.b).toBe('197.50');
      expect(await ledgerCount(observer, w.id)).toBe(11);
      await expectWalletConsistent(observer, w.id);
    }
    const inbox = await sql(observer).one<{ n: number }>(`SELECT count(*)::int AS n FROM inbox_messages`);
    expect(inbox?.n).toBe(sqsRequests.length);
  });

  it('all instances publish the outbox concurrently and nothing is lost', async () => {
    await waitFor(
      async () => {
        const row = await sql(observer).one<{ n: number }>(`SELECT count(*)::int AS n FROM outbox_messages WHERE published_at IS NULL`);
        return row?.n === 0;
      },
      { timeoutMs: 30_000, description: 'outbox drained by the 3 instances' },
    );
    const total = await sql(observer).query<{ id: string }>(`SELECT id FROM outbox_messages`);
    const published = await receiveAll(observer.sqs, observer.queues.events, { waitMs: 8000, max: 100_000 });
    const ids = new Set(published.map((m) => (JSON.parse(m.Body ?? '{}') as { eventId: string }).eventId));
    const missing = total.filter((row) => !ids.has(row.id));
    expect(missing).toHaveLength(0);
  });
});
