import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBody, ApiOperation, ApiParam, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { ref } from '../openapi';
import { currentContext, enrichContext } from '../../observability/context';
import { withSpan } from '../../observability/tracing';
import { ValidationError } from '../../shared/application/errors';
import { OpenWalletUseCase } from '../../wallet/application/open-wallet';
import { ReconcileWalletUseCase } from '../../wallet/application/reconcile-wallet';
import { DEFAULT_LEDGER_PAGE, WalletQueries } from '../../wallet/application/wallet-queries';
import { ProviderAuthGuard } from '../auth/provider-auth.guard';
import { parseBody } from '../validation';

const createWalletSchema = z.object({
  playerId: z.string().min(1).max(128),
  initialBalance: z.object({ amount: z.string(), currency: z.string() }),
});

const walletIdParam = { name: 'walletId', description: 'Wallet id (UUID)', example: '0192f291-27dd-7d3f-8071-5f8685deef37' };

@ApiTags('wallets')
@Controller('wallets')
@UseGuards(ProviderAuthGuard)
export class WalletsController {
  constructor(
    @Inject(OpenWalletUseCase) private readonly openWallet: OpenWalletUseCase,
    @Inject(WalletQueries) private readonly queries: WalletQueries,
    @Inject(ReconcileWalletUseCase) private readonly reconcile: ReconcileWalletUseCase,
  ) {}

  @Post()
  @HttpCode(201)
  @ApiOperation({
    summary: 'Criar wallet',
    description:
      'Saldo inicial > 0 gera uma transação interna OPENING com lançamento CREDIT, na mesma transação SQL. version inicia em 1.',
  })
  @ApiBody({ schema: ref('CreateWalletRequest') })
  @ApiResponse({ status: 201, description: 'Wallet criada', schema: ref('CreateWalletResponse') })
  @ApiResponse({ status: 400, description: 'Payload ou Money inválido', schema: ref('Error') })
  @ApiResponse({ status: 409, description: 'WALLET_ALREADY_EXISTS (mesmo playerId + currency)', schema: ref('Error') })
  async create(@Body() body: unknown) {
    const input = parseBody(createWalletSchema, body);
    const wallet = await withSpan('http.wallets.create', {}, () =>
      this.openWallet.execute({
        playerId: input.playerId,
        initialBalance: input.initialBalance,
        correlationId: currentContext().correlationId ?? 'unknown',
      }),
    );
    return { id: wallet.id, playerId: wallet.playerId, balance: wallet.balance, version: wallet.version };
  }

  @Get(':walletId')
  @ApiOperation({ summary: 'Consultar wallet' })
  @ApiParam(walletIdParam)
  @ApiResponse({ status: 200, schema: ref('Wallet') })
  @ApiResponse({ status: 404, description: 'WALLET_NOT_FOUND', schema: ref('Error') })
  async get(@Param('walletId') walletId: string) {
    enrichContext({ walletId });
    return this.queries.getWallet(walletId);
  }

  @Get(':walletId/ledger')
  @ApiOperation({ summary: 'Ledger da wallet (paginado por cursor estável e opaco)' })
  @ApiParam(walletIdParam)
  @ApiQuery({ name: 'cursor', required: false, description: 'nextCursor da página anterior' })
  @ApiQuery({ name: 'limit', required: false, description: '1 a 200 (padrão 50)', example: 50 })
  @ApiResponse({ status: 200, schema: ref('LedgerPage') })
  @ApiResponse({ status: 400, description: 'INVALID_CURSOR / limit inválido', schema: ref('Error') })
  @ApiResponse({ status: 404, description: 'WALLET_NOT_FOUND', schema: ref('Error') })
  async ledger(
    @Param('walletId') walletId: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ) {
    enrichContext({ walletId });
    let pageSize = DEFAULT_LEDGER_PAGE;
    if (limit !== undefined) {
      if (!/^\d{1,4}$/.test(limit)) throw new ValidationError('VALIDATION_ERROR', 'limit must be a positive integer');
      pageSize = Number.parseInt(limit, 10);
    }
    return this.queries.getLedger(walletId, cursor || undefined, pageSize);
  }

  @Post(':walletId/reconciliation')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Reconciliar saldo materializado com o ledger',
    description: 'Nunca corrige: divergências são logadas, contadas em métrica e sinalizadas na resposta.',
  })
  @ApiParam(walletIdParam)
  @ApiResponse({ status: 200, schema: ref('Reconciliation') })
  @ApiResponse({ status: 404, description: 'WALLET_NOT_FOUND', schema: ref('Error') })
  async reconciliation(@Param('walletId') walletId: string) {
    enrichContext({ walletId });
    return withSpan('http.wallets.reconcile', {}, () => this.reconcile.execute(walletId));
  }
}
