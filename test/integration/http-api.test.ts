import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { Container } from '../../src/bootstrap/container';
import {
  createTestContainer,
  expectAllWalletsConsistent,
  getJson,
  httpWager,
  postJson,
  resetDatabase,
  startHttp,
  type TestHttpApp,
  uniqueQueueEnv,
  wager,
} from '../support/harness';

let container: Container;
let http: TestHttpApp;

beforeAll(async () => {
  await resetDatabase();
  container = await createTestContainer(uniqueQueueEnv('http'));
  http = await startHttp(container);
});

afterAll(async () => {
  await expectAllWalletsConsistent(container);
  await http.close();
  await container.close();
});

async function createWallet(amount = '1000.00', playerId = randomUUID()) {
  const res = await postJson(http.baseUrl, '/wallets', { playerId, initialBalance: { amount, currency: 'BRL' } });
  expect(res.status).toBe(201);
  return res.body as { id: string; playerId: string; balance: { amount: string }; version: number };
}

describe('POST /wallets', () => {
  it('201 with version 1 and the opening balance', async () => {
    const playerId = randomUUID();
    const res = await postJson(http.baseUrl, '/wallets', { playerId, initialBalance: { amount: '1000.00', currency: 'BRL' } });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ playerId, balance: { amount: '1000.00', currency: 'BRL' }, version: 1 });
    expect(res.headers.get('x-correlation-id')).toBeString();
  });

  it('409 for a duplicate player + currency', async () => {
    const wallet = await createWallet();
    const res = await postJson(http.baseUrl, '/wallets', {
      playerId: wallet.playerId,
      initialBalance: { amount: '1.00', currency: 'BRL' },
    });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('WALLET_ALREADY_EXISTS');
  });

  it('400 for invalid money / payload / JSON', async () => {
    const bad = await postJson(http.baseUrl, '/wallets', { playerId: 'p', initialBalance: { amount: 10, currency: 'BRL' } });
    expect(bad.status).toBe(400);
    const sci = await postJson(http.baseUrl, '/wallets', { playerId: 'p', initialBalance: { amount: '1e3', currency: 'BRL' } });
    expect(sci.status).toBe(400);
    expect(sci.body.code).toBe('INVALID_MONEY');
    const res = await fetch(`${http.baseUrl}/wallets`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not json',
    });
    expect(res.status).toBe(400);
  });
});

describe('POST /wagering/transactions', () => {
  it('201 processed, 200 replay with the original balance, 409 conflict', async () => {
    const wallet = await createWallet();
    const bet = wager(wallet, 'BET', '25.00');
    const first = await httpWager(http.baseUrl, bet);
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({ status: 'PROCESSED', balance: { amount: '975.00', currency: 'BRL' }, idempotentReplay: false });

    await httpWager(http.baseUrl, wager(wallet, 'BET', '5.00'));
    const replay = await httpWager(http.baseUrl, bet);
    expect(replay.status).toBe(200);
    expect(replay.body).toEqual({ ...first.body, idempotentReplay: true });

    const conflict = await postJson(
      http.baseUrl,
      '/wagering/transactions',
      { ...bet.payload, money: { amount: '26.00', currency: 'BRL' } },
      { 'Idempotency-Key': bet.idempotencyKey },
    );
    expect(conflict.status).toBe(409);
    expect(conflict.body.code).toBe('IDEMPOTENCY_CONFLICT');
  });

  it('extra fields and header do not change the hash (replay, not conflict)', async () => {
    const wallet = await createWallet();
    const bet = wager(wallet, 'BET', '1.00');
    await httpWager(http.baseUrl, bet);
    const res = await postJson(
      http.baseUrl,
      '/wagering/transactions',
      { ...bet.payload, transportNoise: 'x' },
      { 'Idempotency-Key': bet.idempotencyKey, 'X-Correlation-Id': 'another' },
    );
    expect(res.status).toBe(200);
    expect(res.body.idempotentReplay).toBe(true);
  });

  it('422 business rejection with failureCode; replay repeats 422', async () => {
    const wallet = await createWallet('10.00');
    const bet = wager(wallet, 'BET', '50.00');
    const res = await httpWager(http.baseUrl, bet);
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ status: 'REJECTED', failureCode: 'INSUFFICIENT_FUNDS', balance: { amount: '10.00' } });
    const replay = await httpWager(http.baseUrl, bet);
    expect(replay.status).toBe(422);
    expect(replay.body.idempotentReplay).toBe(true);
  });

  it('202 when the reference has not arrived yet', async () => {
    const wallet = await createWallet();
    const res = await httpWager(http.baseUrl, wager(wallet, 'REFUND', '10.00', { referenceExternalTransactionId: 'future-bet' }));
    expect(res.status).toBe(202);
    expect(res.body.status).toBe('PENDING_REFERENCE');
  });

  it('400 for missing Idempotency-Key, invalid payload, OPENING; 404 unknown wallet', async () => {
    const wallet = await createWallet();
    const bet = wager(wallet, 'BET', '1.00');
    const noKey = await postJson(http.baseUrl, '/wagering/transactions', bet.payload);
    expect(noKey.status).toBe(400);
    expect(noKey.body.code).toBe('IDEMPOTENCY_KEY_REQUIRED');

    const invalid = await postJson(http.baseUrl, '/wagering/transactions', { ...bet.payload, walletId: 'nope' }, {
      'Idempotency-Key': 'k-1',
    });
    expect(invalid.status).toBe(400);
    expect(invalid.body.code).toBe('VALIDATION_ERROR');

    const opening = await httpWager(http.baseUrl, wager(wallet, 'OPENING', '1.00'));
    expect(opening.status).toBe(400);
    expect(opening.body.code).toBe('KIND_NOT_ALLOWED');

    const tooPrecise = await httpWager(http.baseUrl, wager(wallet, 'BET', '1.005'));
    expect(tooPrecise.status).toBe(400);
    expect(tooPrecise.body.code).toBe('INVALID_MONEY');

    const unknown = await httpWager(http.baseUrl, wager({ id: randomUUID(), playerId: 'x' }, 'BET', '1.00'));
    expect(unknown.status).toBe(404);
    expect(unknown.body.code).toBe('WALLET_NOT_FOUND');
  });
});

describe('queries', () => {
  it('GET wallet, transaction by id and by provider external id, ledger with cursor', async () => {
    const wallet = await createWallet('100.00');
    const bet = wager(wallet, 'BET', '10.00');
    const created = await httpWager(http.baseUrl, bet);
    const txId = created.body.transactionId as string;

    const w = await getJson(http.baseUrl, `/wallets/${wallet.id}`);
    expect(w.status).toBe(200);
    expect(w.body).toMatchObject({ id: wallet.id, balance: { amount: '90.00', currency: 'BRL' }, version: 2 });

    const byId = await getJson(http.baseUrl, `/wagering/transactions/${txId}`);
    expect(byId.body).toMatchObject({ id: txId, status: 'PROCESSED', kind: 'BET', money: { amount: '10.00' } });

    const byExternal = await getJson(
      http.baseUrl,
      `/providers/${bet.payload.providerId}/wagering/transactions/${bet.payload.externalTransactionId}`,
    );
    expect(byExternal.body.id).toBe(txId);

    const page1 = await getJson(http.baseUrl, `/wallets/${wallet.id}/ledger?limit=1`);
    expect((page1.body.entries as unknown[]).length).toBe(1);
    const cursor = page1.body.nextCursor as string;
    expect(cursor).toBeString();
    const page2 = await getJson(http.baseUrl, `/wallets/${wallet.id}/ledger?limit=1&cursor=${encodeURIComponent(cursor)}`);
    expect((page2.body.entries as Array<{ direction: string }>)[0]?.direction).toBe('DEBIT');
    expect(page2.body.nextCursor).toBeNull();

    expect((await getJson(http.baseUrl, `/wallets/${wallet.id}/ledger?cursor=garbage`)).status).toBe(400);
    expect((await getJson(http.baseUrl, `/wallets/${randomUUID()}`)).status).toBe(404);
    expect((await getJson(http.baseUrl, `/wagering/transactions/${randomUUID()}`)).status).toBe(404);
  });

  it('POST /wallets/:id/reconciliation', async () => {
    const wallet = await createWallet('1000.00');
    await httpWager(http.baseUrl, wager(wallet, 'BET', '25.00'));
    const res = await postJson(http.baseUrl, `/wallets/${wallet.id}/reconciliation`, {});
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      walletId: wallet.id,
      storedBalance: { amount: '975.00', currency: 'BRL' },
      calculatedBalance: { amount: '975.00', currency: 'BRL' },
      difference: { amount: '0.00', currency: 'BRL' },
      consistent: true,
      checkedEntries: 2,
    });
  });
});

describe('OpenAPI / Swagger', () => {
  it('serves the Swagger UI at /docs and the OpenAPI document at /docs-json', async () => {
    const ui = await fetch(`${http.baseUrl}/docs`);
    expect(ui.status).toBe(200);
    expect(await ui.text()).toContain('swagger-ui');

    const spec = await getJson(http.baseUrl, '/docs-json');
    expect(spec.status).toBe(200);
    const paths = spec.body.paths as Record<string, Record<string, unknown>>;
    expect(Object.keys(paths)).toEqual(
      expect.arrayContaining([
        '/wallets',
        '/wallets/{walletId}',
        '/wallets/{walletId}/ledger',
        '/wallets/{walletId}/reconciliation',
        '/wagering/transactions',
        '/wagering/transactions/{transactionId}',
        '/providers/{providerId}/wagering/transactions/{externalTransactionId}',
        '/health/live',
        '/health/ready',
      ]),
    );
    const submit = paths['/wagering/transactions']?.post as { responses: Record<string, unknown>; parameters: Array<{ name: string }> };
    expect(Object.keys(submit.responses)).toEqual(expect.arrayContaining(['200', '201', '202', '400', '404', '409', '422', '503']));
    expect(submit.parameters.map((p) => p.name)).toContain('Idempotency-Key');
    const schemas = (spec.body.components as { schemas: Record<string, unknown> }).schemas;
    expect(Object.keys(schemas)).toEqual(expect.arrayContaining(['Money', 'WagerRequest', 'WagerResult', 'Error']));
  });
});

describe('health and metrics (no auth)', () => {
  it('liveness, readiness, metrics', async () => {
    expect((await getJson(http.baseUrl, '/health/live')).body).toEqual({ status: 'ok' });
    const ready = await getJson(http.baseUrl, '/health/ready');
    expect(ready.status).toBe(200);
    expect(ready.body.status).toBe('ok');
    const metrics = await (await fetch(`${http.baseUrl}/metrics`)).text();
    expect(metrics).toContain('wagering_transactions_total');
    expect(metrics).toContain('wagering_duplicates_detected_total');
  });
});
