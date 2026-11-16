import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query, UseGuards } from '@nestjs/common';
import { z } from 'zod';
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
  async get(@Param('walletId') walletId: string) {
    enrichContext({ walletId });
    return this.queries.getWallet(walletId);
  }

  @Get(':walletId/ledger')
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
  async reconciliation(@Param('walletId') walletId: string) {
    enrichContext({ walletId });
    return withSpan('http.wallets.reconcile', {}, () => this.reconcile.execute(walletId));
  }
}
