import type { TransactionalRepositories } from '../../../shared/application/unit-of-work';
import type { SqlExecutor } from '../sql-executor';
import { PgInboxRepository } from './pg-inbox.repository';
import { PgLedgerRepository } from './pg-ledger.repository';
import { PgOutboxRepository } from './pg-outbox.repository';
import { PgWagerTransactionRepository } from './pg-wager-transaction.repository';
import { PgWalletRepository } from './pg-wallet.repository';

export function createRepositories(sql: SqlExecutor): TransactionalRepositories {
  return {
    wallets: new PgWalletRepository(sql),
    transactions: new PgWagerTransactionRepository(sql),
    ledger: new PgLedgerRepository(sql),
    inbox: new PgInboxRepository(sql),
    outbox: new PgOutboxRepository(sql),
  };
}
