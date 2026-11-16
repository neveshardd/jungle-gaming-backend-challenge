/**
 * Stable, machine-readable reasons persisted on REJECTED / FAILED transactions.
 * Provider guidance for each code is documented in ARCHITECTURE.md.
 */
export enum FailureCode {
  /** BET larger than the available balance. Terminal; provider may retry with a NEW transaction id. */
  InsufficientFunds = 'INSUFFICIENT_FUNDS',
  /** A reversal (ROLLBACK of a WIN/REFUND) would make the balance negative. Needs operator attention. */
  ReversalWouldOverdraw = 'REVERSAL_WOULD_OVERDRAW',
  /** Operation currency differs from the wallet currency. Fix payload. */
  CurrencyMismatch = 'CURRENCY_MISMATCH',
  /** playerId does not own walletId. Fix payload. */
  WalletPlayerMismatch = 'WALLET_PLAYER_MISMATCH',
  /** Referenced transaction never arrived within the retry budget. */
  ReferenceNotFound = 'REFERENCE_NOT_FOUND',
  /** Reference exists but belongs to another provider/player/wallet/currency/round. */
  ReferenceMismatch = 'REFERENCE_MISMATCH',
  /** Reference kind cannot be targeted by this operation (e.g. REFUND of a WIN). */
  ReferenceKindNotAllowed = 'REFERENCE_KIND_NOT_ALLOWED',
  /** Reference exists but is REJECTED/FAILED (or never reached PROCESSED within the retry budget). */
  ReferenceNotProcessed = 'REFERENCE_NOT_PROCESSED',
  /** Reversal amount differs from the reference amount (partial reversals are out of scope). */
  ReferenceAmountMismatch = 'REFERENCE_AMOUNT_MISMATCH',
  /** Reference has already been reversed. */
  AlreadyReversed = 'ALREADY_REVERSED',
  /** FAILED: unexpected permanent processing error (auditable, operator attention). */
  ProcessingError = 'PROCESSING_ERROR',
}
