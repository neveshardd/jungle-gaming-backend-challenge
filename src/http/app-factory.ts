import { type INestApplication, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Container } from '../bootstrap/container';
import type { AppRole } from '../config/config';
import { HealthCheck } from '../infrastructure/health/health-check';
import { NestLoggerAdapter } from '../observability/logger';
import { PrometheusMetrics } from '../observability/metrics';
import { ProcessWagerTransactionUseCase } from '../wagering/application/process-wager-transaction';
import { WageringQueries } from '../wagering/application/wagering-queries';
import { OpenWalletUseCase } from '../wallet/application/open-wallet';
import { ReconcileWalletUseCase } from '../wallet/application/reconcile-wallet';
import { WalletQueries } from '../wallet/application/wallet-queries';
import { PROVIDER_IDENTITY, ProviderAuthGuard, TrustAllProviderIdentity } from './auth/provider-auth.guard';
import { HealthController } from './controllers/health.controller';
import { WageringController } from './controllers/wagering.controller';
import { WalletsController } from './controllers/wallets.controller';
import { HttpErrorFilter } from './http-error.filter';
import { correlationMiddleware, jsonBodyMiddleware } from './middleware';

/** Builds the Nest module around an already-wired container. Worker-only instances expose only health/metrics. */
function buildModule(container: Container, role: AppRole) {
  const businessControllers = role === 'worker' ? [] : [WalletsController, WageringController];

  @Module({
    controllers: [HealthController, ...businessControllers],
    providers: [
      { provide: ProcessWagerTransactionUseCase, useValue: container.processWager },
      { provide: OpenWalletUseCase, useValue: container.openWallet },
      { provide: WalletQueries, useValue: container.walletQueries },
      { provide: WageringQueries, useValue: container.wageringQueries },
      { provide: ReconcileWalletUseCase, useValue: container.reconcileWallet },
      { provide: HealthCheck, useValue: container.health },
      { provide: PrometheusMetrics, useValue: container.metrics },
      { provide: PROVIDER_IDENTITY, useValue: new TrustAllProviderIdentity() },
      ProviderAuthGuard,
    ],
  })
  class AppModule {}

  return AppModule;
}

export async function createHttpApp(container: Container, role: AppRole): Promise<INestApplication> {
  const app = await NestFactory.create<NestExpressApplication>(buildModule(container, role), {
    bodyParser: false,
    abortOnError: false,
    logger: new NestLoggerAdapter(container.logger),
  });
  app.use(correlationMiddleware(container.logger));
  app.use(jsonBodyMiddleware);
  app.useGlobalFilters(new HttpErrorFilter(container.logger));
  app.getHttpAdapter().getInstance().disable('x-powered-by');
  return app;
}
