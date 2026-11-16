import { z } from 'zod';
import { canonicalHash } from '../../shared/crypto/canonical-json';

export const WAGER_TRANSACTION_REQUESTED = 'WagerTransactionRequested';

const identifier = z.string().min(1).max(128);

/** Business payload shared by HTTP and SQS (unknown fields are stripped, never hashed). */
export const wagerPayloadSchema = z.object({
  providerId: identifier,
  externalTransactionId: identifier,
  playerId: identifier,
  walletId: z.string().uuid(),
  roundId: identifier,
  gameId: identifier,
  kind: z.string().min(1).max(16),
  money: z.object({ amount: z.string(), currency: z.string() }),
  referenceExternalTransactionId: identifier.optional(),
});

export const wagerMessageSchema = z.object({
  messageId: z.string().min(1).max(256),
  type: z.literal(WAGER_TRANSACTION_REQUESTED),
  occurredAt: z.string().datetime({ offset: true }),
  data: wagerPayloadSchema.extend({ idempotencyKey: z.string().min(1).max(256) }),
});

export type WagerMessage = z.infer<typeof wagerMessageSchema>;

/** Hash used by the inbox to detect a messageId reused with a different content. */
export function hashMessage(message: WagerMessage): string {
  return canonicalHash({ type: message.type, data: message.data });
}
