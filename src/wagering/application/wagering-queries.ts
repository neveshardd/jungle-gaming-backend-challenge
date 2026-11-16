import { NotFoundError } from '../../shared/application/errors';
import type { UnitOfWork } from '../../shared/application/unit-of-work';
import { isUuid } from '../../shared/domain/ids';
import { toWagerTransactionView, type WagerTransactionView } from './wager-views';

export class WageringQueries {
  constructor(private readonly uow: UnitOfWork) {}

  async getById(transactionId: string): Promise<WagerTransactionView> {
    if (!isUuid(transactionId)) throw new NotFoundError('TRANSACTION_NOT_FOUND', 'transaction not found');
    const tx = await this.uow.read((r) => r.transactions.findById(transactionId));
    if (!tx) throw new NotFoundError('TRANSACTION_NOT_FOUND', 'transaction not found');
    return toWagerTransactionView(tx);
  }

  async getByExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransactionView> {
    const tx = await this.uow.read((r) => r.transactions.findByExternalId(providerId, externalTransactionId));
    if (!tx) throw new NotFoundError('TRANSACTION_NOT_FOUND', 'transaction not found');
    return toWagerTransactionView(tx);
  }
}
