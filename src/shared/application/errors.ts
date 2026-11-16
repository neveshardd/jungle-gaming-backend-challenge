/**
 * Application-level errors. The `category` drives both the HTTP status mapping and the
 * SQS consumer decision (ack / retry / DLQ), so the two transports stay consistent.
 *
 *  validation  -> 400 / DLQ (contract is broken, resending the same payload never works)
 *  not_found   -> 404 / ack (business: nothing to apply)
 *  conflict    -> 409 / ack (idempotency or uniqueness conflict, never a replay)
 *  transient   -> 503 + Retry-After / retry with backoff
 *  permanent   -> 500 / DLQ
 */
export type ErrorCategory = 'validation' | 'not_found' | 'conflict' | 'transient' | 'permanent';

export abstract class ApplicationError extends Error {
  abstract readonly category: ErrorCategory;

  constructor(
    readonly code: string,
    message: string,
    readonly details?: unknown,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = new.target.name;
  }
}

export class ValidationError extends ApplicationError {
  readonly category = 'validation' as const;
}

export class NotFoundError extends ApplicationError {
  readonly category = 'not_found' as const;
}

export class ConflictError extends ApplicationError {
  readonly category = 'conflict' as const;
}

export class TransientError extends ApplicationError {
  readonly category = 'transient' as const;
  constructor(message: string, cause?: unknown, code = 'TRANSIENT_FAILURE') {
    super(code, message, undefined, { cause });
  }
}

export class PermanentError extends ApplicationError {
  readonly category = 'permanent' as const;
}
