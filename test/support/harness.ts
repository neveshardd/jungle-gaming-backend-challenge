import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import {
  DeleteMessageCommand,
  type Message,
  PurgeQueueCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  type SQSClient,
} from '@aws-sdk/client-sqs';
import type { INestApplication } from '@nestjs/common';
import { MikroORM } from '@mikro-orm/postgresql';
import { expect } from 'bun:test';
import { Container, type ContainerOptions } from '../../src/bootstrap/container';
import { type AppConfig, loadConfig } from '../../src/config/config';
import { createHttpApp } from '../../src/http/app-factory';
import { buildOrmConfig } from '../../src/infrastructure/database/mikro-orm.config';
import { SqlExecutor } from '../../src/infrastructure/database/sql-executor';
import { WAGER_TRANSACTION_REQUESTED } from '../../src/infrastructure/sqs/message-contract';
import type { WagerPayload } from '../../src/wagering/domain/payload-hash';
import type { WagerSubmission } from '../../src/wagering/application/process-wager-transaction';

export const PROJECT_ROOT = resolve(import.meta.dir, '..', '..');
export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://wagering:wagering@localhost:5432/wagering_test';
export const TEST_AWS_ENDPOINT = process.env.AWS_ENDPOINT_URL ?? 'http://localhost:4566';

/** Unique queue names per suite (tests never share queues). Max 80 chars including ".fifo". */
export function uniqueQueueEnv(prefix: string): Record<string, string> {
  const suffix = `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  return {
    SQS_INPUT_QUEUE: `${suffix}-in.fifo`,
    SQS_DLQ: `${suffix}-dlq.fifo`,
    SQS_EVENTS_QUEUE: `${suffix}-ev.fifo`,
  };
}

/** Environment for a container/process pointing at the test infrastructure. */
export function testEnv(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    NODE_ENV: 'test',
    DATABASE_URL: TEST_DATABASE_URL,
    AWS_ENDPOINT_URL: TEST_AWS_ENDPOINT,
    AWS_REGION: 'us-east-1',
    AWS_ACCESS_KEY_ID: 'test',
    AWS_SECRET_ACCESS_KEY: 'test',
    LOG_LEVEL: process.env.TEST_LOG_LEVEL ?? 'silent',
    DB_POOL_MAX: '30',
    SQS_WAIT_TIME_SECONDS: '1',
    SQS_VISIBILITY_TIMEOUT_SECONDS: '5',
    SQS_RETRY_BASE_SECONDS: '1',
    SQS_RETRY_MAX_SECONDS: '2',
    SQS_MAX_ATTEMPTS: '3',
    OUTBOX_POLL_INTERVAL_MS: '100',
    OUTBOX_LEASE_MS: '2000',
    OUTBOX_RETRY_BASE_MS: '200',
    OUTBOX_RETRY_MAX_MS: '1000',
    PENDING_REF_POLL_INTERVAL_MS: '100',
    PENDING_REF_BASE_DELAY_MS: '200',
    PENDING_REF_MAX_DELAY_MS: '500',
    PENDING_REF_MAX_ATTEMPTS: '5',
    SHUTDOWN_GRACE_MS: '5000',
    ...overrides,
  };
}

export function testConfig(overrides: Record<string, string> = {}): AppConfig {
  return loadConfig(testEnv(overrides));
}

/** Drops and recreates the schema through the real migrations (also exercises them). */
export async function resetDatabase(): Promise<void> {
  const orm = await MikroORM.init(buildOrmConfig({ databaseUrl: TEST_DATABASE_URL, dbPoolMax: 2 }));
  try {
    const knex = orm.em.getKnex();
    await knex.raw('DROP SCHEMA IF EXISTS public CASCADE');
    await knex.raw('CREATE SCHEMA public');
    await orm.getMigrator().up();
  } finally {
    await orm.close(true);
  }
}

export async function createTestContainer(
  overrides: Record<string, string> = {},
  options: ContainerOptions = {},
): Promise<Container> {
  return Container.create(testConfig(overrides), options);
}

export function sql(container: Container): SqlExecutor {
  return container.baseUow.executor();
}

export interface TestHttpApp {
  app: INestApplication;
  baseUrl: string;
  close(): Promise<void>;
}

export async function startHttp(container: Container): Promise<TestHttpApp> {
  const app = await createHttpApp(container, 'all');
  await app.listen(0, '127.0.0.1');
  const address = app.getHttpServer().address() as { port: number };
  return { app, baseUrl: `http://127.0.0.1:${address.port}`, close: () => app.close() };
}

// ---------------------------------------------------------------- domain helpers

let sequence = 0;

export function uniqueId(prefix = 'tx'): string {
  return `${prefix}-${Date.now().toString(36)}-${++sequence}-${Math.random().toString(36).slice(2, 8)}`;
}

export async function openWallet(container: Container, amount = "100.00", playerId: string = randomUUID()) {
  return container.openWallet.execute({
    playerId,
    initialBalance: { amount, currency: 'BRL' },
    correlationId: randomUUID(),
  });
}

export interface WagerRequest {
  idempotencyKey: string;
  payload: WagerPayload;
}

export function wager(
  wallet: { id: string; playerId: string },
  kind: string,
  amount: string,
  overrides: Partial<WagerPayload> = {},
): WagerRequest {
  const providerId = overrides.providerId ?? 'provider-a';
  const externalTransactionId = overrides.externalTransactionId ?? uniqueId();
  return {
    idempotencyKey: `${providerId}:${externalTransactionId}`,
    payload: {
      providerId,
      externalTransactionId,
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: 'round-1',
      gameId: 'fortune-chimp',
      kind,
      money: { amount, currency: 'BRL' },
      ...overrides,
    },
  };
}

export async function submit(container: Container, request: WagerRequest, extra: Partial<WagerSubmission> = {}) {
  const outcome = await container.processWager.execute({
    idempotencyKey: request.idempotencyKey,
    payload: request.payload,
    source: 'http',
    correlationId: randomUUID(),
    ...extra,
  });
  if (outcome.type !== 'completed') throw new Error('expected a completed outcome');
  return outcome.result;
}

/** Invariant checked at the end of every integration/concurrency test. */
export async function expectWalletConsistent(container: Container, walletId: string) {
  const report = await container.reconcileWallet.execute(walletId);
  expect(report.checks).toEqual({
    balanceMatchesLedgerSum: true,
    balanceMatchesLastEntry: true,
    ledgerChainIntact: true,
    versionMatchesMovements: true,
  });
  expect(report.consistent).toBe(true);
  expect(report.difference.amount).toBe('0.00');
  return report;
}

export async function expectAllWalletsConsistent(container: Container) {
  const ids = await container.uow.read((r) => r.wallets.listIds(100_000));
  for (const id of ids) await expectWalletConsistent(container, id);
  return ids.length;
}

export async function ledgerCount(container: Container, walletId: string, direction?: 'DEBIT' | 'CREDIT') {
  const row = await sql(container).one<{ count: number }>(
    `SELECT count(*)::int AS count FROM wallet_ledger_entries WHERE wallet_id = ? ${direction ? 'AND direction = ?' : ''}`,
    direction ? [walletId, direction] : [walletId],
  );
  return row?.count ?? 0;
}

// ---------------------------------------------------------------- async helpers

export async function waitFor<T>(
  probe: () => Promise<T | undefined | null | false>,
  { timeoutMs = 20_000, intervalMs = 100, description = 'condition' } = {},
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const value = await probe();
      if (value !== undefined && value !== null && value !== false) return value;
    } catch (err) {
      lastError = err;
    }
    await Bun.sleep(intervalMs);
  }
  throw new Error(`timed out waiting for ${description}${lastError ? `: ${String(lastError)}` : ''}`);
}

// ---------------------------------------------------------------- SQS helpers

export function wagerMessage(request: WagerRequest, messageId: string = randomUUID()) {
  return {
    messageId,
    type: WAGER_TRANSACTION_REQUESTED,
    occurredAt: new Date().toISOString(),
    data: { ...request.payload, idempotencyKey: request.idempotencyKey },
  };
}

export async function sendRaw(
  sqs: SQSClient,
  queueUrl: string,
  body: string,
  groupId: string,
  deduplicationId = randomUUID(),
): Promise<void> {
  await sqs.send(
    new SendMessageCommand({ QueueUrl: queueUrl, MessageBody: body, MessageGroupId: groupId, MessageDeduplicationId: deduplicationId }),
  );
}

export async function sendWagerMessage(container: Container, message: ReturnType<typeof wagerMessage>): Promise<void> {
  // A fresh deduplication id per send: we want SQS to deliver duplicates so the INBOX is what dedupes.
  await sendRaw(container.sqs, container.queues.input, JSON.stringify(message), message.data.walletId);
}

/**
 * Drains a queue: receives and DELETES everything that arrives within `waitMs`.
 * (Deleting is required on FIFO queues: an in-flight message blocks the rest of its group.)
 */
export async function receiveAll(sqs: SQSClient, queueUrl: string, { waitMs = 3000, max = 1000 } = {}): Promise<Message[]> {
  const collected: Message[] = [];
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline && collected.length < max) {
    const result = await sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: queueUrl,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: 1,
        VisibilityTimeout: 60,
        AttributeNames: ['All'],
        MessageAttributeNames: ['All'],
      }),
    );
    const messages = result.Messages ?? [];
    collected.push(...messages);
    for (const m of messages) {
      await sqs.send(new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: m.ReceiptHandle }));
    }
  }
  return collected;
}

export async function purge(sqs: SQSClient, queueUrl: string): Promise<void> {
  try {
    await sqs.send(new PurgeQueueCommand({ QueueUrl: queueUrl }));
  } catch {
    // purge is best-effort (rate limited on AWS; fine on LocalStack)
  }
}

// ---------------------------------------------------------------- multi-process helpers

export interface ServiceProcess {
  port: number;
  baseUrl: string;
  proc: ReturnType<typeof Bun.spawn>;
  stop(signal?: NodeJS.Signals | number): Promise<number | null>;
}

/** Spawns a real, independent instance of the service (`bun src/main.ts`). */
export async function startServiceProcess(env: Record<string, string>, port: number): Promise<ServiceProcess> {
  const proc = Bun.spawn(['bun', 'src/main.ts'], {
    cwd: PROJECT_ROOT,
    env: { ...process.env, ...testEnv(env), PORT: String(port), INSTANCE_ID: `test-instance-${port}` },
    stdout: process.env.TEST_LOG_LEVEL ? 'inherit' : 'ignore',
    stderr: 'inherit',
  });
  const baseUrl = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 60_000;
  for (;;) {
    // Fail fast if the process died during startup instead of waiting for the whole timeout.
    if (proc.exitCode !== null) throw new Error(`process on port ${port} exited during startup with ${proc.exitCode}`);
    const ready = await fetch(`${baseUrl}/health/ready`)
      .then((r) => r.ok)
      .catch(() => false);
    if (ready) break;
    if (Date.now() > deadline) {
      proc.kill('SIGKILL');
      throw new Error(`instance on port ${port} did not become ready within 60s`);
    }
    await Bun.sleep(250);
  }
  return {
    port,
    baseUrl,
    proc,
    async stop(signal: NodeJS.Signals | number = 'SIGTERM') {
      if (proc.exitCode === null) proc.kill(signal);
      return proc.exited;
    },
  };
}

export async function postJson(baseUrl: string, path: string, body: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, headers: res.headers, body: text ? (JSON.parse(text) as Record<string, unknown>) : {} };
}

export async function getJson(baseUrl: string, path: string) {
  const res = await fetch(`${baseUrl}${path}`);
  const text = await res.text();
  return { status: res.status, body: text ? (JSON.parse(text) as Record<string, unknown>) : {} };
}

export async function httpWager(baseUrl: string, request: WagerRequest) {
  return postJson(baseUrl, '/wagering/transactions', request.payload, { 'Idempotency-Key': request.idempotencyKey });
}
