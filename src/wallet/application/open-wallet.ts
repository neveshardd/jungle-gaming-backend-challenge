import { OutboxMessage } from '../../messaging/domain/outbox-message';
import { WagerTransactionProcessed, WalletBalanceChanged } from '../../messaging/domain/wagering-events';
import { ConflictError } from '../../shared/application/errors';
import type { Logger } from '../../shared/application/logger';
import type { UnitOfWork } from '../../shared/application/unit-of-work';
import type { Clock } from '../../shared/domain/clock';
import type { IdGenerator } from '../../shared/domain/ids';
import { Money, type MoneyProps } from '../../shared/domain/money';
import { hashWagerPayload } from '../../wagering/domain/payload-hash';
import { WagerTransaction } from '../../wagering/domain/wager-transaction';
import { WagerTransactionKind } from '../../wagering/domain/wager-transaction-kind';
import { Wallet } from '../domain/wallet';
import { toWalletView, type WalletView } from './wallet-views';

export interface OpenWalletCommand {
  playerId: string;
  initialBalance: MoneyProps;
  correlationId: string;
}

export const INTERNAL_PROVIDER_ID = 'internal';

/**
 * Creates the wallet and — when the initial balance is positive — the internal OPENING
 * transaction, its CREDIT ledger entry and the outbox events, all in one SQL transaction.
 */
export class OpenWalletUseCase {
  constructor(
    private readonly deps: { uow: UnitOfWork; ids: IdGenerator; clock: Clock; logger: Logger },
  ) {}

  async execute(cmd: OpenWalletCommand): Promise<WalletView> {
    const initialBalance = Money.from(cmd.initialBalance);
    const wallet = await this.deps.uow.run(
      async (r) => {
        const now = this.deps.clock.now();
        const walletId = this.deps.ids.next();
        const opening = initialBalance.isPositive()
          ? { transactionId: this.deps.ids.next(), entryId: this.deps.ids.next() }
          : undefined;
        const { wallet, openingEntry } = Wallet.open({
          id: walletId,
          playerId: cmd.playerId,
          initialBalance,
          at: now,
          opening,
        });

        if (!(await r.wallets.insertIfAbsent(wallet))) {
          throw new ConflictError(
            'WALLET_ALREADY_EXISTS',
            `player ${cmd.playerId} already has a ${initialBalance.currency} wallet`,
          );
        }

        if (openingEntry && opening) {
          const externalTransactionId = `opening:${walletId}`;
          const payload = {
            providerId: INTERNAL_PROVIDER_ID,
            externalTransactionId,
            playerId: cmd.playerId,
            walletId,
            roundId: externalTransactionId,
            gameId: INTERNAL_PROVIDER_ID,
            kind: WagerTransactionKind.Opening,
            money: initialBalance.toJSON(),
          };
          const tx = WagerTransaction.createOpening({
            id: opening.transactionId,
            ...payload,
            idempotencyKey: `${INTERNAL_PROVIDER_ID}:${externalTransactionId}`,
            payloadHash: hashWagerPayload(payload),
            money: initialBalance,
            createdAt: now,
          });
          tx.markProcessed(undefined, now, wallet.balance);
          await r.transactions.insertIfAbsent(tx);
          await r.ledger.append(openingEntry);
          const ctx = { correlationId: cmd.correlationId, causationId: walletId, occurredAt: now, ids: this.deps.ids };
          await r.outbox.enqueue([
            OutboxMessage.enqueue(WagerTransactionProcessed.from(tx, ctx)),
            OutboxMessage.enqueue(WalletBalanceChanged.from(wallet, openingEntry, ctx)),
          ]);
        }
        return wallet;
      },
      { label: 'open-wallet' },
    );
    this.deps.logger.info({ walletId: wallet.id, currency: wallet.currency }, 'wallet opened');
    return toWalletView(wallet);
  }
}
