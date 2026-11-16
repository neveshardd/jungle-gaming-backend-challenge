export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Exponential backoff: base * 2^(attempt-1), capped. `attempt` starts at 1. */
export function exponentialBackoffMs(attempt: number, baseMs: number, maxMs: number): number {
  const exponent = Math.max(0, Math.min(attempt - 1, 30));
  return Math.min(maxMs, baseMs * 2 ** exponent);
}

/** "Full jitter" variant used for retries that many workers may hit at once. */
export function jittered(ms: number): number {
  return Math.floor(ms / 2 + Math.random() * (ms / 2));
}

export async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
