import type { SQSClient } from '@aws-sdk/client-sqs';
import { MikroORM } from '@mikro-orm/postgresql';
import type { AppConfig } from '../config/config';
import { MikroOrmUnitOfWork } from '../infrastructure/database/mikro-orm-unit-of-work';
import { buildOrmConfig } from '../infrastructure/database/mikro-orm.config';
import { PgOutboxStore } from '../infrastructure/database/repositories/pg-outbox.repository';
import { HealthCheck } from '../infrastructure/health/health-check';
import { OutboxPublisher } from '../infrastructure/sqs/outbox-publisher';
import { QueueTopology, type QueueUrls } from '../infrastructure/sqs/queue-topology';
import { createSqsClient } from '../infrastructure/sqs/sqs-client';
import { WagerTransactionConsumer } from '../infrastructure/sqs/wager-transaction-consumer';
import { PendingReferenceWorker } from '../infrastructure/workers/pending-reference-worker';
import { PollingLoop } from '../infrastructure/workers/polling-loop';
import { createLogger } from '../observability/logger';
import { PrometheusMetrics } from '../observability/metrics';
import type { Logger } from '../shared/application/logger';
import type { UnitOfWork } from '../shared/application/unit-of-work';
import { type Clock, SystemClock } from '../shared/domain/clock';
import { type IdGenerator, UuidV7Generator } from '../shared/domain/ids';
import { sleep } from '../shared/util/async';
import { ProcessWagerTransactionUseCase } from '../wagering/application/process-wager-transaction';
import { ResolvePendingReferenceUseCase } from '../wagering/application/resolve-pending-reference';
import { WagerSettlement } from '../wagering/application/wager-settlement';
import { WageringQueries } from '../wagering/application/wagering-queries';
import { ReferenceRetryPolicy } from '../wagering/domain/reference-retry-policy';
import { OpenWalletUseCase } from '../wallet/application/open-wallet';
import { ReconcileWalletUseCase } from '../wallet/application/reconcile-wallet';
import { WalletQueries } from '../wallet/application/wallet-queries';

export interface ContainerOptions {
  clock?: Clock;
  logger?: Logger;
  /** Test hook: decorate the unit of work (fault injection). */
  wrapUnitOfWork?: (uow: UnitOfWork) => UnitOfWork;
}

/**
 * Composition root (plain TypeScript, framework-free). NestJS only wraps the HTTP layer
 * around these objects; tests build the same container to exercise real Postgres and SQS.
 */
export class Container {
  private consumerStarted = false;
  private readonly loops: PollingLoop[] = [];

  private constructor(
    readonly config: AppConfig,
    readonly logger: Logger,
    readonly metrics: PrometheusMetrics,
    readonly orm: MikroORM,
    readonly uow: UnitOfWork,
    readonly baseUow: MikroOrmUnitOfWork,
    readonly sqs: SQSClient,
    readonly queues: QueueUrls,
    readonly clock: Clock,
    readonly ids: IdGenerator,
    readonly processWager: ProcessWagerTransactionUseCase,
    readonly openWallet: OpenWalletUseCase,
    readonly walletQueries: WalletQueries,
    readonly wageringQueries: WageringQueries,
    readonly reconcileWallet: ReconcileWalletUseCase,
    readonly resolvePendingReference: ResolvePendingReferenceUseCase,
    readonly consumer: WagerTransactionConsumer,
    readonly outboxPublisher: OutboxPublisher,
    readonly outboxStore: PgOutboxStore,
    readonly pendingReferenceWorker: PendingReferenceWorker,
    readonly health: HealthCheck,
  ) {}

  static async create(config: AppConfig, options: ContainerOptions = {}): Promise<Container> {
    const logger =
      options.logger ?? createLogger({ level: config.logLevel, service: 'wagering-processor', instanceId: config.instanceId });
    const metrics = new PrometheusMetrics(config.instanceId);
    const clock = options.clock ?? new SystemClock();
    const ids = new UuidV7Generator();

    const orm = await retry('postgres', logger, () =>
      MikroORM.init(buildOrmConfig({ databaseUrl: config.database.url, dbPoolMax: config.database.poolMax })),
    );
    const baseUow = new MikroOrmUnitOfWork(
      orm,
      {
        lockTimeoutMs: config.database.lockTimeoutMs,
        statementTimeoutMs: config.database.statementTimeoutMs,
        maxRetries: config.database.maxRetries,
      },
      metrics,
      logger,
    );
    const uow = options.wrapUnitOfWork ? options.wrapUnitOfWork(baseUow) : baseUow;

    const sqs = createSqsClient(config.aws);
    const topology = new QueueTopology(sqs, config.sqs);
    const queues = await retry('sqs', logger, () => (config.sqs.autoCreate ? topology.ensure() : topology.resolve()));

    const retryPolicy = new ReferenceRetryPolicy({
      maxAttempts: config.pendingReference.maxAttempts,
      baseDelayMs: config.pendingReference.baseDelayMs,
      maxDelayMs: config.pendingReference.maxDelayMs,
    });
    const settlement = new WagerSettlement(ids, retryPolicy);
    const processWager = new ProcessWagerTransactionUseCase({ uow, settlement, ids, clock, metrics, logger });
    const openWallet = new OpenWalletUseCase({ uow, ids, clock, logger });
    const walletQueries = new WalletQueries(uow);
    const wageringQueries = new WageringQueries(uow);
    const reconcileWallet = new ReconcileWalletUseCase({ uow, metrics, logger });
    const resolvePendingReference = new ResolvePendingReferenceUseCase({ uow, settlement, clock, ids, metrics, logger });

    const consumer = new WagerTransactionConsumer({
      sqs,
      queues,
      config: config.sqs,
      faults: config.faults,
      useCase: processWager,
      metrics,
      logger,
    });
    const outboxStore = new PgOutboxStore(baseUow.executor());
    const outboxPublisher = new OutboxPublisher({
      store: outboxStore,
      sqs,
      queueUrl: queues.events,
      owner: config.instanceId,
      config: config.outbox,
      clock,
      metrics,
      logger,
    });
    const pendingReferenceWorker = new PendingReferenceWorker({
      uow,
      resolver: resolvePendingReference,
      config: config.pendingReference,
      logger,
    });
    const health = new HealthCheck(baseUow.executor(), sqs, queues.input);

    return new Container(
      config,
      logger,
      metrics,
      orm,
      uow,
      baseUow,
      sqs,
      queues,
      clock,
      ids,
      processWager,
      openWallet,
      walletQueries,
      wageringQueries,
      reconcileWallet,
      resolvePendingReference,
      consumer,
      outboxPublisher,
      outboxStore,
      pendingReferenceWorker,
      health,
    );
  }

  /** Background work of the `worker` role: SQS consumer, outbox publisher, pending-reference worker. */
  startWorkers(parts: { consumer?: boolean; outbox?: boolean; pendingReferences?: boolean; outboxMonitor?: boolean } = {}): void {
    const { consumer = true, outbox = true, pendingReferences = true, outboxMonitor = true } = parts;
    if (consumer) {
      this.consumer.start();
      this.consumerStarted = true;
    }
    if (outbox) {
      this.addLoop('outbox-publisher', this.config.outbox.pollIntervalMs, () => this.outboxPublisher.publishOnce());
    }
    if (pendingReferences) {
      this.addLoop('pending-reference-worker', this.config.pendingReference.pollIntervalMs, () =>
        this.pendingReferenceWorker.runOnce(),
      );
    }
    if (outboxMonitor) {
      this.addLoop('outbox-monitor', 5000, async () => {
        const stats = await this.outboxStore.stats();
        this.metrics.outboxState(stats.pending, stats.oldestAgeSeconds);
        return false;
      });
    }
  }

  async stopWorkers(graceMs = this.config.shutdownGraceMs): Promise<void> {
    if (this.consumerStarted) await this.consumer.stop(graceMs);
    this.consumerStarted = false;
    await Promise.all(this.loops.splice(0).map((loop) => loop.stop()));
  }

  async close(): Promise<void> {
    await this.stopWorkers();
    this.sqs.destroy();
    await this.orm.close(true);
  }

  private addLoop(name: string, intervalMs: number, tick: () => Promise<boolean>): void {
    const loop = new PollingLoop(name, intervalMs, tick, this.logger);
    loop.start();
    this.loops.push(loop);
  }
}

/** Startup dependency retry: Postgres/SQS may be temporarily unavailable when the process boots. */
async function retry<T>(name: string, logger: Logger, fn: () => Promise<T>, attempts = 30): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= attempts) throw err;
      logger.warn({ dependency: name, attempt, reason: err instanceof Error ? err.message : String(err) }, 'dependency not ready; retrying');
      await sleep(Math.min(5000, 250 * attempt));
    }
  }
}
