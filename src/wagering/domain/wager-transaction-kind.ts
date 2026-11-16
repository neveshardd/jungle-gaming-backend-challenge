export enum WagerTransactionKind {
  /** Internal: opening credit of a wallet. Never accepted from API or queue. */
  Opening = 'OPENING',
  Bet = 'BET',
  Win = 'WIN',
  Loss = 'LOSS',
  Refund = 'REFUND',
  Rollback = 'ROLLBACK',
}

export const EXTERNAL_KINDS = [
  WagerTransactionKind.Bet,
  WagerTransactionKind.Win,
  WagerTransactionKind.Loss,
  WagerTransactionKind.Refund,
  WagerTransactionKind.Rollback,
] as const;

export type ExternalWagerKind = (typeof EXTERNAL_KINDS)[number];

export function isExternalKind(value: unknown): value is ExternalWagerKind {
  return typeof value === 'string' && (EXTERNAL_KINDS as readonly string[]).includes(value);
}
