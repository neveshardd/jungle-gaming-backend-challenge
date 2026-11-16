import { AsyncLocalStorage } from 'node:async_hooks';

/** Correlation fields automatically attached to every log line emitted inside the context. */
export interface LogContext {
  correlationId?: string;
  messageId?: string;
  transactionId?: string;
  walletId?: string;
  providerId?: string;
}

const storage = new AsyncLocalStorage<LogContext>();

export function runWithContext<T>(context: LogContext, fn: () => T): T {
  return storage.run({ ...storage.getStore(), ...context }, fn);
}

export function currentContext(): LogContext {
  return storage.getStore() ?? {};
}

/** Adds fields to the current context (e.g. walletId once the payload is parsed). */
export function enrichContext(values: LogContext): void {
  const store = storage.getStore();
  if (!store) return;
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) (store as Record<string, unknown>)[key] = value;
  }
}
