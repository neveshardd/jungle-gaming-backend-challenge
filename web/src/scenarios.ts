import { api, isError, newExternalId, sleep, type WagerPayload, type WagerResult, type Wallet } from './api';

export interface ScenarioResult {
  passed: boolean;
  steps: string[];
  wallet?: Wallet;
}

export interface Scenario {
  id: string;
  title: string;
  description: string;
  run: () => Promise<ScenarioResult>;
}

async function wallet(amount: string): Promise<Wallet> {
  const res = await api.createWallet(crypto.randomUUID(), amount);
  if (isError(res.body)) throw new Error(`falha ao criar wallet: ${res.body.code}`);
  return res.body;
}

function wager(w: Wallet, kind: string, amount: string, extra: Partial<WagerPayload> = {}) {
  const externalTransactionId = extra.externalTransactionId ?? newExternalId(kind.toLowerCase());
  const payload: WagerPayload = {
    providerId: 'provider-a',
    externalTransactionId,
    playerId: w.playerId,
    walletId: w.id,
    roundId: 'round-1',
    gameId: 'fortune-chimp',
    kind,
    money: { amount, currency: 'BRL' },
    ...extra,
  };
  return { key: `provider-a:${externalTransactionId}`, payload };
}

async function balanceOf(w: Wallet): Promise<Wallet> {
  const res = await api.getWallet(w.id, true);
  if (isError(res.body)) throw new Error(res.body.code);
  return res.body;
}

async function debitCount(w: Wallet): Promise<number> {
  const res = await api.getLedger(w.id, undefined, 200);
  return isError(res.body) ? -1 : res.body.entries.filter((e) => e.direction === 'DEBIT').length;
}

const result = (r: { body: unknown }) => r.body as WagerResult;

export const SCENARIOS: Scenario[] = [
  {
    id: 'race',
    title: 'Duas apostas de 80 em paralelo',
    description: 'Saldo 100,00 e duas BETs de 80,00 simultâneas: uma PROCESSED, outra REJECTED, saldo 20,00, um débito.',
    run: async () => {
      const w = await wallet('100.00');
      const [a, b] = await Promise.all([
        api.submitWager(...args(wager(w, 'BET', '80.00'))),
        api.submitWager(...args(wager(w, 'BET', '80.00'))),
      ]);
      const after = await balanceOf(w);
      const debits = await debitCount(w);
      const statuses = [a.status, b.status].sort();
      return {
        wallet: after,
        passed: statuses[0] === 201 && statuses[1] === 422 && after.balance.amount === '20.00' && debits === 1,
        steps: [
          `respostas: ${a.status} ${result(a).status ?? ''} ${result(a).failureCode ?? ''} | ${b.status} ${result(b).status ?? ''} ${result(b).failureCode ?? ''}`,
          `saldo final: ${after.balance.amount} (esperado 20.00)`,
          `débitos no ledger: ${debits} (esperado 1)`,
        ],
      };
    },
  },
  {
    id: 'same50',
    title: 'Mesma aposta 50× em paralelo',
    description: '50 envios simultâneos com a mesma Idempotency-Key: 1 × 201 e 49 × 200 (replay), um único débito.',
    run: async () => {
      const w = await wallet('1000.00');
      const request = wager(w, 'BET', '25.00');
      const responses = await Promise.all(Array.from({ length: 50 }, () => api.submitWager(...args(request))));
      const created = responses.filter((r) => r.status === 201).length;
      const replays = responses.filter((r) => r.status === 200).length;
      const ids = new Set(responses.map((r) => result(r).transactionId));
      const after = await balanceOf(w);
      const debits = await debitCount(w);
      return {
        wallet: after,
        passed: created === 1 && replays === 49 && ids.size === 1 && debits === 1 && after.balance.amount === '975.00',
        steps: [
          `201: ${created} · 200 (replay): ${replays} · transactionIds distintos: ${ids.size}`,
          `saldo final: ${after.balance.amount} (esperado 975.00)`,
          `débitos no ledger: ${debits} (esperado 1)`,
        ],
      };
    },
  },
  {
    id: 'conflict',
    title: 'Mesma chave, payload diferente',
    description: 'Reenviar a mesma Idempotency-Key com outro valor é conflito (409), não replay.',
    run: async () => {
      const w = await wallet('100.00');
      const request = wager(w, 'BET', '10.00');
      const first = await api.submitWager(...args(request));
      const replay = await api.submitWager(...args(request));
      const conflict = await api.submitWager(request.key, { ...request.payload, money: { amount: '11.00', currency: 'BRL' } });
      const code = isError(conflict.body) ? conflict.body.code : '';
      return {
        wallet: await balanceOf(w),
        passed: first.status === 201 && replay.status === 200 && conflict.status === 409 && code === 'IDEMPOTENCY_CONFLICT',
        steps: [
          `1º envio: ${first.status}`,
          `mesmo payload: ${replay.status} (idempotentReplay ${String(result(replay).idempotentReplay)})`,
          `valor alterado: ${conflict.status} ${code}`,
        ],
      };
    },
  },
  {
    id: 'outoforder',
    title: 'REFUND antes da BET',
    description: 'A reversão chega primeiro (202 PENDING_REFERENCE) e é resolvida pelo worker quando a BET chega.',
    run: async () => {
      const w = await wallet('100.00');
      const bet = wager(w, 'BET', '40.00');
      const refund = wager(w, 'REFUND', '40.00', { referenceExternalTransactionId: bet.payload.externalTransactionId });
      const r1 = await api.submitWager(...args(refund));
      const r2 = await api.submitWager(...args(bet));
      let final = '';
      for (let i = 0; i < 30 && final !== 'PROCESSED'; i++) {
        await sleep(500);
        const q = await api.getByExternalId('provider-a', refund.payload.externalTransactionId, true);
        final = isError(q.body) ? '' : q.body.status;
      }
      const after = await balanceOf(w);
      return {
        wallet: after,
        passed: r1.status === 202 && r2.status === 201 && final === 'PROCESSED' && after.balance.amount === '100.00',
        steps: [
          `REFUND enviado antes: ${r1.status} ${result(r1).status}`,
          `BET: ${r2.status} ${result(r2).status}`,
          `REFUND depois do worker: ${final || 'ainda pendente'}`,
          `saldo final: ${after.balance.amount} (esperado 100.00)`,
        ],
      };
    },
  },
  {
    id: 'overdraw',
    title: 'ROLLBACK de WIN sem saldo',
    description: 'Reverter um WIN já gasto é rejeitado com REVERSAL_WOULD_OVERDRAW (diferente de INSUFFICIENT_FUNDS).',
    run: async () => {
      const w = await wallet('10.00');
      const win = wager(w, 'WIN', '100.00');
      await api.submitWager(...args(win));
      await api.submitWager(...args(wager(w, 'BET', '105.00')));
      const rb = await api.submitWager(
        ...args(wager(w, 'ROLLBACK', '100.00', { referenceExternalTransactionId: win.payload.externalTransactionId })),
      );
      const after = await balanceOf(w);
      return {
        wallet: after,
        passed: rb.status === 422 && result(rb).failureCode === 'REVERSAL_WOULD_OVERDRAW' && after.balance.amount === '5.00',
        steps: [`ROLLBACK: ${rb.status} ${result(rb).failureCode ?? ''}`, `saldo intacto: ${after.balance.amount} (esperado 5.00)`],
      };
    },
  },
  {
    id: 'double-reversal',
    title: 'REFUND e ROLLBACK da mesma BET',
    description: 'Uma transação só pode ser revertida uma vez: a segunda reversão vira ALREADY_REVERSED.',
    run: async () => {
      const w = await wallet('100.00');
      const bet = wager(w, 'BET', '30.00');
      await api.submitWager(...args(bet));
      const ref = { referenceExternalTransactionId: bet.payload.externalTransactionId };
      const [a, b] = await Promise.all([
        api.submitWager(...args(wager(w, 'REFUND', '30.00', ref))),
        api.submitWager(...args(wager(w, 'ROLLBACK', '30.00', ref))),
      ]);
      const after = await balanceOf(w);
      const codes = [result(a).failureCode, result(b).failureCode].filter(Boolean);
      return {
        wallet: after,
        passed: [a.status, b.status].sort().join() === '201,422' && codes[0] === 'ALREADY_REVERSED' && after.balance.amount === '100.00',
        steps: [`respostas: ${a.status} / ${b.status} ${codes.join(' ')}`, `saldo final: ${after.balance.amount} (esperado 100.00)`],
      };
    },
  },
];

function args(r: { key: string; payload: WagerPayload }): [string, WagerPayload] {
  return [r.key, r.payload];
}
