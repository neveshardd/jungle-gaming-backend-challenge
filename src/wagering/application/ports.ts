import type { WagerTransaction } from '../domain/wager-transaction';

export interface WagerTransactionRepository {
  /**
   * INSERT ... ON CONFLICT DO NOTHING (covers both the idempotency key and the
   * (provider_id, external_transaction_id) unique constraints). Returns false when a row
   * already exists — the caller then decides between replay and conflict.
   */
  insertIfAbsent(tx: WagerTransaction): Promise<boolean>;
  /** Persists the mutable state (status, reference, failure, result balance, retry schedule). */
  save(tx: WagerTransaction): Promise<void>;
  findById(id: string): Promise<WagerTransaction | undefined>;
  findByIdempotencyKey(key: string): Promise<WagerTransaction | undefined>;
  findByExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction | undefined>;
  hasProcessedReversal(referenceTransactionId: string): Promise<boolean>;
  /** Ids of PENDING_REFERENCE transactions whose next attempt is due (database clock). */
  findDuePendingReferences(limit: number): Promise<string[]>;
  /** Pulls forward the retry of PENDING_REFERENCE rows waiting for the given external id. */
  expediteDependents(walletId: string, providerId: string, externalTransactionId: string, now: Date): Promise<number>;
  countByWallet(walletId: string): Promise<Record<string, number>>;
}
