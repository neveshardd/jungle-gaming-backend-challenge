import { ApplicationError, TransientError } from '../../shared/application/errors';
import { DomainError } from '../../shared/domain/errors';

/** SQLSTATEs that are safe to retry by re-running the whole transaction. */
const LOCK_CONFLICT_CODES: Record<string, string> = {
  '40001': 'serialization_failure',
  '40P01': 'deadlock_detected',
  '55P03': 'lock_not_available',
  // Unique violation can only surface from the partial "single reversal" index in a race the
  // wallet lock should already prevent; re-running the transaction yields ALREADY_REVERSED.
  '23505': 'unique_violation',
};

const TRANSIENT_CODES = new Set([
  '57014', // query_canceled (statement_timeout)
  '08000',
  '08001',
  '08003',
  '08004',
  '08006',
  '57P01', // admin_shutdown
  '57P02',
  '57P03', // cannot_connect_now
  '53300', // too_many_connections
  '53400',
]);

const NODE_NETWORK_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'EHOSTUNREACH', 'ENOTFOUND', 'EAI_AGAIN']);

const MIKRO_TRANSIENT_EXCEPTIONS = new Set([
  'ConnectionException',
  'DeadlockException',
  'LockWaitTimeoutException',
  'KnexTimeoutError',
]);

export interface ClassifiedDbError {
  error: unknown;
  transient: boolean;
  lockConflict?: string;
}

function readCode(err: unknown): string | undefined {
  if (!err || typeof err !== 'object') return undefined;
  const e = err as { code?: unknown; sqlState?: unknown; cause?: unknown };
  if (typeof e.sqlState === 'string') return e.sqlState;
  if (typeof e.code === 'string') return e.code;
  return e.cause ? readCode(e.cause) : undefined;
}

export function classifyDbError(err: unknown): ClassifiedDbError {
  if (err instanceof DomainError) return { error: err, transient: false };
  if (err instanceof ApplicationError) return { error: err, transient: err.category === 'transient' };

  const code = readCode(err);
  if (code && LOCK_CONFLICT_CODES[code]) {
    return {
      error: new TransientError(`database lock conflict (${LOCK_CONFLICT_CODES[code]})`, err, 'LOCK_CONFLICT'),
      transient: true,
      lockConflict: LOCK_CONFLICT_CODES[code],
    };
  }
  const name = err instanceof Error ? err.name : '';
  const message = err instanceof Error ? err.message : '';
  if (
    (code && (TRANSIENT_CODES.has(code) || NODE_NETWORK_CODES.has(code))) ||
    MIKRO_TRANSIENT_EXCEPTIONS.has(name) ||
    /Connection terminated|timeout acquiring a connection|Client has encountered a connection error/i.test(message)
  ) {
    return { error: new TransientError('database temporarily unavailable', err), transient: true };
  }
  return { error: err, transient: false };
}
