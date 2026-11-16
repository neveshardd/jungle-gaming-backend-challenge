import { TransientError } from '../../../shared/application/errors';
import { Money } from '../../../shared/domain/money';
import type { WalletRepository } from '../../../wallet/application/ports';
import { Wallet } from '../../../wallet/domain/wallet';
import { type SqlExecutor, toDate } from '../sql-executor';

interface WalletRow {
  id: string;
  player_id: string;
  currency: string;
  balance_amount: string;
  version: number;
  created_at: Date;
  updated_at: Date;
}

const COLUMNS = 'id, player_id, currency, balance_amount::text AS balance_amount, version, created_at, updated_at';

/** Mapper: numeric is always read as text and rehydrated into Money (never through `number`). */
function toDomain(row: WalletRow): Wallet {
  return Wallet.rehydrate({
    id: row.id,
    playerId: row.player_id,
    currency: row.currency,
    balance: Money.rehydrate(row.balance_amount, row.currency),
    version: row.version,
    createdAt: toDate(row.created_at),
    updatedAt: toDate(row.updated_at),
  });
}

export class PgWalletRepository implements WalletRepository {
  constructor(private readonly sql: SqlExecutor) {}

  async insertIfAbsent(wallet: Wallet): Promise<boolean> {
    const rows = await this.sql.query<{ id: string }>(
      `INSERT INTO wallets (id, player_id, currency, balance_amount, version, created_at, updated_at)
       VALUES (?, ?, ?, ?::numeric, ?, ?, ?)
       ON CONFLICT (player_id, currency) DO NOTHING
       RETURNING id`,
      [
        wallet.id,
        wallet.playerId,
        wallet.currency,
        wallet.balance.amount,
        wallet.version,
        wallet.createdAt,
        wallet.updatedAt,
      ],
    );
    return rows.length === 1;
  }

  async exists(id: string): Promise<boolean> {
    const row = await this.sql.one<{ exists: boolean }>(`SELECT EXISTS (SELECT 1 FROM wallets WHERE id = ?) AS exists`, [
      id,
    ]);
    return row?.exists === true;
  }

  async findById(id: string): Promise<Wallet | undefined> {
    const row = await this.sql.one<WalletRow>(`SELECT ${COLUMNS} FROM wallets WHERE id = ?`, [id]);
    return row ? toDomain(row) : undefined;
  }

  async lockById(id: string): Promise<Wallet | undefined> {
    const row = await this.sql.one<WalletRow>(`SELECT ${COLUMNS} FROM wallets WHERE id = ? FOR NO KEY UPDATE`, [id]);
    return row ? toDomain(row) : undefined;
  }

  async update(wallet: Wallet, expectedVersion: number): Promise<void> {
    const affected = await this.sql.execute(
      `UPDATE wallets SET balance_amount = ?::numeric, version = ?, updated_at = ?
       WHERE id = ? AND version = ?`,
      [wallet.balance.amount, wallet.version, wallet.updatedAt, wallet.id, expectedVersion],
    );
    if (affected !== 1) {
      // Cannot happen while the row is locked; kept as an optimistic guard (retried as transient).
      throw new TransientError(`wallet ${wallet.id} version moved (expected ${expectedVersion})`, undefined, 'LOCK_CONFLICT');
    }
  }

  async listIds(limit: number): Promise<string[]> {
    const rows = await this.sql.query<{ id: string }>(`SELECT id FROM wallets ORDER BY id LIMIT ?`, [limit]);
    return rows.map((r) => r.id);
  }
}
