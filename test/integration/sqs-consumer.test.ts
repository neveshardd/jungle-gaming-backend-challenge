import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { Container } from '../../src/bootstrap/container';
import { TransientError } from '../../src/shared/application/errors';
import type { UnitOfWork } from '../../src/shared/application/unit-of-work';
import {
  createTestContainer,
  expectAllWalletsConsistent,
  expectWalletConsistent,
  ledgerCount,
  openWallet,
  receiveAll,
  resetDatabase,
  sendRaw,
  sendWagerMessage,
  sql,
  uniqueQueueEnv,
  waitFor,
  wager,
  wagerMessage,
} from '../support/harness';

const containers: Container[] = [];
let main: Container;

async function newContainer(prefix: string, overrides: Record<string, string> = {}, wrap?: (u: UnitOfWork) => UnitOfWork) {
  const c = await createTestContainer({ ...uniqueQueueEnv(prefix), ...overrides }, wrap ? { wrapUnitOfWork: wrap } : {});
  containers.push(c);
  return c;
}

async function txStatus(c: Container, providerId: string, externalId: string) {
  const row = await sql(c).one<{ status: string; failure_code: string | null }>(
    `SELECT status, failure_code FROM wager_transactions WHERE provider_id = ? AND external_transaction_id = ?`,
    [providerId, externalId],
  );
  return row;
}

beforeAll(async () => {
  await resetDatabase();
  main = await newContainer('sqs');
});

afterEach(async () => {
  for (const c of containers) await c.stopWorkers(2000);
});

afterAll(async () => {
  await expectAllWalletsConsistent(main);
  for (const c of containers) await c.close();
});

describe('SQS consumer', () => {
  it('processes a message through the same use case and acks it after commit', async () => {
    const c = await newContainer('sqs-ok');
    const wallet = await openWallet(c, '100.00');
    const bet = wager(wallet, 'BET', '30.00');
    await sendWagerMessage(c, wagerMessage(bet));
    c.startWorkers({ outbox: false, pendingReferences: false, outboxMonitor: false });

    const row = await waitFor(() => txStatus(c, 'provider-a', bet.payload.externalTransactionId), { description: 'processed' });
    expect(row.status).toBe('PROCESSED');
    const inbox = await sql(c).one<{ processed_at: string | null }>(
      `SELECT processed_at FROM inbox_messages WHERE consumer_name = ?`,
      [c.config.sqs.consumerName],
    );
    expect(inbox?.processed_at).toBeString();
    await c.stopWorkers(2000);
    expect(await receiveAll(c.sqs, c.queues.input, { waitMs: 1500 })).toHaveLength(0);
    await expectWalletConsistent(c, wallet.id);
  });

  it('redelivery of the same messageId is deduplicated by the persistent inbox (one debit)', async () => {
    const c = await newContainer('sqs-dup');
    const wallet = await openWallet(c, '100.00');
    const message = wagerMessage(wager(wallet, 'BET', '10.00'));
    for (let i = 0; i < 5; i++) await sendWagerMessage(c, message); // distinct SQS dedup ids: SQS delivers all 5
    c.startWorkers({ outbox: false, pendingReferences: false, outboxMonitor: false });

    await waitFor(async () => (await c.metrics.counterValue('wagering_sqs_messages_total')) >= 5, {
      description: '5 deliveries handled',
    });
    expect(await ledgerCount(c, wallet.id, 'DEBIT')).toBe(1);
    expect(await c.metrics.counterValue('wagering_duplicates_detected_total', { kind: 'inbox_duplicate' })).toBe(4);
    await expectWalletConsistent(c, wallet.id);
  });

  it('a different messageId with the same idempotency key is an idempotent replay', async () => {
    const c = await newContainer('sqs-replay');
    const wallet = await openWallet(c, '100.00');
    const bet = wager(wallet, 'BET', '10.00');
    await sendWagerMessage(c, wagerMessage(bet, 'm-1'));
    await sendWagerMessage(c, wagerMessage(bet, 'm-2'));
    c.startWorkers({ outbox: false, pendingReferences: false, outboxMonitor: false });
    await waitFor(async () => (await c.metrics.counterValue('wagering_duplicates_detected_total', { kind: 'idempotent_replay' })) === 1, {
      description: 'replay detected',
    });
    expect(await ledgerCount(c, wallet.id, 'DEBIT')).toBe(1);
  });

  it('business errors are acked (not retried, not dead-lettered)', async () => {
    const c = await newContainer('sqs-biz');
    const ghost = wager({ id: randomUUID(), playerId: 'p' }, 'BET', '1.00');
    await sendWagerMessage(c, wagerMessage(ghost));
    c.startWorkers({ outbox: false, pendingReferences: false, outboxMonitor: false });
    await waitFor(async () => (await c.metrics.counterValue('wagering_sqs_messages_total', { outcome: 'business_error' })) === 1, {
      description: 'business error handled',
    });
    await c.stopWorkers(2000);
    expect(await receiveAll(c.sqs, c.queues.input, { waitMs: 1500 })).toHaveLength(0);
    expect(await receiveAll(c.sqs, c.queues.deadLetter, { waitMs: 1500 })).toHaveLength(0);
  });

  it('broken contracts go straight to the DLQ', async () => {
    const c = await newContainer('sqs-dlq');
    await sendRaw(c.sqs, c.queues.input, '{this is not json', 'g-1');
    await sendRaw(c.sqs, c.queues.input, JSON.stringify({ messageId: 'x', type: 'Unknown', data: {} }), 'g-2');
    c.startWorkers({ outbox: false, pendingReferences: false, outboxMonitor: false });
    await waitFor(async () => (await c.metrics.counterValue('wagering_dlq_messages_total')) === 2, { description: 'dlq' });
    await c.stopWorkers(2000);
    const dead = await receiveAll(c.sqs, c.queues.deadLetter, { waitMs: 2000 });
    expect(dead).toHaveLength(2);
    expect(dead[0]?.MessageAttributes?.failureReason?.StringValue).toBe('INVALID_MESSAGE');
  });

  it('transient failures are retried with backoff and then succeed (no duplicate effect)', async () => {
    let failuresLeft = 2;
    const flaky = (inner: UnitOfWork): UnitOfWork => ({
      read: (work) => inner.read(work),
      run: (work, options) => {
        if (options?.label === 'process-wager' && failuresLeft > 0) {
          failuresLeft--;
          return Promise.reject(new TransientError('simulated database outage'));
        }
        return inner.run(work, options);
      },
    });
    const c = await newContainer('sqs-retry', { SQS_MAX_ATTEMPTS: '5' }, flaky);
    const wallet = await openWallet(c, '100.00');
    const bet = wager(wallet, 'BET', '10.00');
    await sendWagerMessage(c, wagerMessage(bet));
    c.startWorkers({ outbox: false, pendingReferences: false, outboxMonitor: false });
    const row = await waitFor(() => txStatus(c, 'provider-a', bet.payload.externalTransactionId), {
      timeoutMs: 30_000,
      description: 'processed after retries',
    });
    expect(row.status).toBe('PROCESSED');
    expect(await c.metrics.counterValue('wagering_sqs_messages_total', { outcome: 'retry' })).toBe(2);
    expect(await ledgerCount(c, wallet.id, 'DEBIT')).toBe(1);
  });

  it('exhausted retries end in the DLQ', async () => {
    const alwaysDown = (inner: UnitOfWork): UnitOfWork => ({
      read: (work) => inner.read(work),
      run: (work, options) =>
        options?.label === 'process-wager' ? Promise.reject(new TransientError('db down')) : inner.run(work, options),
    });
    const c = await newContainer('sqs-exhaust', { SQS_MAX_ATTEMPTS: '2' }, alwaysDown);
    const wallet = await openWallet(c, '100.00');
    await sendWagerMessage(c, wagerMessage(wager(wallet, 'BET', '10.00')));
    c.startWorkers({ outbox: false, pendingReferences: false, outboxMonitor: false });
    await waitFor(async () => (await c.metrics.counterValue('wagering_dlq_messages_total', { reason: 'MAX_ATTEMPTS_EXCEEDED' })) === 1, {
      timeoutMs: 30_000,
      description: 'max attempts DLQ',
    });
    await c.stopWorkers(2000);
    expect(await receiveAll(c.sqs, c.queues.deadLetter, { waitMs: 2000 })).toHaveLength(1);
    expect(await ledgerCount(c, wallet.id, 'DEBIT')).toBe(0);
  });
});
