import { describe, expect, it } from 'bun:test';
import { canonicalJson } from '../../src/shared/crypto/canonical-json';
import { InvalidMessageStateError } from '../../src/shared/domain/errors';
import { Money } from '../../src/shared/domain/money';
import { InboxMessage } from '../../src/messaging/domain/inbox-message';
import { OutboxMessage } from '../../src/messaging/domain/outbox-message';
import { WagerTransactionProcessed, WalletBalanceChanged } from '../../src/messaging/domain/wagering-events';
import { WagerTransaction } from '../../src/wagering/domain/wager-transaction';
import { WagerTransactionKind } from '../../src/wagering/domain/wager-transaction-kind';
import { Wallet } from '../../src/wallet/domain/wallet';

const at = new Date('2026-07-29T15:00:00.000Z');
let n = 0;
const ids = { next: () => `id-${++n}` };
const ctx = { correlationId: 'corr-1', causationId: 'msg-1', occurredAt: at, ids };

describe('canonicalJson', () => {
  it('sorts keys recursively and drops undefined', () => {
    expect(canonicalJson({ b: 1, a: { d: 'x', c: undefined, b: [2, { z: 1, y: 2 }] } })).toBe(
      '{"a":{"b":[2,{"y":2,"z":1}],"d":"x"},"b":1}',
    );
  });

  it('rejects non-finite numbers', () => {
    expect(() => canonicalJson({ a: Number.NaN })).toThrow();
  });
});

describe('InboxMessage', () => {
  it('is processed once', () => {
    const msg = InboxMessage.receive({ messageId: 'm', consumerName: 'c', payloadHash: 'h', receivedAt: at });
    expect(msg.isProcessed()).toBe(false);
    msg.markProcessed(at);
    expect(msg.isProcessed()).toBe(true);
    expect(() => msg.markProcessed(at)).toThrow(InvalidMessageStateError);
  });
});

describe('Integration events & outbox', () => {
  const { wallet, openingEntry } = Wallet.open({
    id: 'w-1',
    playerId: 'p-1',
    initialBalance: Money.from({ amount: '100.00', currency: 'BRL' }),
    at,
    opening: { transactionId: 't-0', entryId: 'e-0' },
  });

  it('WalletBalanceChanged carries MoneyProps (strings), type and version from the class', () => {
    const event = WalletBalanceChanged.from(wallet, openingEntry!, ctx);
    const json = event.toJSON();
    expect(json.eventType).toBe('WalletBalanceChanged');
    expect(json.version).toBe(1);
    expect(json.occurredAt).toBe('2026-07-29T15:00:00.000Z');
    expect(json.data.balanceAfter).toEqual({ amount: '100.00', currency: 'BRL' });
    expect(json.causationId).toBe('msg-1');
    expect(event.partitionKey).toBe('w-1');
    expect(JSON.parse(JSON.stringify(json))).toEqual(json);
  });

  it('WagerTransactionProcessed requires a processed transaction', () => {
    const tx = WagerTransaction.create({
      id: 't-1',
      providerId: 'provider-a',
      externalTransactionId: 'e-1',
      idempotencyKey: 'provider-a:e-1',
      payloadHash: 'c'.repeat(64),
      walletId: 'w-1',
      playerId: 'p-1',
      roundId: 'r',
      gameId: 'g',
      kind: WagerTransactionKind.Loss,
      money: Money.from({ amount: '5.00', currency: 'BRL' }),
      createdAt: at,
    });
    expect(() => WagerTransactionProcessed.from(tx, ctx)).toThrow();
    tx.markProcessed(undefined, at, wallet.balance);
    const event = WagerTransactionProcessed.from(tx, ctx);
    expect(event.data.kind).toBe('LOSS');
    expect(event.data.balanceAfter.amount).toBe('100.00');
  });

  it('OutboxMessage uses the event id and backs off exponentially', () => {
    const event = WalletBalanceChanged.from(wallet, openingEntry!, ctx);
    const msg = OutboxMessage.enqueue(event);
    expect(msg.id).toBe(event.eventId);
    expect(msg.isPending()).toBe(true);
    expect(msg.isDue(at)).toBe(true);
    msg.scheduleRetry(at, { baseDelayMs: 1000, maxDelayMs: 5000 });
    expect(msg.attempts).toBe(1);
    expect(msg.nextAttemptAt?.getTime()).toBe(at.getTime() + 1000);
    expect(msg.isDue(at)).toBe(false);
    msg.scheduleRetry(at, { baseDelayMs: 1000, maxDelayMs: 5000 });
    msg.scheduleRetry(at, { baseDelayMs: 1000, maxDelayMs: 5000 });
    msg.scheduleRetry(at, { baseDelayMs: 1000, maxDelayMs: 5000 });
    expect(msg.nextAttemptAt?.getTime()).toBe(at.getTime() + 5000);
    msg.markPublished(at);
    expect(msg.isPending()).toBe(false);
    expect(() => msg.markPublished(at)).toThrow(InvalidMessageStateError);
    expect(() => msg.scheduleRetry(at)).toThrow(InvalidMessageStateError);
  });
});
