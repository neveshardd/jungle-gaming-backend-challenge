import { Body, Controller, Get, Headers, Inject, Param, Post, Res, UseGuards } from '@nestjs/common';
import { ApiBody, ApiHeader, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { ref } from '../openapi';
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

@ApiTags('wagering')
@Controller()
@UseGuards(ProviderAuthGuard)
export class WageringController {
  constructor(
    @Inject(ProcessWagerTransactionUseCase) private readonly processWager: ProcessWagerTransactionUseCase,
    @Inject(WageringQueries) private readonly queries: WageringQueries,
  ) {}

  @Post('wagering/transactions')
  @ApiOperation({
    summary: 'Submeter transação de aposta',
    description:
      'Mesmo caso de uso do consumidor SQS. Mesma Idempotency-Key + mesmo payload = replay (resultado e saldo originais). ' +
      'Mesma chave + payload diferente = 409. REFUND/ROLLBACK antes da referência = 202 PENDING_REFERENCE.',
  })
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    description: 'Fonte da verdade da idempotência. Padrão recomendado: {providerId}:{externalTransactionId}',
    example: 'provider-a:transaction-123',
  })
  @ApiBody({ schema: ref('WagerRequest') })
  @ApiResponse({ status: 201, description: 'PROCESSED', schema: ref('WagerResult') })
  @ApiResponse({ status: 200, description: 'Replay idempotente (idempotentReplay: true)', schema: ref('WagerResult') })
  @ApiResponse({ status: 202, description: 'PENDING_REFERENCE: aguardando a transação referenciada', schema: ref('WagerResult') })
  @ApiResponse({ status: 400, description: 'Payload inválido, Money inválido, kind não permitido, chave ausente', schema: ref('Error') })
  @ApiResponse({ status: 404, description: 'WALLET_NOT_FOUND', schema: ref('Error') })
  @ApiResponse({ status: 409, description: 'IDEMPOTENCY_CONFLICT / EXTERNAL_ID_CONFLICT', schema: ref('Error') })
  @ApiResponse({ status: 422, description: 'REJECTED (persistida) com failureCode', schema: ref('WagerResult') })
  @ApiResponse({ status: 503, description: 'Falha transitória: reenviar com a mesma chave', schema: ref('Error') })
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
  @ApiOperation({ summary: 'Consultar transação pelo id interno' })
  @ApiParam({ name: 'transactionId', description: 'Id interno (UUID)' })
  @ApiResponse({ status: 200, schema: ref('WagerTransaction') })
  @ApiResponse({ status: 404, description: 'TRANSACTION_NOT_FOUND', schema: ref('Error') })
  async getById(@Param('transactionId') transactionId: string) {
    return this.queries.getById(transactionId);
  }

  @Get('providers/:providerId/wagering/transactions/:externalTransactionId')
  @ApiOperation({ summary: 'Consultar transação pelo id do provedor' })
  @ApiParam({ name: 'providerId', example: 'provider-a' })
  @ApiParam({ name: 'externalTransactionId', example: 'transaction-123' })
  @ApiResponse({ status: 200, schema: ref('WagerTransaction') })
  @ApiResponse({ status: 404, description: 'TRANSACTION_NOT_FOUND', schema: ref('Error') })
  async getByExternalId(
    @Param('providerId') providerId: string,
    @Param('externalTransactionId') externalTransactionId: string,
  ) {
    return this.queries.getByExternalId(providerId, externalTransactionId);
  }
}
