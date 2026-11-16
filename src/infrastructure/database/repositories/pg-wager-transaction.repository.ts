import { Money } from '../../../shared/domain/money';
import type { WagerTransactionRepository } from '../../../wagering/application/ports';
import type { FailureCode } from '../../../wagering/domain/failure-code';
import { WagerTransaction } from '../../../wagering/domain/wager-transaction';
import type { WagerTransactionKind } from '../../../wagering/domain/wager-transaction-kind';
import type { WagerTransactionStatus } from '../../../wagering/domain/wager-transaction-status';
import { type SqlExecutor, toDate, toOptionalDate } from '../sql-executor';

interface WagerTransactionRow {
  id: string;
  provider_id: string;
  external_transaction_id: string;
  idempotency_key: string;
  payload_hash: string;
  wallet_id: string;
  player_id: string;
  round_id: string;
  game_id: string;
  kind: string;
  amount: string;
  currency: string;
  reference_external_transaction_id: string | null;
  reference_transaction_id: string | null;
  status: string;
  failure_code: string | null;
  result_balance_amount: string | null;
  result_balance_currency: string | null;
  reference_attempts: number;
  next_attempt_at: Date | null;
  created_at: Date;
  updated_at: Date;
  processed_at: Date | null;
}

const COLUMNS = `id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id,
  round_id, game_id, kind, amount::text AS amount, currency, reference_external_transaction_id,
  reference_transaction_id, status, failure_code, result_balance_amount::text AS result_balance_amount,
  result_balance_currency, reference_attempts, next_attempt_at, created_at, updated_at, processed_at`;

function toDomain(row: WagerTransactionRow): WagerTransaction {
  return WagerTransaction.rehydrate({
    id: row.id,
    providerId: row.provider_id,
    externalTransactionId: row.external_transaction_id,
    idempotencyKey: row.idempotency_key,
    payloadHash: row.payload_hash,
    walletId: row.wallet_id,
    playerId: row.player_id,
    roundId: row.round_id,
    gameId: row.game_id,
    kind: row.kind as WagerTransactionKind,
    money: Money.rehydrate(row.amount, row.currency),
    referenceExternalTransactionId: row.reference_external_transaction_id ?? undefined,
    referenceTransactionId: row.reference_transaction_id ?? undefined,
    status: row.status as WagerTransactionStatus,
    failureCode: (row.failure_code ?? undefined) as FailureCode | undefined,
    // The observed balance is in the WALLET currency, which may differ from the request (CURRENCY_MISMATCH).
    resultBalance:
      row.result_balance_amount !== null && row.result_balance_currency !== null
        ? Money.rehydrate(row.result_balance_amount, row.result_balance_currency)
        : undefined,
    referenceAttempts: row.reference_attempts,
    nextAttemptAt: toOptionalDate(row.next_attempt_at),
    createdAt: toDate(row.created_at),
    updatedAt: toDate(row.updated_at),
    processedAt: toOptionalDate(row.processed_at),
  });
}

export class PgWagerTransactionRepository implements WagerTransactionRepository {
  constructor(private readonly sql: SqlExecutor) {}

  async insertIfAbsent(tx: WagerTransaction): Promise<boolean> {
    // No conflict target: covers uq_wager_tx_idempotency_key AND uq_wager_tx_provider_external.
    // A concurrent insert of the same key blocks on the unique index until the first commits.
    const rows = await this.sql.query<{ id: string }>(
      `INSERT INTO wager_transactions (
         id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id,
         round_id, game_id, kind, amount, currency, reference_external_transaction_id, reference_transaction_id,
         status, failure_code, result_balance_amount, result_balance_currency, reference_attempts, next_attempt_at,
         created_at, updated_at, processed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?::numeric, ?, ?, ?, ?, ?, ?::numeric, ?, ?, ?, ?, ?, ?)
       ON CONFLICT DO NOTHING
       RETURNING id`,
      [
        tx.id,
        tx.providerId,
        tx.externalTransactionId,
        tx.idempotencyKey,
        tx.payloadHash,
        tx.walletId,
        tx.playerId,
        tx.roundId,
        tx.gameId,
        tx.kind,
        tx.money.amount,
        tx.money.currency,
        tx.referenceExternalTransactionId,
        tx.referenceTransactionId,
        tx.status,
        tx.failureCode,
        tx.resultBalance?.amount,
        tx.resultBalance?.currency,
        tx.referenceAttempts,
        tx.nextAttemptAt,
        tx.createdAt,
        tx.updatedAt,
        tx.processedAt,
      ],
    );
    return rows.length === 1;
  }

  async save(tx: WagerTransaction): Promise<void> {
    await this.sql.execute(
      `UPDATE wager_transactions SET
         status = ?, reference_transaction_id = ?, failure_code = ?, result_balance_amount = ?::numeric,
         result_balance_currency = ?, reference_attempts = ?, next_attempt_at = ?, processed_at = ?, updated_at = ?
       WHERE id = ?`,
      [
        tx.status,
        tx.referenceTransactionId,
        tx.failureCode,
        tx.resultBalance?.amount,
        tx.resultBalance?.currency,
        tx.referenceAttempts,
        tx.nextAttemptAt,
        tx.processedAt,
        tx.updatedAt,
        tx.id,
      ],
    );
  }

  async findById(id: string): Promise<WagerTransaction | undefined> {
    const row = await this.sql.one<WagerTransactionRow>(`SELECT ${COLUMNS} FROM wager_transactions WHERE id = ?`, [id]);
    return row ? toDomain(row) : undefined;
  }

  async findByIdempotencyKey(key: string): Promise<WagerTransaction | undefined> {
    const row = await this.sql.one<WagerTransactionRow>(
      `SELECT ${COLUMNS} FROM wager_transactions WHERE idempotency_key = ?`,
      [key],
    );
    return row ? toDomain(row) : undefined;
  }

  async findByExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction | undefined> {
    const row = await this.sql.one<WagerTransactionRow>(
      `SELECT ${COLUMNS} FROM wager_transactions WHERE provider_id = ? AND external_transaction_id = ?`,
      [providerId, externalTransactionId],
    );
    return row ? toDomain(row) : undefined;
  }

  async hasProcessedReversal(referenceTransactionId: string): Promise<boolean> {
    const row = await this.sql.one<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM wager_transactions
         WHERE reference_transaction_id = ? AND status = 'PROCESSED' AND kind IN ('REFUND','ROLLBACK')
       ) AS exists`,
      [referenceTransactionId],
    );
    return row?.exists === true;
  }

  async findDuePendingReferences(limit: number): Promise<string[]> {
    const rows = await this.sql.query<{ id: string }>(
      `SELECT id FROM wager_transactions
       WHERE status = 'PENDING_REFERENCE' AND next_attempt_at <= now()
       ORDER BY next_attempt_at
       LIMIT ?`,
      [limit],
    );
    return rows.map((r) => r.id);
  }

  async expediteDependents(walletId: string, providerId: string, externalTransactionId: string, now: Date): Promise<number> {
    return this.sql.execute(
      `UPDATE wager_transactions SET next_attempt_at = ?
       WHERE status = 'PENDING_REFERENCE' AND wallet_id = ? AND provider_id = ?
         AND reference_external_transaction_id = ? AND next_attempt_at > ?`,
      [now, walletId, providerId, externalTransactionId, now],
    );
  }

  async countByWallet(walletId: string): Promise<Record<string, number>> {
    const rows = await this.sql.query<{ status: string; count: number }>(
      `SELECT status, count(*)::int AS count FROM wager_transactions WHERE wallet_id = ? GROUP BY status`,
      [walletId],
    );
    return Object.fromEntries(rows.map((r) => [r.status, r.count]));
  }
}
