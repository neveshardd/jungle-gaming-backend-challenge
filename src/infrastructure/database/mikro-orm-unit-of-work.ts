import { IsolationLevel, type Knex, type MikroORM } from '@mikro-orm/postgresql';
import type { Logger } from '../../shared/application/logger';
import type { AppMetrics } from '../../shared/application/metrics';
import type { TransactionalRepositories, UnitOfWork, UnitOfWorkOptions } from '../../shared/application/unit-of-work';
import { exponentialBackoffMs, jittered, sleep } from '../../shared/util/async';
import { withSpan } from '../../observability/tracing';
import { classifyDbError } from './db-errors';
import { createRepositories } from './repositories';
import { SqlExecutor } from './sql-executor';

export interface UnitOfWorkSettings {
  lockTimeoutMs: number;
  statementTimeoutMs: number;
  maxRetries: number;
}

/**
 * UnitOfWork on top of `EntityManager.transactional()`.
 *
 * Strategy: READ COMMITTED + pessimistic row lock on the wallet (SELECT ... FOR NO KEY UPDATE),
 * bounded lock wait (SET LOCAL lock_timeout) and bounded statement time. Lock conflicts,
 * deadlocks and connection failures roll the whole transaction back and re-run it from
 * scratch (bounded retries with jittered backoff). Business/domain errors are never retried.
 */
export class MikroOrmUnitOfWork implements UnitOfWork {
  constructor(
    private readonly orm: MikroORM,
    private readonly settings: UnitOfWorkSettings,
    private readonly metrics: AppMetrics,
    private readonly logger: Logger,
  ) {}

  async run<T>(work: (repos: TransactionalRepositories) => Promise<T>, options: UnitOfWorkOptions = {}): Promise<T> {
    const label = options.label ?? 'transaction';
    const isolationLevel =
      options.isolation === 'repeatable_read' ? IsolationLevel.REPEATABLE_READ : IsolationLevel.READ_COMMITTED;

    for (let attempt = 1; ; attempt++) {
      try {
        return await withSpan(`db.tx.${label}`, { 'db.tx.attempt': attempt }, () =>
          this.orm.em.fork().transactional(
            async (em) => {
              const trx = em.getTransactionContext<Knex.Transaction>();
              if (!trx) throw new Error('MikroORM did not expose a transaction context');
              const sql = new SqlExecutor(trx);
              // Integers interpolated from validated config (SET does not accept bind parameters).
              await sql.execute(`SET LOCAL lock_timeout = '${Math.trunc(this.settings.lockTimeoutMs)}ms'`);
              await sql.execute(`SET LOCAL statement_timeout = '${Math.trunc(this.settings.statementTimeoutMs)}ms'`);
              return work(createRepositories(sql));
            },
            { isolationLevel },
          ),
        );
      } catch (err) {
        const classified = classifyDbError(err);
        if (classified.lockConflict) this.metrics.lockConflict(classified.lockConflict);
        if (classified.transient && attempt <= this.settings.maxRetries) {
          this.metrics.retry('db_transaction');
          const delay = jittered(exponentialBackoffMs(attempt, 25, 500));
          this.logger.warn({ label, attempt, delayMs: delay, reason: errorMessage(err) }, 'retrying transaction');
          await sleep(delay);
          continue;
        }
        throw classified.error;
      }
    }
  }

  async read<T>(work: (repos: TransactionalRepositories) => Promise<T>): Promise<T> {
    try {
      return await work(createRepositories(new SqlExecutor(this.orm.em.getKnex())));
    } catch (err) {
      throw classifyDbError(err).error;
    }
  }

  /** Autocommit executor for infrastructure components (outbox publisher, health check). */
  executor(): SqlExecutor {
    return new SqlExecutor(this.orm.em.getKnex());
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
