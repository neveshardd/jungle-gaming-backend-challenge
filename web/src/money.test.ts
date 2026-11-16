import { describe, expect, it } from 'bun:test';
import { amountToDigits, digitsToAmount, formatAmount, MONEY_REGEX, parseLooseAmount, validateAmount } from './money';

describe('console money mask', () => {
  it('cents mask: typed digits shift in from the right', () => {
    expect(digitsToAmount('')).toBe('0.00');
    expect(digitsToAmount('2')).toBe('0.02');
    expect(digitsToAmount('25')).toBe('0.25');
    expect(digitsToAmount('2500')).toBe('25.00');
    expect(digitsToAmount('000100000')).toBe('1000.00');
    expect(digitsToAmount('99999999999999999999')).toBe('999999999999999999.99');
  });

  it('round-trips with the digits representation', () => {
    expect(amountToDigits('25.00')).toBe('2500');
    expect(digitsToAmount(amountToDigits('1234.56'))).toBe('1234.56');
    expect(digitsToAmount(amountToDigits('0.00').slice(0, -1))).toBe('0.00');
  });

  it('formats in pt-BR', () => {
    expect(formatAmount('0.00')).toBe('0,00');
    expect(formatAmount('25.00')).toBe('25,00');
    expect(formatAmount('1234567.89')).toBe('1.234.567,89');
  });

  it('normalizes pasted values', () => {
    expect(parseLooseAmount('25')).toBe('25.00');
    expect(parseLooseAmount('25,5')).toBe('25.50');
    expect(parseLooseAmount('25.50')).toBe('25.50');
    expect(parseLooseAmount('R$ 1.234,56')).toBe('1234.56');
    expect(parseLooseAmount('1,234.56')).toBe('1234.56');
    expect(parseLooseAmount('1.000')).toBe('1000.00');
    expect(parseLooseAmount('-5,00')).toBeUndefined();
    expect(parseLooseAmount('1e3')).toBeUndefined();
    expect(parseLooseAmount('abc')).toBeUndefined();
  });

  it('validates with the same regex as the API', () => {
    expect(MONEY_REGEX.test('25.00')).toBe(true);
    for (const bad of ['25', '25.0', '25.000', '-1.00', '01.00', '1e3', '']) expect(MONEY_REGEX.test(bad)).toBe(false);
    expect(validateAmount('0.00', { allowZero: true })).toBeUndefined();
    expect(validateAmount('0.00', { allowZero: false })).toBeString();
    expect(validateAmount('25', { allowZero: false })).toBeString();
  });
});
