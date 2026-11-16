import { describe, expect, it } from 'bun:test';
import { CurrencyMismatchError, InvalidMoneyError } from '../../src/shared/domain/errors';
import { Money } from '../../src/shared/domain/money';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });

describe('Money', () => {
  describe('input validation (Money.from)', () => {
    it.each(['0.00', '0.01', '25.00', '1000.00', '999999999999999999.99'])('accepts %p', (amount) => {
      expect(brl(amount).amount).toBe(amount);
    });

    it.each([
      ['', 'empty string'],
      ['25', 'no decimals'],
      ['25.0', 'one decimal'],
      ['25.000', 'three decimals (no implicit rounding)'],
      ['25.005', 'sub-cent precision'],
      ['-1.00', 'negative'],
      ['+1.00', 'explicit plus sign'],
      ['1e3', 'scientific notation'],
      ['1.00e2', 'scientific notation with decimals'],
      ['NaN', 'NaN'],
      ['Infinity', 'Infinity'],
      ['-Infinity', '-Infinity'],
      [' 1.00', 'leading whitespace'],
      ['1.00 ', 'trailing whitespace'],
      ['01.00', 'leading zero'],
      ['1,00', 'comma separator'],
      ['.50', 'missing integer part'],
      ['0x10.00', 'hex'],
      ['1000000000000000000.00', 'exceeds numeric(20,2)'],
    ])('rejects %p (%s)', (amount) => {
      expect(() => brl(amount)).toThrow(InvalidMoneyError);
    });

    it.each([25, 25.5, null, undefined, {}, true])('rejects non-string amount %p', (amount) => {
      expect(() => Money.from({ amount: amount as unknown as string, currency: 'BRL' })).toThrow(InvalidMoneyError);
    });

    it.each(['', 'brl', 'BR', 'BRLL', 'R$', '123'])('rejects invalid currency %p', (currency) => {
      expect(() => Money.from({ amount: '1.00', currency })).toThrow(InvalidMoneyError);
    });

    it('rejects a non-object', () => {
      expect(() => Money.from(null as unknown as { amount: string; currency: string })).toThrow(InvalidMoneyError);
    });
  });

  describe('arithmetic is exact (no float drift, no rounding)', () => {
    it('0.10 + 0.20 === 0.30', () => {
      expect(brl('0.10').add(brl('0.20')).equals(brl('0.30'))).toBe(true);
    });

    it('adds and subtracts with fixed scale', () => {
      expect(brl('1000.00').subtract(brl('25.00')).amount).toBe('975.00');
      expect(brl('0.01').add(brl('0.99')).amount).toBe('1.00');
      expect(brl('20.00').subtract(brl('80.00')).amount).toBe('-60.00');
    });

    it('handles the largest supported values exactly', () => {
      const big = brl('999999999999999999.98');
      expect(big.add(brl('0.01')).amount).toBe('999999999999999999.99');
      expect(() => big.add(brl('0.02'))).toThrow(InvalidMoneyError);
    });

    it('negate', () => {
      expect(brl('5.00').negate().amount).toBe('-5.00');
      expect(brl('0.00').negate().isZero()).toBe(true);
    });

    it('is immutable: operations return new instances', () => {
      const a = brl('10.00');
      const b = a.add(brl('1.00'));
      expect(a.amount).toBe('10.00');
      expect(b).not.toBe(a);
      expect(Object.isFrozen(a)).toBe(true);
    });
  });

  describe('comparisons', () => {
    it('predicates', () => {
      expect(brl('0.00').isZero()).toBe(true);
      expect(brl('0.01').isPositive()).toBe(true);
      expect(brl('0.00').subtract(brl('0.01')).isNegative()).toBe(true);
      expect(brl('1.00').isLessThan(brl('1.01'))).toBe(true);
      expect(brl('1.01').isLessThan(brl('1.01'))).toBe(false);
      expect(brl('1.01').isGreaterThanOrEqual(brl('1.01'))).toBe(true);
    });

    it('equals is false across currencies', () => {
      expect(brl('1.00').equals(Money.from({ amount: '1.00', currency: 'USD' }))).toBe(false);
    });
  });

  describe('currency conflicts', () => {
    const usd = Money.from({ amount: '1.00', currency: 'USD' });
    it.each([
      ['add', () => brl('1.00').add(usd)],
      ['subtract', () => brl('1.00').subtract(usd)],
      ['isLessThan', () => brl('1.00').isLessThan(usd)],
      ['isGreaterThanOrEqual', () => brl('1.00').isGreaterThanOrEqual(usd)],
    ])('%s throws CurrencyMismatchError', (_name, op) => {
      expect(op).toThrow(CurrencyMismatchError);
    });
  });

  describe('serialization', () => {
    it('toJSON uses decimal strings with scale 2', () => {
      expect(JSON.stringify(brl('25.00'))).toBe('{"amount":"25.00","currency":"BRL"}');
    });

    it('toString', () => {
      expect(brl('7.50').toString()).toBe('7.50 BRL');
    });

    it('rehydrates persisted numeric values (signed / unscaled)', () => {
      expect(Money.rehydrate('975.00', 'BRL').amount).toBe('975.00');
      expect(Money.rehydrate('0', 'BRL').amount).toBe('0.00');
      expect(Money.rehydrate('-12.5', 'BRL').amount).toBe('-12.50');
      expect(() => Money.rehydrate('1.001', 'BRL')).toThrow(InvalidMoneyError);
      expect(() => Money.rehydrate('abc', 'BRL')).toThrow(InvalidMoneyError);
    });

    it('zero', () => {
      expect(Money.zero('BRL').toJSON()).toEqual({ amount: '0.00', currency: 'BRL' });
    });

    it('minor units round-trip', () => {
      expect(Money.ofMinorUnits(12345n, 'BRL').amount).toBe('123.45');
      expect(brl('123.45').toMinorUnits()).toBe(12345n);
    });
  });
});
