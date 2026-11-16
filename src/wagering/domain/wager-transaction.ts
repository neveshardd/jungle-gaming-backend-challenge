import { InvalidTransactionStateError, InvalidWagerTransactionError } from '../../shared/domain/errors';
import type { Money } from '../../shared/domain/money';
import { invertDirection, LedgerDirection } from '../../wallet/domain/ledger-direction';
import type { FailureCode } from './failure-code';
import { WagerTransactionKind } from './wager-transaction-kind';
import { TERMINAL_STATUSES, WagerTransactionStatus } from './wager-transaction-status';

export interface WagerTransactionState {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  /** Provider-side id of the referenced transaction (not the internal id). */
  referenceExternalTransactionId: string | undefined;
  createdAt: Date;
  updatedAt: Date;
  status: WagerTransactionStatus;
  referenceTransactionId: string | undefined;
  failureCode: FailureCode | undefined;
  processedAt: Date | undefined;
  /** Balance observed when the transaction reached its result (replays return it). */
  resultBalance: Money | undefined;
  /** Number of reference resolution attempts that ended in PENDING_REFERENCE. */
  referenceAttempts: number;
  nextAttemptAt: Date | undefined;
}

export interface CreateWagerTransactionProps {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId?: string | undefined;
  createdAt: Date;
}

const MAX_ID_LENGTH = 128;
const MAX_IDEMPOTENCY_KEY_LENGTH = 256;
const PAYLOAD_HASH = /^[0-9a-f]{64}$/;

/** Which kinds each operation may reference. REFUND/ROLLBACK require a reference; WIN/LOSS may reference a BET. */
const ALLOWED_REFERENCE_KINDS: Readonly<Record<WagerTransactionKind, readonly WagerTransactionKind[]>> = {
  [WagerTransactionKind.Opening]: [],
  [WagerTransactionKind.Bet]: [],
  [WagerTransactionKind.Win]: [WagerTransactionKind.Bet],
  [WagerTransactionKind.Loss]: [WagerTransactionKind.Bet],
  [WagerTransactionKind.Refund]: [WagerTransactionKind.Bet],
  [WagerTransactionKind.Rollback]: [WagerTransactionKind.Bet, WagerTransactionKind.Win, WagerTransactionKind.Refund],
};

/**
 * Valid transitions:
 *
 *   PENDING ───────────┬──> PROCESSED (terminal)
 *        │             ├──> REJECTED  (terminal)
 *        │             └──> FAILED    (terminal)
 *        └──> PENDING_REFERENCE ──(retry)──> PENDING_REFERENCE
 *                     └──────────────> PROCESSED | REJECTED | FAILED
 *
 * Any transition out of a terminal state throws InvalidTransactionStateError.
 */
export class WagerTransaction {
  public readonly id: string;
  public readonly providerId: string;
  public readonly externalTransactionId: string;
  public readonly idempotencyKey: string;
  public readonly payloadHash: string;
  public readonly walletId: string;
  public readonly playerId: string;
  public readonly roundId: string;
  public readonly gameId: string;
  public readonly kind: WagerTransactionKind;
  public readonly money: Money;
  public readonly referenceExternalTransactionId: string | undefined;
  public readonly createdAt: Date;
  private _updatedAt: Date;
  private _status: WagerTransactionStatus;
  private _referenceTransactionId: string | undefined;
  private _failureCode: FailureCode | undefined;
  private _processedAt: Date | undefined;
  private _resultBalance: Money | undefined;
  private _referenceAttempts: number;
  private _nextAttemptAt: Date | undefined;

  private constructor(state: WagerTransactionState) {
    this.id = state.id;
    this.providerId = state.providerId;
    this.externalTransactionId = state.externalTransactionId;
    this.idempotencyKey = state.idempotencyKey;
    this.payloadHash = state.payloadHash;
    this.walletId = state.walletId;
    this.playerId = state.playerId;
    this.roundId = state.roundId;
    this.gameId = state.gameId;
    this.kind = state.kind;
    this.money = state.money;
    this.referenceExternalTransactionId = state.referenceExternalTransactionId;
    this.createdAt = state.createdAt;
    this._updatedAt = state.updatedAt;
    this._status = state.status;
    this._referenceTransactionId = state.referenceTransactionId;
    this._failureCode = state.failureCode;
    this._processedAt = state.processedAt;
    this._resultBalance = state.resultBalance;
    this._referenceAttempts = state.referenceAttempts;
    this._nextAttemptAt = state.nextAttemptAt;
  }

  /** External (provider) transaction. Born PENDING. OPENING is not accepted here. */
  static create(props: CreateWagerTransactionProps): WagerTransaction {
    if (props.kind === WagerTransactionKind.Opening) {
      throw new InvalidWagerTransactionError('OPENING is internal and cannot be submitted', 'KIND_NOT_ALLOWED');
    }
    return WagerTransaction.build(props);
  }

  /** Internal OPENING credit created together with the wallet. */
  static createOpening(props: Omit<CreateWagerTransactionProps, 'kind' | 'referenceExternalTransactionId'>): WagerTransaction {
    return WagerTransaction.build({ ...props, kind: WagerTransactionKind.Opening });
  }

  static rehydrate(state: WagerTransactionState): WagerTransaction {
    return new WagerTransaction(state);
  }

  private static build(props: CreateWagerTransactionProps): WagerTransaction {
    if (!Object.values(WagerTransactionKind).includes(props.kind)) {
      throw new InvalidWagerTransactionError(`unknown kind ${String(props.kind)}`, 'KIND_NOT_ALLOWED');
    }
    for (const [field, value] of [
      ['providerId', props.providerId],
      ['externalTransactionId', props.externalTransactionId],
      ['playerId', props.playerId],
      ['walletId', props.walletId],
      ['roundId', props.roundId],
      ['gameId', props.gameId],
    ] as const) {
      assertIdentifier(field, value, MAX_ID_LENGTH);
    }
    assertIdentifier('idempotencyKey', props.idempotencyKey, MAX_IDEMPOTENCY_KEY_LENGTH);
    if (!PAYLOAD_HASH.test(props.payloadHash)) {
      throw new InvalidWagerTransactionError('payloadHash must be a sha-256 hex digest');
    }
    if (!props.money.isPositive()) {
      throw new InvalidWagerTransactionError('money.amount must be greater than zero');
    }
    const reference = props.referenceExternalTransactionId;
    const allowed = ALLOWED_REFERENCE_KINDS[props.kind];
    if (reference !== undefined) {
      assertIdentifier('referenceExternalTransactionId', reference, MAX_ID_LENGTH);
      if (allowed.length === 0) {
        throw new InvalidWagerTransactionError(`${props.kind} cannot reference another transaction`);
      }
      if (reference === props.externalTransactionId) {
        throw new InvalidWagerTransactionError('a transaction cannot reference itself');
      }
    } else if (props.kind === WagerTransactionKind.Refund || props.kind === WagerTransactionKind.Rollback) {
      throw new InvalidWagerTransactionError(`${props.kind} requires referenceExternalTransactionId`, 'REFERENCE_REQUIRED');
    }
    return new WagerTransaction({
      ...props,
      referenceExternalTransactionId: reference,
      updatedAt: props.createdAt,
      status: WagerTransactionStatus.Pending,
      referenceTransactionId: undefined,
      failureCode: undefined,
      processedAt: undefined,
      resultBalance: undefined,
      referenceAttempts: 0,
      nextAttemptAt: undefined,
    });
  }

  get status(): WagerTransactionStatus {
    return this._status;
  }
  get referenceTransactionId(): string | undefined {
    return this._referenceTransactionId;
  }
  get failureCode(): FailureCode | undefined {
    return this._failureCode;
  }
  get processedAt(): Date | undefined {
    return this._processedAt;
  }
  get resultBalance(): Money | undefined {
    return this._resultBalance;
  }
  get referenceAttempts(): number {
    return this._referenceAttempts;
  }
  get nextAttemptAt(): Date | undefined {
    return this._nextAttemptAt;
  }
  get updatedAt(): Date {
    return this._updatedAt;
  }

  // ---- transitions -------------------------------------------------------

  markProcessed(referenceTransactionId: string | undefined, at: Date, resultBalance: Money): void {
    this.assertNotTerminal(WagerTransactionStatus.Processed);
    if (this.requiresReference() && referenceTransactionId === undefined) {
      throw new InvalidTransactionStateError(`${this.kind} ${this.id} must be bound to its reference to be processed`);
    }
    this._status = WagerTransactionStatus.Processed;
    this._referenceTransactionId = referenceTransactionId;
    this._processedAt = at;
    this._resultBalance = resultBalance;
    this._nextAttemptAt = undefined;
    this._updatedAt = at;
  }

  markPendingReference(nextAttemptAt: Date, at: Date): void {
    this.assertNotTerminal(WagerTransactionStatus.PendingReference);
    if (this.referenceExternalTransactionId === undefined) {
      throw new InvalidTransactionStateError(`${this.id} has no reference to wait for`);
    }
    this._status = WagerTransactionStatus.PendingReference;
    this._referenceAttempts += 1;
    this._nextAttemptAt = nextAttemptAt;
    this._updatedAt = at;
  }

  reject(code: FailureCode, at: Date, observedBalance: Money | undefined): void {
    this.assertNotTerminal(WagerTransactionStatus.Rejected);
    this._status = WagerTransactionStatus.Rejected;
    this._failureCode = code;
    this._resultBalance = observedBalance;
    this._nextAttemptAt = undefined;
    this._updatedAt = at;
  }

  fail(code: FailureCode, at: Date): void {
    this.assertNotTerminal(WagerTransactionStatus.Failed);
    this._status = WagerTransactionStatus.Failed;
    this._failureCode = code;
    this._nextAttemptAt = undefined;
    this._updatedAt = at;
  }

  // ---- domain queries ----------------------------------------------------

  isTerminal(): boolean {
    return TERMINAL_STATUSES.has(this._status);
  }

  affectsBalance(): boolean {
    return this.kind !== WagerTransactionKind.Loss;
  }

  requiresReference(): boolean {
    return this.kind === WagerTransactionKind.Refund || this.kind === WagerTransactionKind.Rollback;
  }

  isReversal(): boolean {
    return this.requiresReference();
  }

  canReference(kind: WagerTransactionKind): boolean {
    return ALLOWED_REFERENCE_KINDS[this.kind].includes(kind);
  }

  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection {
    switch (this.kind) {
      case WagerTransactionKind.Opening:
      case WagerTransactionKind.Win:
      case WagerTransactionKind.Refund:
        return LedgerDirection.Credit;
      case WagerTransactionKind.Bet:
        return LedgerDirection.Debit;
      case WagerTransactionKind.Rollback:
        if (!reference) {
          throw new InvalidTransactionStateError('ROLLBACK direction depends on its reference');
        }
        return invertDirection(reference.ledgerDirectionFor());
      case WagerTransactionKind.Loss:
        throw new InvalidTransactionStateError('LOSS does not move balance');
    }
  }

  private assertNotTerminal(target: WagerTransactionStatus): void {
    if (this.isTerminal()) {
      throw new InvalidTransactionStateError(
        `transaction ${this.id} is ${this._status} (terminal) and cannot transition to ${target}`,
      );
    }
  }
}

function assertIdentifier(field: string, value: unknown, maxLength: number): void {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength) {
    throw new InvalidWagerTransactionError(`${field} must be a non-empty string up to ${maxLength} chars`);
  }
}
