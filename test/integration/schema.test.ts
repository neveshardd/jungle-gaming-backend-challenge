import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { MikroORM } from '@mikro-orm/postgresql';
import { buildOrmConfig } from '../../src/infrastructure/database/mikro-orm.config';
import { SqlExecutor } from '../../src/infrastructure/database/sql-executor';
import { resetDatabase, TEST_DATABASE_URL } from '../support/harness';

/**
 * The guarantees of section 6 are enforced by the schema itself: these tests bypass the
 * application and write SQL directly, expecting the database to refuse invalid states.
 */
let orm: MikroORM;
let db: SqlExecutor;

const HASH = 'a'.repeat(64);

async function tables(): Promise<string[]> {
  const rows = await db.query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name`,
  );
  return rows.map((r) => r.table_name);
}

async function expectRejected(fn: () => Promise<unknown>, pattern?: RegExp) {
  let error: unknown;
  try {
    await fn();
  } catch (err) {
    error = err;
  }
  expect(error).toBeDefined();
  if (pattern) expect(String((error as Error).message)).toMatch(pattern);
}

async function insertWallet(balance = '0.00', playerId = randomUUID()): Promise<string> {
  const id = randomUUID();
  await db.execute(
    `INSERT INTO wallets (id, player_id, currency, balance_amount, version, created_at, updated_at)
     VALUES (?, ?, 'BRL', ?::numeric, 1, now(), now())`,
    [id, playerId, balance],
  );
  return id;
}

async function insertTx(walletId: string, overrides: Record<string, unknown> = {}): Promise<string> {
  const row = {
    id: randomUUID(),
    external: randomUUID(),
    kind: 'BET',
    status: 'PROCESSED',
    amount: '10.00',
    reference_external: null as string | null,
    reference_id: null as string | null,
    failure_code: null as string | null,
    result_balance: '0.00' as string | null,
    processed_at: new Date() as Date | null,
    ...overrides,
  };
  await db.execute(
    `INSERT INTO wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash,
       wallet_id, player_id, round_id, game_id, kind, amount, currency, reference_external_transaction_id,
       reference_transaction_id, status, failure_code, result_balance_amount, result_balance_currency,
       reference_attempts, next_attempt_at, created_at, updated_at, processed_at)
     VALUES (?, 'p', ?, ?, ?, ?, 'player', 'r', 'g', ?, ?::numeric, 'BRL', ?, ?, ?, ?, ?::numeric,
       CASE WHEN ?::text IS NULL THEN NULL ELSE 'BRL' END, 0, NULL, now(), now(), ?)`,
    [
      row.id,
      row.external,
      `p:${row.external}`,
      HASH,
      walletId,
      row.kind,
      row.amount,
      row.reference_external,
      row.reference_id,
      row.status,
      row.failure_code,
      row.result_balance,
      row.result_balance,
      row.processed_at,
    ],
  );
  return row.id;
}

beforeAll(async () => {
  await resetDatabase();
  orm = await MikroORM.init(buildOrmConfig({ databaseUrl: TEST_DATABASE_URL, dbPoolMax: 5 }));
  db = new SqlExecutor(orm.em.getKnex());
});

afterAll(async () => {
  await orm?.close(true);
});

describe('migrations', () => {
  it('are reversible: up -> down -> up', async () => {
    const migrator = orm.getMigrator();
    expect(await tables()).toEqual(
      expect.arrayContaining(['wallets', 'wager_transactions', 'wallet_ledger_entries', 'inbox_messages', 'outbox_messages']),
    );
    await migrator.down({ to: 0 });
    expect((await tables()).filter((t) => t !== 'mikro_orm_migrations')).toEqual([]);
    await migrator.up();
    expect(await tables()).toContain('wallet_ledger_entries');
    expect(await migrator.getPendingMigrations()).toHaveLength(0);
  });
});

describe('wallet constraints', () => {
  it('one wallet per player + currency', async () => {
    const player = randomUUID();
    await insertWallet('0.00', player);
    await expectRejected(() => insertWallet('0.00', player), /uq_wallets_player_currency/);
  });

  it('balance can never be negative', async () => {
    await expectRejected(() => insertWallet('-0.01'), /ck_wallets_balance_non_negative/);
  });

  it('balance change must increment version by exactly one, and requires a ledger line at commit', async () => {
    const id = await insertWallet('0.00');
    await expectRejected(
      () => db.execute(`UPDATE wallets SET balance_amount = 5 WHERE id = ?`, [id]),
      /increment version/,
    );
    // version bumped correctly but no ledger entry: the deferred constraint trigger fails the COMMIT
    await expectRejected(
      () => db.execute(`UPDATE wallets SET balance_amount = 5, version = 2 WHERE id = ?`, [id]),
      /does not match ledger balance/,
    );
  });

  it('wallets cannot be deleted and immutable columns cannot change', async () => {
    const id = await insertWallet('0.00');
    await expectRejected(() => db.execute(`DELETE FROM wallets WHERE id = ?`, [id]), /not allowed/);
    await expectRejected(() => db.execute(`UPDATE wallets SET currency = 'USD' WHERE id = ?`, [id]), /immutable/);
  });
});

describe('transaction constraints', () => {
  it('idempotency key and (provider, external id) are unique', async () => {
    const walletId = await insertWallet('0.00');
    const external = randomUUID();
    await insertTx(walletId, { external });
    await expectRejected(() => insertTx(walletId, { external }), /uq_wager_tx_/);
  });

  it('REFUND / ROLLBACK need a reference; amounts are positive; kinds/statuses are closed sets', async () => {
    const walletId = await insertWallet('0.00');
    await expectRejected(() => insertTx(walletId, { kind: 'REFUND', status: 'PENDING', result_balance: null, processed_at: null }), /ck_wager_tx_reference_required/);
    await expectRejected(() => insertTx(walletId, { amount: '0.00' }), /ck_wager_tx_amount_positive/);
    await expectRejected(() => insertTx(walletId, { kind: 'JACKPOT' }), /ck_wager_tx_kind/);
    await expectRejected(() => insertTx(walletId, { status: 'DONE' }), /ck_wager_tx_status/);
  });

  it('REJECTED needs a failure code; PROCESSED needs processed_at and result balance', async () => {
    const walletId = await insertWallet('0.00');
    await expectRejected(() => insertTx(walletId, { status: 'REJECTED', processed_at: null }), /ck_wager_tx_failure_fields/);
    await expectRejected(() => insertTx(walletId, { processed_at: null }), /ck_wager_tx_processed_fields/);
  });

  it('terminal transactions are frozen and cannot be deleted', async () => {
    const walletId = await insertWallet('0.00');
    const id = await insertTx(walletId);
    await expectRejected(
      () => db.execute(`UPDATE wager_transactions SET status = 'REJECTED', failure_code = 'X' WHERE id = ?`, [id]),
      /terminal/,
    );
    await expectRejected(() => db.execute(`DELETE FROM wager_transactions WHERE id = ?`, [id]), /not allowed/);
  });

  it('a referenced transaction can be reversed at most once (partial unique index)', async () => {
    const walletId = await insertWallet('0.00');
    const betId = await insertTx(walletId);
    await insertTx(walletId, { kind: 'REFUND', reference_external: 'bet', reference_id: betId });
    await expectRejected(
      () => insertTx(walletId, { kind: 'ROLLBACK', reference_external: 'bet', reference_id: betId }),
      /ux_wager_tx_single_reversal/,
    );
  });
});

describe('ledger constraints', () => {
  async function ledgerInsert(walletId: string, txId: string, direction: string, amount: string, before: string, after: string) {
    await db.execute(
      `INSERT INTO wallet_ledger_entries (id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after, created_at)
       VALUES (?, ?, ?, ?, ?::numeric, 'BRL', ?::numeric, ?::numeric, now())`,
      [randomUUID(), walletId, txId, direction, amount, before, after],
    );
  }

  it('rejects unbalanced lines and negative balances', async () => {
    const walletId = await insertWallet('0.00');
    const txId = await insertTx(walletId);
    await expectRejected(() => ledgerInsert(walletId, txId, 'CREDIT', '10.00', '0.00', '9.99'), /ck_ledger_balanced/);
    await expectRejected(() => ledgerInsert(walletId, txId, 'DEBIT', '10.00', '0.00', '-10.00'), /non_negative|ck_ledger/);
  });

  it('enforces the chain and one line per transaction/wallet, and is append-only', async () => {
    const walletId = await insertWallet('0.00');
    const t1 = await insertTx(walletId, { kind: 'WIN' });
    const t2 = await insertTx(walletId, { kind: 'WIN' });
    await expectRejected(() => ledgerInsert(walletId, t1, 'CREDIT', '10.00', '5.00', '15.00'), /chain broken/);
    // Valid line, but the wallet balance was not moved with it: refused at COMMIT.
    await expectRejected(
      () => ledgerInsert(walletId, t1, 'CREDIT', '10.00', '0.00', '10.00'),
      /does not match wallet balance/,
    );

    // The wallet row must follow the ledger for the deferred trigger: do it in one transaction.
    await orm.em.getKnex().transaction(async (trx) => {
      const tx = new SqlExecutor(trx);
      await tx.execute(
        `INSERT INTO wallet_ledger_entries (id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after, created_at)
         VALUES (?, ?, ?, 'CREDIT', 10, 'BRL', 0, 10, now())`,
        [randomUUID(), walletId, t1],
      );
      await tx.execute(`UPDATE wallets SET balance_amount = 10, version = 2 WHERE id = ?`, [walletId]);
    });

    await expectRejected(() => ledgerInsert(walletId, t1, 'CREDIT', '1.00', '10.00', '11.00'), /uq_ledger_transaction_wallet/);
    await expectRejected(
      () => db.execute(`UPDATE wallet_ledger_entries SET amount = 99 WHERE wallet_id = ?`, [walletId]),
      /not allowed/,
    );
    await expectRejected(() => db.execute(`DELETE FROM wallet_ledger_entries WHERE wallet_id = ?`, [walletId]), /not allowed/);
    await expectRejected(() => db.execute(`TRUNCATE wallet_ledger_entries CASCADE`), /not allowed/);
    // t2 stays without ledger line: still valid (LOSS-like / rejected rows have none)
    expect(t2).toBeString();
  });

  it('a ledger line must point to a transaction of the same wallet', async () => {
    const w1 = await insertWallet('0.00');
    const w2 = await insertWallet('0.00');
    const txOfW2 = await insertTx(w2, { kind: 'WIN' });
    await expectRejected(() => ledgerInsert(w1, txOfW2, 'CREDIT', '10.00', '0.00', '10.00'), /fk_ledger_transaction_same_wallet/);
  });
});

describe('inbox constraints', () => {
  it('(consumer_name, message_id) is unique', async () => {
    const insert = () =>
      db.execute(`INSERT INTO inbox_messages (consumer_name, message_id, payload_hash, received_at) VALUES ('c', 'm-1', ?, now())`, [
        HASH,
      ]);
    await insert();
    await expectRejected(insert, /pk_inbox_messages/);
  });
});
