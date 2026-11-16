import type { InboxRepository, OutboxRepository } from '../../messaging/application/ports';
import type { WagerTransactionRepository } from '../../wagering/application/ports';
import type { LedgerRepository, WalletRepository } from '../../wallet/application/ports';

/** Repositories bound to one SQL transaction (or to autocommit for `read`). */
export interface TransactionalRepositories {
  wallets: WalletRepository;
  transactions: WagerTransactionRepository;
  ledger: LedgerRepository;
  inbox: InboxRepository;
  outbox: OutboxRepository;
}

export interface UnitOfWorkOptions {
  /** Defaults to READ COMMITTED + explicit row locks. */
  isolation?: 'read_committed' | 'repeatable_read';
  label?: string;
}

/**
 * Atomic boundary: everything done through the repositories inside `run` commits together
 * (inbox + transaction + wallet + ledger + outbox) or not at all. Transient database errors
 * (deadlock, lock timeout, serialization, connection loss) are retried a bounded number of
 * times by the implementation, re-running `work` from scratch.
 */
export interface UnitOfWork {
  run<T>(work: (repos: TransactionalRepositories) => Promise<T>, options?: UnitOfWorkOptions): Promise<T>;
  /** Autocommit reads (no transaction). */
  read<T>(work: (repos: TransactionalRepositories) => Promise<T>): Promise<T>;
}
