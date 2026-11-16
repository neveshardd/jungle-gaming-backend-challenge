import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Container } from '../../src/bootstrap/container';
import { createSqsClient } from '../../src/infrastructure/sqs/sqs-client';
import { OutboxPublisher } from '../../src/infrastructure/sqs/outbox-publisher';
import {
  createTestContainer,
  expectAllWalletsConsistent,
  openWallet,
  receiveAll,
  resetDatabase,
  sql,
  submit,
  uniqueQueueEnv,
  waitFor,
  wager,
} from '../support/harness';

let a: Container;

beforeAll(async () => {
  await resetDatabase();
  a = await createTestContainer(uniqueQueueEnv('outbox'));
});

afterAll(async () => {
  await expectAllWalletsConsistent(a);
  await a.close();
});

async function pendingCount(c: Container): Promise<number> {
  const row = await sql(c).one<{ n: number }>(`SELECT count(*)::int AS n FROM outbox_messages WHERE published_at IS NULL`);
  return row?.n ?? 0;
}

function eventIds(messages: Array<{ Body?: string }>): string[] {
  return messages.map((m) => (JSON.parse(m.Body ?? '{}') as { eventId: string }).eventId);
}

describe('transactional outbox', () => {
  it('events are only written with the commit and published afterwards (envelope format)', async () => {
    const wallet = await openWallet(a, '100.00');
    await submit(a, wager(wallet, 'BET', '10.00'));
    expect(await pendingCount(a)).toBe(4); // opening: processed + balance; bet: processed + balance
    expect(await a.outboxPublisher.publishOnce()).toBe(false);
    expect(await pendingCount(a)).toBe(0);

    const messages = await receiveAll(a.sqs, a.queues.events, { waitMs: 2000 });
    expect(messages).toHaveLength(4);
    const envelope = JSON.parse(messages[0]?.Body ?? '{}') as Record<string, unknown>;
    expect(envelope).toMatchObject({ eventType: expect.any(String), version: 1, aggregateId: expect.any(String) });
    expect(typeof envelope.occurredAt).toBe('string');
    const balanceEvent = messages
      .map((m) => JSON.parse(m.Body ?? '{}') as { eventType: string; data: { balanceAfter?: unknown } })
      .find((e) => e.eventType === 'WalletBalanceChanged');
    expect(balanceEvent?.data.balanceAfter).toEqual(expect.objectContaining({ currency: 'BRL', amount: expect.any(String) }));
  });

  it('two publishers over the same outbox: every event published, none lost', async () => {
    const b = await createTestContainer({
      SQS_INPUT_QUEUE: a.config.sqs.inputQueue,
      SQS_DLQ: a.config.sqs.deadLetterQueue,
      SQS_EVENTS_QUEUE: a.config.sqs.eventsQueue,
      INSTANCE_ID: 'publisher-b',
      OUTBOX_BATCH_SIZE: '7',
    });
    try {
      const wallets = await Promise.all(Array.from({ length: 20 }, () => openWallet(a, '50.00')));
      await Promise.all(wallets.map((w) => submit(a, wager(w, 'BET', '1.00'))));
      const expected = await sql(a).query<{ id: string }>(`SELECT id FROM outbox_messages WHERE published_at IS NULL`);
      expect(expected.length).toBe(80);

      a.startWorkers({ consumer: false, pendingReferences: false, outboxMonitor: false });
      b.startWorkers({ consumer: false, pendingReferences: false, outboxMonitor: false });
      await waitFor(async () => (await pendingCount(a)) === 0, { description: 'outbox drained' });
      await a.stopWorkers(2000);
      await b.stopWorkers(2000);

      const published = await receiveAll(a.sqs, a.queues.events, { waitMs: 4000 });
      const ids = new Set(eventIds(published));
      for (const row of expected) expect(ids.has(row.id)).toBe(true);
      const byPublisher = await sql(a).query<{ n: number }>(
        `SELECT count(*)::int AS n FROM outbox_messages WHERE id = ANY(?::uuid[]) AND published_at IS NOT NULL`,
        [expected.map((r) => r.id)],
      );
      expect(byPublisher[0]?.n).toBe(80);
    } finally {
      await b.close();
    }
  });

  it('a publisher that dies after claiming: the lease expires and another instance publishes', async () => {
    const wallet = await openWallet(a, '10.00');
    await submit(a, wager(wallet, 'BET', '1.00'));
    // "Dead" publisher: claims (lease 2s in tests) and never publishes nor releases.
    const claimed = await a.outboxStore.claimDue('dead-instance', 100, 2000);
    expect(claimed.length).toBeGreaterThan(0);
    expect(await a.outboxStore.claimDue('other-instance', 100, 2000)).toHaveLength(0); // still leased

    a.startWorkers({ consumer: false, pendingReferences: false, outboxMonitor: false });
    await waitFor(async () => (await pendingCount(a)) === 0, { timeoutMs: 10_000, description: 'lease takeover' });
    await a.stopWorkers(2000);
    const published = eventIds(await receiveAll(a.sqs, a.queues.events, { waitMs: 2000 }));
    for (const m of claimed) expect(published).toContain(m.id);
  });

  it('broker unavailable: events stay pending with exponential backoff, then go out', async () => {
    const wallet = await openWallet(a, '10.00');
    await submit(a, wager(wallet, 'BET', '1.00'));
    const brokenSqs = createSqsClient({ ...a.config.aws, endpoint: 'http://127.0.0.1:1' });
    const broken = new OutboxPublisher({
      store: a.outboxStore,
      sqs: brokenSqs,
      queueUrl: a.queues.events,
      owner: 'broken-publisher',
      config: a.config.outbox,
      clock: a.clock,
      metrics: a.metrics,
      logger: a.logger,
    });
    await broken.publishOnce();
    const rows = await sql(a).query<{ attempts: number; last_error: string | null; next_attempt_at: Date }>(
      `SELECT attempts, last_error, next_attempt_at FROM outbox_messages WHERE published_at IS NULL`,
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(r.attempts).toBe(1);
      expect(r.last_error).toBeString();
    }
    brokenSqs.destroy();

    a.startWorkers({ consumer: false, pendingReferences: false, outboxMonitor: false });
    await waitFor(async () => (await pendingCount(a)) === 0, { timeoutMs: 10_000, description: 'recovered publish' });
    await a.stopWorkers(2000);
    await receiveAll(a.sqs, a.queues.events, { waitMs: 1000 });
  });
});
