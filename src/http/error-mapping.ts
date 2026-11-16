import { HttpException } from '@nestjs/common';
import { ApplicationError } from '../shared/application/errors';
import {
  CurrencyMismatchError,
  DomainError,
  InvalidMoneyError,
  InvalidWagerTransactionError,
  InvalidWalletError,
} from '../shared/domain/errors';

export interface ErrorBody {
  code: string;
  message: string;
  details?: unknown;
}

export interface MappedError {
  status: number;
  body: ErrorBody;
  retryAfterSeconds?: number;
}

/**
 * Single, consistent mapping for every endpoint:
 *   400 invalid payload          (VALIDATION_ERROR, INVALID_MONEY, KIND_NOT_ALLOWED, ...)
 *   404 unknown resource         (WALLET_NOT_FOUND, TRANSACTION_NOT_FOUND)
 *   409 conflict                 (IDEMPOTENCY_CONFLICT, EXTERNAL_ID_CONFLICT, WALLET_ALREADY_EXISTS)
 *   422 business rejection       (persisted REJECTED transaction — returned as a result, not here)
 *   503 transient infrastructure (TRANSIENT_FAILURE / LOCK_CONFLICT) + Retry-After
 *   500 unexpected
 */
export function mapError(exception: unknown): MappedError {
  if (exception instanceof ApplicationError) {
    const body: ErrorBody = { code: exception.code, message: exception.message };
    if (exception.details !== undefined) body.details = exception.details;
    switch (exception.category) {
      case 'validation':
        return { status: 400, body };
      case 'not_found':
        return { status: 404, body };
      case 'conflict':
        return { status: 409, body };
      case 'transient':
        return { status: 503, body, retryAfterSeconds: 1 };
      case 'permanent':
        return { status: 500, body };
    }
  }
  if (
    exception instanceof InvalidMoneyError ||
    exception instanceof CurrencyMismatchError ||
    exception instanceof InvalidWagerTransactionError ||
    exception instanceof InvalidWalletError
  ) {
    return { status: 400, body: { code: exception.code, message: exception.message } };
  }
  if (exception instanceof DomainError) {
    // Remaining domain errors are invariant violations (programming errors).
    return { status: 500, body: { code: 'INTERNAL_ERROR', message: 'internal error' } };
  }
  if (exception instanceof HttpException) {
    const status = exception.getStatus();
    const code = status === 404 ? 'ROUTE_NOT_FOUND' : status < 500 ? 'VALIDATION_ERROR' : 'INTERNAL_ERROR';
    return { status, body: { code, message: exception.message } };
  }
  return { status: 500, body: { code: 'INTERNAL_ERROR', message: 'internal error' } };
}
