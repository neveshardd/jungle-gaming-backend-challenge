export interface Money {
  amount: string;
  currency: string;
}

export interface Wallet {
  id: string;
  playerId: string;
  balance: Money;
  version: number;
  createdAt?: string;
  updatedAt?: string;
}

export type WagerKind = 'BET' | 'WIN' | 'LOSS' | 'REFUND' | 'ROLLBACK';

export interface WagerPayload {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: Money;
  referenceExternalTransactionId?: string;
}

export interface WagerResult {
  transactionId: string;
  status: string;
  balance?: Money;
  failureCode?: string;
  idempotentReplay: boolean;
}

export interface ApiError {
  code: string;
  message: string;
  correlationId?: string;
  details?: unknown;
}

export interface LedgerEntry {
  id: string;
  transactionId: string;
  direction: 'DEBIT' | 'CREDIT';
  money: Money;
  balanceBefore: Money;
  balanceAfter: Money;
  createdAt: string;
}

export interface LedgerPage {
  walletId: string;
  entries: LedgerEntry[];
  nextCursor: string | null;
}

export interface Reconciliation {
  walletId: string;
  storedBalance: Money;
  calculatedBalance: Money;
  difference: Money;
  consistent: boolean;
  checkedEntries: number;
  checks: Record<string, boolean>;
}

export interface ApiResponse<T> {
  status: number;
  body: T;
  durationMs: number;
  correlationId: string | null;
}

export interface RequestLog {
  id: number;
  at: Date;
  method: string;
  path: string;
  status: number;
  durationMs: number;
  requestBody?: unknown;
  idempotencyKey?: string;
  responseBody: unknown;
  correlationId: string | null;
}

type Listener = (entry: RequestLog) => void;
const listeners = new Set<Listener>();
let sequence = 0;

/** Subscribe to every request made by the console (activity log). */
export function onRequest(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const BASE = '/api';

async function request<T>(
  method: 'GET' | 'POST',
  path: string,
  options: { body?: unknown; headers?: Record<string, string>; silent?: boolean } = {},
): Promise<ApiResponse<T>> {
  const started = performance.now();
  let status = 0;
  let body: unknown = { code: 'NETWORK_ERROR', message: 'API inacessível — o stack está rodando em localhost:8080?' };
  let correlationId: string | null = null;
  try {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: {
        ...(options.body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...options.headers,
      },
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    });
    status = res.status;
    correlationId = res.headers.get('x-correlation-id');
    const text = await res.text();
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      body = text;
    }
  } catch {
    // network error: keep defaults
  }
  const durationMs = performance.now() - started;
  if (!options.silent) {
    const entry: RequestLog = {
      id: ++sequence,
      at: new Date(),
      method,
      path,
      status,
      durationMs,
      requestBody: options.body,
      idempotencyKey: options.headers?.['Idempotency-Key'],
      responseBody: body,
      correlationId,
    };
    listeners.forEach((l) => l(entry));
  }
  return { status, body: body as T, durationMs, correlationId };
}

export const api = {
  health: () => request<{ status: string; checks: Record<string, { status: string; error?: string }> }>('GET', '/health/ready', { silent: true }),
  createWallet: (playerId: string, amount: string, currency = 'BRL') =>
    request<Wallet | ApiError>('POST', '/wallets', { body: { playerId, initialBalance: { amount, currency } } }),
  getWallet: (id: string, silent = false) => request<Wallet | ApiError>('GET', `/wallets/${id}`, { silent }),
  getLedger: (id: string, cursor?: string, limit = 20) =>
    request<LedgerPage | ApiError>(
      'GET',
      `/wallets/${id}/ledger?limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
      { silent: true },
    ),
  reconcile: (id: string) => request<Reconciliation | ApiError>('POST', `/wallets/${id}/reconciliation`, { body: {} }),
  submitWager: (idempotencyKey: string, payload: WagerPayload) =>
    request<WagerResult | ApiError>('POST', '/wagering/transactions', {
      body: payload,
      headers: { 'Idempotency-Key': idempotencyKey },
    }),
  getByExternalId: (providerId: string, externalId: string, silent = false) =>
    request<{ status: string; failureCode?: string } | ApiError>(
      'GET',
      `/providers/${encodeURIComponent(providerId)}/wagering/transactions/${encodeURIComponent(externalId)}`,
      { silent },
    ),
};

export function isError(body: unknown): body is ApiError {
  return typeof body === 'object' && body !== null && 'code' in body && 'message' in body;
}

export function newExternalId(prefix = 'tx'): string {
  return `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
