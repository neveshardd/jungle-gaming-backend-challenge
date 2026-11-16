import { canonicalHash } from '../../shared/crypto/canonical-json';
import type { MoneyProps } from '../../shared/domain/money';

/** Business fields of a wager request (the Idempotency-Key and transport metadata are NOT part of it). */
export interface WagerPayload {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: MoneyProps;
  referenceExternalTransactionId?: string | undefined;
}

/**
 * payloadHash = SHA-256( canonicalJson({ providerId, externalTransactionId, playerId, walletId,
 *   roundId, gameId, kind, money: { amount, currency }, referenceExternalTransactionId? }) ), hex.
 *
 * Only the fields above participate (explicit allow-list), so unknown/extra fields, the
 * Idempotency-Key header, correlation ids and SQS envelope metadata never change the hash.
 */
export function hashWagerPayload(payload: WagerPayload): string {
  return canonicalHash({
    providerId: payload.providerId,
    externalTransactionId: payload.externalTransactionId,
    playerId: payload.playerId,
    walletId: payload.walletId,
    roundId: payload.roundId,
    gameId: payload.gameId,
    kind: payload.kind,
    money: { amount: payload.money.amount, currency: payload.money.currency },
    referenceExternalTransactionId: payload.referenceExternalTransactionId,
  });
}
