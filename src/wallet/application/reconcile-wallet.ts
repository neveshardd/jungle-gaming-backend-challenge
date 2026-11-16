import { NotFoundError } from '../../shared/application/errors';
import type { Logger } from '../../shared/application/logger';
import type { AppMetrics } from '../../shared/application/metrics';
import type { UnitOfWork } from '../../shared/application/unit-of-work';
import { isUuid } from '../../shared/domain/ids';
import { Money, type MoneyProps } from '../../shared/domain/money';

export interface ReconciliationReport {
  walletId: string;
  storedBalance: MoneyProps;
  calculatedBalance: MoneyProps;
  difference: MoneyProps;
  consistent: boolean;
  checkedEntries: number;
  /** Extra diagnostics beyond the required fields. */
  checks: {
    balanceMatchesLedgerSum: boolean;
    balanceMatchesLastEntry: boolean;
    ledgerChainIntact: boolean;
    versionMatchesMovements: boolean;
  };
}

/**
 * Rebuilds the balance from the ledger and compares it with the materialized balance.
 * Never corrects anything: divergences are logged (error), counted in a metric and
 * flagged in the response. Runs in a REPEATABLE READ snapshot so wallet and ledger are
 * read consistently while other writers keep going.
 */
export class ReconcileWalletUseCase {
  constructor(private readonly deps: { uow: UnitOfWork; metrics: AppMetrics; logger: Logger }) {}

  async execute(walletId: string): Promise<ReconciliationReport> {
    if (!isUuid(walletId)) throw new NotFoundError('WALLET_NOT_FOUND', 'wallet not found');
    const report = await this.deps.uow.run(
      async (r) => {
        const wallet = await r.wallets.findById(walletId);
        if (!wallet) throw new NotFoundError('WALLET_NOT_FOUND', 'wallet not found');
        const summary = await r.ledger.summarize(walletId);
        const stored = wallet.balance;
        const calculated = Money.rehydrate(summary.netAmount, wallet.currency);
        const difference = stored.subtract(calculated);
        const lastAfter =
          summary.lastBalanceAfter !== undefined
            ? Money.rehydrate(summary.lastBalanceAfter, wallet.currency)
            : Money.zero(wallet.currency);
        const checks = {
          balanceMatchesLedgerSum: difference.isZero(),
          balanceMatchesLastEntry: lastAfter.equals(stored),
          ledgerChainIntact: summary.chainBreaks === 0,
          versionMatchesMovements: wallet.version === 1 + summary.balanceMovements,
        };
        const result: ReconciliationReport = {
          walletId,
          storedBalance: stored.toJSON(),
          calculatedBalance: calculated.toJSON(),
          difference: difference.toJSON(),
          consistent: Object.values(checks).every(Boolean),
          checkedEntries: summary.entries,
          checks,
        };
        return result;
      },
      { isolation: 'repeatable_read', label: 'reconcile-wallet' },
    );

    this.deps.metrics.reconciliationChecked(report.consistent);
    if (report.consistent) {
      this.deps.logger.info({ walletId, checkedEntries: report.checkedEntries }, 'wallet reconciliation consistent');
    } else {
      // Amounts deliberately omitted from logs; the response and the ledger carry them.
      this.deps.logger.error({ walletId, checks: report.checks }, 'wallet reconciliation DIVERGENCE');
    }
    return report;
  }
}
