import { exponentialBackoffMs } from '../../shared/util/async';

export interface ReferenceRetryPolicyProps {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

/**
 * Retry budget for out-of-order references. With the defaults (10 attempts, 2s base,
 * 5 min cap) the total waiting window is ~2+4+8+...+256+300 s ≈ 13.5 minutes, which
 * comfortably covers provider redelivery windows while bounding how long a REFUND or
 * ROLLBACK can stay unresolved.
 */
export class ReferenceRetryPolicy {
  constructor(private readonly props: ReferenceRetryPolicyProps) {
    if (props.maxAttempts < 1) throw new Error('maxAttempts must be >= 1');
  }

  get maxAttempts(): number {
    return this.props.maxAttempts;
  }

  /** `attemptsSoFar` = number of resolution attempts already recorded on the transaction. */
  isExhausted(attemptsSoFar: number): boolean {
    return attemptsSoFar >= this.props.maxAttempts;
  }

  /** When the `attempt`-th (1-based) wait ends. */
  nextAttemptAt(attempt: number, now: Date): Date {
    return new Date(now.getTime() + exponentialBackoffMs(attempt, this.props.baseDelayMs, this.props.maxDelayMs));
  }
}
