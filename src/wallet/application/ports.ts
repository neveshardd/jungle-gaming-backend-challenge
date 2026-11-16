import type { Wallet } from '../domain/wallet';
import type { WalletLedgerEntry } from '../domain/wallet-ledger-entry';

export interface WalletRepository {
  /** INSERT ... ON CONFLICT (player_id, currency) DO NOTHING. Returns false on duplicate. */
  insertIfAbsent(wallet: Wallet): Promise<boolean>;
  exists(id: string): Promise<boolean>;
  findById(id: string): Promise<Wallet | undefined>;
  /**
   * SELECT ... FOR NO KEY UPDATE: the per-wallet serialization point. NO KEY UPDATE (not FOR UPDATE)
   * because inserts into tables with an FK to wallets take FOR KEY SHARE on the wallet row; FOR UPDATE
   * would conflict with it and deadlock two transactions that inserted before locking.
   */
  lockById(id: string): Promise<Wallet | undefined>;
  /** Writes balance/version guarded by the expected version (defense in depth on top of the lock). */
  update(wallet: Wallet, expectedVersion: number): Promise<void>;
  listIds(limit: number): Promise<string[]>;
}

export interface LedgerPageItem {
  entry: WalletLedgerEntry;
  sequence: string;
}

export interface LedgerSummary {
  entries: number;
  /** Sum(credits) - Sum(debits), decimal string. */
  netAmount: string;
  lastBalanceAfter: string | undefined;
  /** Entries whose balance_before differs from the previous entry's balance_after. */
  chainBreaks: number;
  /** Ledger entries not produced by the OPENING transaction (each one bumps the wallet version). */
  balanceMovements: number;
}

export interface LedgerRepository {
  append(entry: WalletLedgerEntry): Promise<void>;
  page(walletId: string, afterSequence: string | undefined, limit: number): Promise<LedgerPageItem[]>;
  countForTransaction(transactionId: string): Promise<number>;
  summarize(walletId: string): Promise<LedgerSummary>;
}
