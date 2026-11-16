import { InboxMessage } from '../../messaging/domain/inbox-message';
import { ConflictError, NotFoundError, PermanentError, TransientError, ValidationError } from '../../shared/application/errors';
import type { Logger } from '../../shared/application/logger';
import type { AppMetrics } from '../../shared/application/metrics';
import type { TransactionalRepositories, UnitOfWork } from '../../shared/application/unit-of-work';
import type { Clock } from '../../shared/domain/clock';
import { InvalidWagerTransactionError } from '../../shared/domain/errors';
import { type IdGenerator, isUuid } from '../../shared/domain/ids';
import { Money } from '../../shared/domain/money';
import { hashWagerPayload, type WagerPayload } from '../domain/payload-hash';
import { WagerTransaction } from '../domain/wager-transaction';
import { isExternalKind } from '../domain/wager-transaction-kind';
import { toWagerResult, type WagerResult } from './wager-views';
import type { WagerSettlement } from './wager-settlement';

export interface WagerSubmission {
  /** Source of truth for idempotency (HTTP header / message field). */
  idempotencyKey: string;
  payload: WagerPayload;
  source: 'http' | 'sqs';
  correlationId: string;
  causationId?: string;
  /** Present for queue deliveries: deduplication by (consumerName, messageId) in the same SQL tx. */
  inbox?: { consumerName: string; messageId: string; payloadHash: string };
}

export type WagerSubmissionOutcome =
  | { type: 'completed'; result: WagerResult }
  | { type: 'duplicate_message' };

export interface ProcessWagerDeps {
  uow: UnitOfWork;
  settlement: WagerSettlement;
  ids: IdGenerator;
  clock: Clock;
  metrics: AppMetrics;
  logger: Logger;
}

/**
 * The single use case behind POST /wagering/transactions AND the SQS consumer.
 *
 * One SQL transaction:
 *   1. inbox insert (queue only)        -> duplicate delivery? stop.
 *   2. wallet existence check
 *   3. claim idempotency key            -> existing row? replay (same hash) or conflict.
 *   4. SELECT wallet FOR NO KEY UPDATE  -> serializes all balance changes of this wallet.
 *   5. resolve reference, decide, apply -> wallet + ledger + transaction state
 *   6. outbox events
 *   7. inbox processed
 * Nothing is published here: the outbox publisher only sees committed rows.
 */
export class ProcessWagerTransactionUseCase {
  constructor(private readonly deps: ProcessWagerDeps) {}

  async execute(cmd: WagerSubmission): Promise<WagerSubmissionOutcome> {
    const startedAt = performance.now();
    const { payload } = cmd;
    if (typeof cmd.idempotencyKey !== 'string' || cmd.idempotencyKey.trim().length === 0) {
      throw new ValidationError('IDEMPOTENCY_KEY_REQUIRED', 'Idempotency-Key is required');
    }
    if (!isExternalKind(payload.kind)) {
      throw new InvalidWagerTransactionError(`kind ${String(payload.kind)} cannot be submitted`, 'KIND_NOT_ALLOWED');
    }
    if (!isUuid(payload.walletId)) {
      throw new ValidationError('VALIDATION_ERROR', 'walletId must be a UUID');
    }
    const money = Money.from(payload.money);
    const payloadHash = hashWagerPayload(payload);

    const outcome = await this.deps.uow.run((r) => this.processInTransaction(r, cmd, money, payloadHash), {
      label: 'process-wager',
    });

    if (outcome.type === 'completed') {
      this.deps.metrics.transactionCompleted(
        { kind: payload.kind, status: outcome.result.status, source: cmd.source, replay: outcome.result.idempotentReplay },
        (performance.now() - startedAt) / 1000,
      );
      this.deps.logger.info(
        {
          transactionId: outcome.result.transactionId,
          walletId: payload.walletId,
          providerId: payload.providerId,
          kind: payload.kind,
          status: outcome.result.status,
          failureCode: outcome.result.failureCode,
          idempotentReplay: outcome.result.idempotentReplay,
          source: cmd.source,
        },
        'wager transaction completed',
      );
    }
    return outcome;
  }

  private async processInTransaction(
    r: TransactionalRepositories,
    cmd: WagerSubmission,
    money: Money,
    payloadHash: string,
  ): Promise<WagerSubmissionOutcome> {
    const now = this.deps.clock.now();
    const { payload } = cmd;

    let inbox: InboxMessage | undefined;
    if (cmd.inbox) {
      inbox = InboxMessage.receive({ ...cmd.inbox, receivedAt: now });
      const receipt = await r.inbox.receive(inbox);
      if (receipt.duplicate) {
        if (!receipt.existing.matchesPayload(cmd.inbox.payloadHash)) {
          throw new PermanentError('INBOX_PAYLOAD_MISMATCH', `message ${cmd.inbox.messageId} redelivered with a different payload`);
        }
        this.deps.metrics.duplicateDetected('inbox_duplicate');
        return { type: 'duplicate_message' };
      }
    }

    if (!(await r.wallets.exists(payload.walletId))) {
      throw new NotFoundError('WALLET_NOT_FOUND', `wallet ${payload.walletId} not found`);
    }

    const candidate = WagerTransaction.create({
      id: this.deps.ids.next(),
      providerId: payload.providerId,
      externalTransactionId: payload.externalTransactionId,
      idempotencyKey: cmd.idempotencyKey,
      payloadHash,
      walletId: payload.walletId,
      playerId: payload.playerId,
      roundId: payload.roundId,
      gameId: payload.gameId,
      kind: payload.kind as WagerTransaction['kind'],
      money,
      referenceExternalTransactionId: payload.referenceExternalTransactionId,
      createdAt: now,
    });

    const claimed = await r.transactions.insertIfAbsent(candidate);
    if (!claimed) {
      const existing =
        (await r.transactions.findByIdempotencyKey(cmd.idempotencyKey)) ??
        (await r.transactions.findByExternalId(payload.providerId, payload.externalTransactionId));
      if (!existing) {
        throw new TransientError('idempotency claim raced with a rollback; retry');
      }
      if (existing.idempotencyKey !== cmd.idempotencyKey) {
        throw new ConflictError(
          'EXTERNAL_ID_CONFLICT',
          `externalTransactionId ${payload.externalTransactionId} was already submitted with another Idempotency-Key`,
          { transactionId: existing.id },
        );
      }
      if (!existing.matchesPayload(payloadHash)) {
        this.deps.metrics.idempotencyConflict();
        throw new ConflictError(
          'IDEMPOTENCY_CONFLICT',
          'Idempotency-Key was already used with a different payload',
          { transactionId: existing.id },
        );
      }
      this.deps.metrics.duplicateDetected('idempotent_replay');
      await this.completeInbox(r, inbox, now);
      return { type: 'completed', result: toWagerResult(existing, true) };
    }

    const wallet = await r.wallets.lockById(candidate.walletId);
    if (!wallet) throw new TransientError(`wallet ${candidate.walletId} vanished during processing`);

    await this.deps.settlement.settle(r, candidate, wallet, {
      correlationId: cmd.correlationId,
      causationId: cmd.causationId,
      now,
    });
    await this.completeInbox(r, inbox, now);
    return { type: 'completed', result: toWagerResult(candidate, false) };
  }

  private async completeInbox(r: TransactionalRepositories, inbox: InboxMessage | undefined, now: Date): Promise<void> {
    if (!inbox) return;
    inbox.markProcessed(now);
    await r.inbox.markProcessed(inbox);
  }
}
