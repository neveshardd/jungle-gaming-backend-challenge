/**
 * Load test — `bun run test:load`
 *
 * Target: the docker compose stack (3 replicas behind nginx on :8080) or any BASE_URL.
 * Workload (closed model, CONCURRENCY virtual users for DURATION_S seconds):
 *   - 60% BET / 15% WIN / 10% LOSS on "cold" wallets (one of WALLETS)
 *   -  5% REFUND or ROLLBACK of a previously processed BET (exercises reference lookup)
 *   - 20% BET on a single HOT wallet (lock contention)
 *   - every request has DUPLICATE_RATIO chance of being re-sent once with the same key
 * Afterwards: waits for the outbox to drain, reconciles every wallet and prints a report
 * (throughput, p50/p95/p99, error rate by class, lock conflicts, outbox lag).
 *
 * Env: BASE_URL, DATABASE_URL, DURATION_S, CONCURRENCY, WALLETS, DUPLICATE_RATIO
 */
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { cpus, totalmem } from 'node:os';
import { resolve } from 'node:path';
import { MikroORM } from '@mikro-orm/postgresql';
import { buildOrmConfig } from '../../src/infrastructure/database/mikro-orm.config';
import { SqlExecutor } from '../../src/infrastructure/database/sql-executor';

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:8080';
const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://wagering:wagering@localhost:5432/wagering';
const DURATION_S = Number.parseInt(process.env.DURATION_S ?? '60', 10);
const CONCURRENCY = Number.parseInt(process.env.CONCURRENCY ?? '50', 10);
const WALLETS = Number.parseInt(process.env.WALLETS ?? '200', 10);
const DUPLICATE_RATIO = Number.parseFloat(process.env.DUPLICATE_RATIO ?? '0.1');

interface Wallet {
  id: string;
  playerId: string;
  bets: string[];
}

type Outcome = 'processed' | 'replay' | 'pending' | 'rejected' | 'conflict' | 'client_error' | 'transient' | 'server_error' | 'network';

const latencies: number[] = [];
const hotLatencies: number[] = [];
const coldLatencies: number[] = [];
let hotWalletId = '';

function summary(samples: number[]) {
  const s = [...samples].sort((a, b) => a - b);
  return { count: s.length, p50: percentile(s, 50), p95: percentile(s, 95), p99: percentile(s, 99), max: s[s.length - 1] ?? 0 };
}
const outcomes = new Map<Outcome, number>();
const failureCodes = new Map<string, number>();
let requests = 0;

function classify(status: number): Outcome {
  if (status === 201) return 'processed';
  if (status === 200) return 'replay';
  if (status === 202) return 'pending';
  if (status === 422) return 'rejected';
  if (status === 409) return 'conflict';
  if (status === 503) return 'transient';
  if (status >= 500) return 'server_error';
  return 'client_error';
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, index)] ?? 0;
}

async function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  const started = performance.now();
  try {
    const res = await fetch(`${BASE_URL}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    return { status: res.status, body: json, ms: performance.now() - started };
  } catch {
    return { status: 0, body: {}, ms: performance.now() - started };
  }
}

async function createWallet(amount: string): Promise<Wallet> {
  const res = await post('/wallets', { playerId: randomUUID(), initialBalance: { amount, currency: 'BRL' } });
  if (res.status !== 201) throw new Error(`wallet creation failed with ${res.status}`);
  return { id: res.body.id as string, playerId: res.body.playerId as string, bets: [] };
}

function payload(wallet: Wallet, kind: string, amount: string, reference?: string) {
  const externalTransactionId = randomUUID();
  return {
    key: `load:${externalTransactionId}`,
    body: {
      providerId: 'load',
      externalTransactionId,
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: 'load-round',
      gameId: 'load-game',
      kind,
      money: { amount, currency: 'BRL' },
      ...(reference ? { referenceExternalTransactionId: reference } : {}),
    },
  };
}

async function send(request: { key: string; body: Record<string, unknown> }) {
  const res = await post('/wagering/transactions', request.body, { 'Idempotency-Key': request.key });
  requests++;
  latencies.push(res.ms);
  (request.body.walletId === hotWalletId ? hotLatencies : coldLatencies).push(res.ms);
  const outcome = res.status === 0 ? 'network' : classify(res.status);
  outcomes.set(outcome, (outcomes.get(outcome) ?? 0) + 1);
  if (typeof res.body.failureCode === 'string') failureCodes.set(res.body.failureCode, (failureCodes.get(res.body.failureCode) ?? 0) + 1);
  return res;
}

function pickOperation(wallets: Wallet[], hot: Wallet) {
  const r = Math.random();
  if (r < 0.2) return payload(hot, 'BET', '0.01');
  const wallet = wallets[Math.floor(Math.random() * wallets.length)]!;
  if (r < 0.8) return payload(wallet, 'BET', '1.00');
  if (r < 0.95) return payload(wallet, Math.random() < 0.6 ? 'WIN' : 'LOSS', '1.50');
  const reference = wallet.bets.pop();
  if (!reference) return payload(wallet, 'BET', '1.00');
  return payload(wallet, Math.random() < 0.5 ? 'REFUND' : 'ROLLBACK', '1.00', reference);
}

async function scrapeLockConflicts(): Promise<number> {
  // Scrape through the LB many times to see every replica; keep the latest value per instance.
  const perInstance = new Map<string, number>();
  for (let i = 0; i < 30; i++) {
    const text = await fetch(`${BASE_URL}/metrics`).then((r) => r.text()).catch(() => '');
    const byInstance = new Map<string, number>();
    for (const line of text.split('\n')) {
      if (!line.startsWith('wagering_lock_conflicts_total')) continue;
      const instance = /instance="([^"]+)"/.exec(line)?.[1] ?? 'unknown';
      byInstance.set(instance, (byInstance.get(instance) ?? 0) + Number.parseFloat(line.split(' ').pop() ?? '0'));
    }
    for (const [k, v] of byInstance) perInstance.set(k, v);
  }
  return [...perInstance.values()].reduce((a, b) => a + b, 0);
}

async function main() {
  console.log(`load test against ${BASE_URL}: ${CONCURRENCY} VUs, ${DURATION_S}s, ${WALLETS} wallets`);
  const orm = await MikroORM.init(buildOrmConfig({ databaseUrl: DATABASE_URL, dbPoolMax: 2 }));
  const db = new SqlExecutor(orm.em.getKnex());

  const wallets: Wallet[] = [];
  for (let i = 0; i < WALLETS; i += 20) {
    wallets.push(...(await Promise.all(Array.from({ length: Math.min(20, WALLETS - i) }, () => createWallet('10000.00')))));
  }
  const hot = await createWallet('1000000.00');
  hotWalletId = hot.id;
  const lockConflictsBefore = await scrapeLockConflicts();

  let maxOutboxLag = 0;
  let maxOutboxPending = 0;
  const lagSampler = setInterval(async () => {
    const row = await db.one<{ pending: number; lag: number }>(
      `SELECT count(*)::int AS pending, COALESCE(EXTRACT(EPOCH FROM now() - min(occurred_at)), 0)::float8 AS lag
       FROM outbox_messages WHERE published_at IS NULL`,
    );
    maxOutboxLag = Math.max(maxOutboxLag, row?.lag ?? 0);
    maxOutboxPending = Math.max(maxOutboxPending, row?.pending ?? 0);
  }, 1000);

  const startedAt = new Date();
  const deadline = Date.now() + DURATION_S * 1000;
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      while (Date.now() < deadline) {
        const request = pickOperation(wallets, hot);
        const res = await send(request);
        if (request.body.kind === 'BET' && res.status === 201 && request.body.walletId !== hot.id) {
          wallets.find((w) => w.id === request.body.walletId)?.bets.push(request.body.externalTransactionId as string);
        }
        if (Math.random() < DUPLICATE_RATIO) await send(request);
      }
    }),
  );
  const elapsedS = (Date.now() - startedAt.getTime()) / 1000;
  clearInterval(lagSampler);

  // Drain: time until every event created during the run is published.
  const drainStarted = Date.now();
  for (;;) {
    const row = await db.one<{ n: number }>(`SELECT count(*)::int AS n FROM outbox_messages WHERE published_at IS NULL`);
    if ((row?.n ?? 0) === 0 || Date.now() - drainStarted > 120_000) break;
    await Bun.sleep(500);
  }
  const drainS = (Date.now() - drainStarted) / 1000;
  const publishLatency = await db.one<{ p50: number; p95: number; p99: number; max: number }>(
    `SELECT percentile_cont(0.50) WITHIN GROUP (ORDER BY ms) AS p50,
            percentile_cont(0.95) WITHIN GROUP (ORDER BY ms) AS p95,
            percentile_cont(0.99) WITHIN GROUP (ORDER BY ms) AS p99,
            max(ms) AS max
     FROM (SELECT EXTRACT(EPOCH FROM published_at - occurred_at) * 1000 AS ms
           FROM outbox_messages WHERE published_at IS NOT NULL AND occurred_at >= ?) t`,
    [startedAt],
  );

  // Reconcile every wallet through the API.
  let inconsistent = 0;
  for (const w of [...wallets, hot]) {
    const res = await post(`/wallets/${w.id}/reconciliation`, {});
    if (res.body.consistent !== true) inconsistent++;
  }
  const lockConflicts = (await scrapeLockConflicts()) - lockConflictsBefore;
  await orm.close(true);

  const sorted = [...latencies].sort((a, b) => a - b);
  const errorCount = (outcomes.get('server_error') ?? 0) + (outcomes.get('network') ?? 0) + (outcomes.get('transient') ?? 0);
  const report = {
    environment: {
      baseUrl: BASE_URL,
      cpus: cpus().length,
      cpuModel: cpus()[0]?.model,
      memoryGb: Math.round(totalmem() / 1024 ** 3),
      platform: process.platform,
      bun: Bun.version,
    },
    parameters: { durationS: DURATION_S, concurrency: CONCURRENCY, wallets: WALLETS, duplicateRatio: DUPLICATE_RATIO },
    results: {
      requests,
      elapsedS,
      throughputRps: Math.round((requests / elapsedS) * 10) / 10,
      latencyMs: {
        p50: percentile(sorted, 50),
        p95: percentile(sorted, 95),
        p99: percentile(sorted, 99),
        max: sorted[sorted.length - 1] ?? 0,
      },
      latencyByWalletMs: { hot: summary(hotLatencies), cold: summary(coldLatencies) },
      outcomes: Object.fromEntries(outcomes),
      failureCodes: Object.fromEntries(failureCodes),
      errorRate: requests ? errorCount / requests : 0,
      lockConflicts,
      outbox: {
        maxPendingDuringRun: maxOutboxPending,
        maxLagSecondsDuringRun: maxOutboxLag,
        drainSecondsAfterRun: drainS,
        publishLatencyMs: publishLatency,
      },
      reconciliation: { walletsChecked: wallets.length + 1, inconsistent },
    },
  };

  const dir = resolve(import.meta.dir, 'results');
  mkdirSync(dir, { recursive: true });
  const file = resolve(dir, `load-${startedAt.toISOString().replace(/[:.]/g, '-')}.json`);
  writeFileSync(file, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  console.log(`report written to ${file}`);
  if (inconsistent > 0) process.exit(1);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
