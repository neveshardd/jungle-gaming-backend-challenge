import { Money } from '../../../shared/domain/money';
import type { LedgerPageItem, LedgerRepository, LedgerSummary } from '../../../wallet/application/ports';
import type { LedgerDirection } from '../../../wallet/domain/ledger-direction';
import { WalletLedgerEntry } from '../../../wallet/domain/wallet-ledger-entry';
import { type SqlExecutor, toDate } from '../sql-executor';

interface LedgerRow {
  id: string;
  seq: string;
  wallet_id: string;
  transaction_id: string;
  direction: string;
  amount: string;
  currency: string;
  balance_before: string;
  balance_after: string;
  created_at: Date;
}

function toDomain(row: LedgerRow): WalletLedgerEntry {
  return WalletLedgerEntry.rehydrate({
    id: row.id,
    walletId: row.wallet_id,
    transactionId: row.transaction_id,
    direction: row.direction as LedgerDirection,
    money: Money.rehydrate(row.amount, row.currency),
    balanceBefore: Money.rehydrate(row.balance_before, row.currency),
    balanceAfter: Money.rehydrate(row.balance_after, row.currency),
    createdAt: toDate(row.created_at),
  });
}

export class PgLedgerRepository implements LedgerRepository {
  constructor(private readonly sql: SqlExecutor) {}

  async append(entry: WalletLedgerEntry): Promise<void> {
    await this.sql.execute(
      `INSERT INTO wallet_ledger_entries
         (id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after, created_at)
       VALUES (?, ?, ?, ?, ?::numeric, ?, ?::numeric, ?::numeric, ?)`,
      [
        entry.id,
        entry.walletId,
        entry.transactionId,
        entry.direction,
        entry.money.amount,
        entry.money.currency,
        entry.balanceBefore.amount,
        entry.balanceAfter.amount,
        entry.createdAt,
      ],
    );
  }

  async page(walletId: string, afterSequence: string | undefined, limit: number): Promise<LedgerPageItem[]> {
    const rows = await this.sql.query<LedgerRow>(
      `SELECT id, seq::text AS seq, wallet_id, transaction_id, direction, amount::text AS amount, currency,
              balance_before::text AS balance_before, balance_after::text AS balance_after, created_at
       FROM wallet_ledger_entries
       WHERE wallet_id = ? AND seq > ?::bigint
       ORDER BY seq
       LIMIT ?`,
      [walletId, afterSequence ?? '0', limit],
    );
    return rows.map((row) => ({ entry: toDomain(row), sequence: row.seq }));
  }

  async countForTransaction(transactionId: string): Promise<number> {
    const row = await this.sql.one<{ count: number }>(
      `SELECT count(*)::int AS count FROM wallet_ledger_entries WHERE transaction_id = ?`,
      [transactionId],
    );
    return row?.count ?? 0;
  }

  async summarize(walletId: string): Promise<LedgerSummary> {
    const totals = await this.sql.one<{ entries: number; net: string; movements: number }>(
      `SELECT count(*)::int AS entries,
              COALESCE(sum(CASE WHEN l.direction = 'CREDIT' THEN l.amount ELSE -l.amount END), 0)::text AS net,
              (count(*) FILTER (WHERE t.kind <> 'OPENING'))::int AS movements
       FROM wallet_ledger_entries l
       JOIN wager_transactions t ON t.id = l.transaction_id
       WHERE l.wallet_id = ?`,
      [walletId],
    );
    const last = await this.sql.one<{ balance_after: string }>(
      `SELECT balance_after::text AS balance_after FROM wallet_ledger_entries
       WHERE wallet_id = ? ORDER BY seq DESC LIMIT 1`,
      [walletId],
    );
    const chain = await this.sql.one<{ breaks: number }>(
      `SELECT count(*)::int AS breaks FROM (
         SELECT balance_before,
                lag(balance_after, 1, 0::numeric) OVER (ORDER BY seq) AS previous_after
         FROM wallet_ledger_entries WHERE wallet_id = ?
       ) chain
       WHERE balance_before <> previous_after`,
      [walletId],
    );
    return {
      entries: totals?.entries ?? 0,
      netAmount: totals?.net ?? '0',
      lastBalanceAfter: last?.balance_after,
      chainBreaks: chain?.breaks ?? 0,
      balanceMovements: totals?.movements ?? 0,
    };
  }
}
