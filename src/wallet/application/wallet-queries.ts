import { NotFoundError, ValidationError } from '../../shared/application/errors';
import type { UnitOfWork } from '../../shared/application/unit-of-work';
import { isUuid } from '../../shared/domain/ids';
import { toLedgerEntryView, toWalletView, type LedgerEntryView, type WalletView } from './wallet-views';

export const DEFAULT_LEDGER_PAGE = 50;
export const MAX_LEDGER_PAGE = 200;

export interface LedgerPageView {
  walletId: string;
  entries: LedgerEntryView[];
  nextCursor: string | null;
}

/** Opaque, stable cursor: base64url of the last returned ledger sequence (identity column). */
export function encodeCursor(sequence: string): string {
  return Buffer.from(JSON.stringify({ s: sequence }), 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string): string {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { s?: unknown };
    if (typeof parsed.s === 'string' && /^\d{1,19}$/.test(parsed.s)) return parsed.s;
  } catch {
    // fall through
  }
  throw new ValidationError('INVALID_CURSOR', 'cursor is invalid');
}

export class WalletQueries {
  constructor(private readonly uow: UnitOfWork) {}

  async getWallet(walletId: string): Promise<WalletView> {
    if (!isUuid(walletId)) throw new NotFoundError('WALLET_NOT_FOUND', 'wallet not found');
    const wallet = await this.uow.read((r) => r.wallets.findById(walletId));
    if (!wallet) throw new NotFoundError('WALLET_NOT_FOUND', 'wallet not found');
    return toWalletView(wallet);
  }

  async getLedger(walletId: string, cursor: string | undefined, limit = DEFAULT_LEDGER_PAGE): Promise<LedgerPageView> {
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LEDGER_PAGE) {
      throw new ValidationError('VALIDATION_ERROR', `limit must be an integer between 1 and ${MAX_LEDGER_PAGE}`);
    }
    const after = cursor ? decodeCursor(cursor) : undefined;
    await this.getWallet(walletId);
    const items = await this.uow.read((r) => r.ledger.page(walletId, after, limit + 1));
    const page = items.slice(0, limit);
    const last = page[page.length - 1];
    return {
      walletId,
      entries: page.map((item) => toLedgerEntryView(item.entry)),
      nextCursor: items.length > limit && last ? encodeCursor(last.sequence) : null,
    };
  }
}
