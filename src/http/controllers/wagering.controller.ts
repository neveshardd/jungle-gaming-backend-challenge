import { Body, Controller, Get, Headers, Inject, Param, Post, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { currentContext, enrichContext } from '../../observability/context';
import { withSpan } from '../../observability/tracing';
import { ValidationError } from '../../shared/application/errors';
import { ProcessWagerTransactionUseCase } from '../../wagering/application/process-wager-transaction';
import type { WagerResult } from '../../wagering/application/wager-views';
import { WageringQueries } from '../../wagering/application/wagering-queries';
import { WagerTransactionStatus } from '../../wagering/domain/wager-transaction-status';
import { wagerPayloadSchema } from '../../infrastructure/sqs/message-contract';
import { ProviderAuthGuard } from '../auth/provider-auth.guard';
import { parseBody } from '../validation';

/**
 * Status of a wager result:
 *   PROCESSED          201 (first time) / 200 (idempotent replay)
 *   PENDING_REFERENCE  202 accepted, processing pending
 *   REJECTED           422 business rejection (persisted, with failureCode) — replays repeat it
 *   FAILED             500 terminal processing failure (auditable)
 */
export function statusForResult(result: WagerResult): number {
  switch (result.status) {
    case WagerTransactionStatus.Processed:
      return result.idempotentReplay ? 200 : 201;
    case WagerTransactionStatus.PendingReference:
      return 202;
    case WagerTransactionStatus.Rejected:
      return 422;
    default:
      return 500;
  }
}

@Controller()
@UseGuards(ProviderAuthGuard)
export class WageringController {
  constructor(
    @Inject(ProcessWagerTransactionUseCase) private readonly processWager: ProcessWagerTransactionUseCase,
    @Inject(WageringQueries) private readonly queries: WageringQueries,
  ) {}

  @Post('wagering/transactions')
  async submit(
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
  ): Promise<WagerResult> {
    if (!idempotencyKey || idempotencyKey.trim().length === 0) {
      throw new ValidationError('IDEMPOTENCY_KEY_REQUIRED', 'Idempotency-Key header is required');
    }
    if (idempotencyKey.length > 256) {
      throw new ValidationError('VALIDATION_ERROR', 'Idempotency-Key must be at most 256 characters');
    }
    const payload = parseBody(wagerPayloadSchema, body);
    enrichContext({ walletId: payload.walletId, providerId: payload.providerId });
    const correlationId = currentContext().correlationId ?? idempotencyKey;
    const outcome = await withSpan('http.wagering.submit', { 'wager.kind': payload.kind }, () =>
      this.processWager.execute({ idempotencyKey, payload, source: 'http', correlationId, causationId: idempotencyKey }),
    );
    if (outcome.type !== 'completed') {
      // Only queue deliveries can be inbox duplicates.
      throw new Error('unexpected duplicate_message outcome on HTTP');
    }
    enrichContext({ transactionId: outcome.result.transactionId });
    res.status(statusForResult(outcome.result));
    return outcome.result;
  }

  @Get('wagering/transactions/:transactionId')
  async getById(@Param('transactionId') transactionId: string) {
    return this.queries.getById(transactionId);
  }

  @Get('providers/:providerId/wagering/transactions/:externalTransactionId')
  async getByExternalId(
    @Param('providerId') providerId: string,
    @Param('externalTransactionId') externalTransactionId: string,
  ) {
    return this.queries.getByExternalId(providerId, externalTransactionId);
  }
}
