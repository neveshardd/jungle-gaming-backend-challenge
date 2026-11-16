import { CurrencyMismatchError, InvalidMoneyError } from './errors';

/** Wire / persistence DTO. `amount` is always a decimal string with scale 2. */
export interface MoneyProps {
  amount: string;
  currency: string;
}

const SCALE = 2;
const SCALE_FACTOR = 10n ** BigInt(SCALE);
/** numeric(20,2) => 18 integer digits. */
const MAX_INTEGER_DIGITS = 18;
const MAX_ABS_MINOR_UNITS = 10n ** BigInt(MAX_INTEGER_DIGITS + SCALE) - 1n;

/**
 * Input contract: non-negative, no sign, no exponent, no whitespace, no leading
 * zeros, exactly two decimal places. "25.00" ok; "25", "25.0", "25.000", "-1.00",
 * "+1.00", "1e3", "NaN", "Infinity", "" and " 1.00" are rejected.
 */
const INPUT_AMOUNT = new RegExp(`^(0|[1-9]\\d{0,${MAX_INTEGER_DIGITS - 1}})\\.\\d{${SCALE}}$`);
/** Persisted values come from numeric(20,2) columns / aggregates and may be signed or unscaled ("0"). */
const PERSISTED_AMOUNT = new RegExp(`^-?\\d{1,${MAX_INTEGER_DIGITS}}(\\.\\d{1,${SCALE}})?$`);
const CURRENCY_CODE = /^[A-Z]{3}$/;

/**
 * Immutable monetary value. Internally represented as an exact integer number of
 * minor units (bigint) — never as a JS `number`. Every operation returns a new instance.
 * There is no implicit rounding anywhere: inputs with more than 2 decimals are rejected
 * and all arithmetic (add/subtract/negate) is exact.
 */
export class Money {
  private constructor(
    private readonly minorUnits: bigint,
    public readonly currency: string,
  ) {
    Object.freeze(this);
  }

  /** Strict factory for external contracts (HTTP / SQS). Rejects negatives. */
  static from(props: MoneyProps): Money {
    if (props === null || typeof props !== 'object') {
      throw new InvalidMoneyError('money must be an object with "amount" and "currency"');
    }
    const { amount, currency } = props as { amount?: unknown; currency?: unknown };
    if (typeof amount !== 'string' || !INPUT_AMOUNT.test(amount)) {
      throw new InvalidMoneyError(
        'amount must be a non-negative decimal string with exactly 2 decimal places (e.g. "25.00")',
      );
    }
    return new Money(Money.parseMinorUnits(amount), Money.assertCurrency(currency));
  }

  /** Rebuilds a value read from persistence (numeric columns, aggregates). Allows sign. */
  static rehydrate(amount: string, currency: string): Money {
    if (typeof amount !== 'string' || !PERSISTED_AMOUNT.test(amount)) {
      throw new InvalidMoneyError(`invalid persisted amount "${String(amount)}"`);
    }
    return new Money(Money.parseMinorUnits(amount), Money.assertCurrency(currency));
  }

  static zero(currency: string): Money {
    return new Money(0n, Money.assertCurrency(currency));
  }

  static ofMinorUnits(minorUnits: bigint, currency: string): Money {
    Money.assertRange(minorUnits);
    return new Money(minorUnits, Money.assertCurrency(currency));
  }

  /** Decimal string with fixed scale 2, e.g. "25.00" or "-3.10". */
  get amount(): string {
    const negative = this.minorUnits < 0n;
    const abs = negative ? -this.minorUnits : this.minorUnits;
    const integer = abs / SCALE_FACTOR;
    const fraction = (abs % SCALE_FACTOR).toString().padStart(SCALE, '0');
    return `${negative ? '-' : ''}${integer.toString()}.${fraction}`;
  }

  toMinorUnits(): bigint {
    return this.minorUnits;
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return Money.ofMinorUnits(this.minorUnits + other.minorUnits, this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return Money.ofMinorUnits(this.minorUnits - other.minorUnits, this.currency);
  }

  negate(): Money {
    return new Money(-this.minorUnits, this.currency);
  }

  isZero(): boolean {
    return this.minorUnits === 0n;
  }

  isPositive(): boolean {
    return this.minorUnits > 0n;
  }

  isNegative(): boolean {
    return this.minorUnits < 0n;
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.minorUnits < other.minorUnits;
  }

  isGreaterThanOrEqual(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.minorUnits >= other.minorUnits;
  }

  /** Value equality. Different currencies are simply not equal (no throw). */
  equals(other: Money): boolean {
    return this.currency === other.currency && this.minorUnits === other.minorUnits;
  }

  toJSON(): MoneyProps {
    return { amount: this.amount, currency: this.currency };
  }

  toString(): string {
    return `${this.amount} ${this.currency}`;
  }

  private assertSameCurrency(other: Money): void {
    if (other.currency !== this.currency) {
      throw new CurrencyMismatchError(`cannot combine ${this.currency} with ${other.currency}`);
    }
  }

  private static assertCurrency(currency: unknown): string {
    if (typeof currency !== 'string' || !CURRENCY_CODE.test(currency)) {
      throw new InvalidMoneyError('currency must be an ISO-4217 code (3 uppercase letters)');
    }
    return currency;
  }

  private static assertRange(minorUnits: bigint): void {
    if (minorUnits > MAX_ABS_MINOR_UNITS || minorUnits < -MAX_ABS_MINOR_UNITS) {
      throw new InvalidMoneyError('amount exceeds the supported precision numeric(20,2)');
    }
  }

  private static parseMinorUnits(value: string): bigint {
    const negative = value.startsWith('-');
    const unsigned = negative ? value.slice(1) : value;
    const [integerPart = '0', fractionPart = ''] = unsigned.split('.');
    const minor = BigInt(integerPart) * SCALE_FACTOR + BigInt(fractionPart.padEnd(SCALE, '0'));
    Money.assertRange(minor);
    return negative ? -minor : minor;
  }
}
