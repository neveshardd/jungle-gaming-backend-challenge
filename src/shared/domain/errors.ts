/**
 * Base class for violations of domain rules. Domain errors carry a stable,
 * machine-readable `code` and never depend on transport or persistence.
 */
export abstract class DomainError extends Error {
  abstract readonly code: string;

  protected constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** Invalid monetary input (format, scale, sign, currency code, precision). */
export class InvalidMoneyError extends DomainError {
  readonly code = 'INVALID_MONEY';
  constructor(message: string) {
    super(message);
  }
}

/** Arithmetic or comparison between two different currencies. */
export class CurrencyMismatchError extends DomainError {
  readonly code = 'CURRENCY_MISMATCH';
  constructor(message: string) {
    super(message);
  }
}

/** A debit would take the wallet balance below zero. */
export class InsufficientFundsError extends DomainError {
  readonly code = 'INSUFFICIENT_FUNDS';
  constructor(message: string) {
    super(message);
  }
}

/** Invalid wallet construction (e.g. empty player id). */
export class InvalidWalletError extends DomainError {
  readonly code = 'INVALID_WALLET';
  constructor(message: string) {
    super(message);
  }
}

/** A ledger entry whose arithmetic or shape is invalid. Always a programming error. */
export class InvalidLedgerEntryError extends DomainError {
  readonly code = 'INVALID_LEDGER_ENTRY';
  constructor(message: string) {
    super(message);
  }
}

/** Invalid wager transaction contract (missing reference, internal kind, zero amount...). */
export class InvalidWagerTransactionError extends DomainError {
  constructor(
    message: string,
    readonly code: string = 'INVALID_TRANSACTION',
  ) {
    super(message);
  }
}

/**
 * Attempt to transition a transaction that is already in a terminal state.
 * This is a programming error, not a business path.
 */
export class InvalidTransactionStateError extends DomainError {
  readonly code = 'INVALID_TRANSACTION_STATE';
  constructor(message: string) {
    super(message);
  }
}

/** Invalid inbox/outbox construction or transition. */
export class InvalidMessageStateError extends DomainError {
  readonly code = 'INVALID_MESSAGE_STATE';
  constructor(message: string) {
    super(message);
  }
}
