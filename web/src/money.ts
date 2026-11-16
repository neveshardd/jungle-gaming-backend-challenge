/**
 * Money helpers for the console. Values are handled as strings only (never JS numbers),
 * mirroring the API contract: a decimal string with exactly 2 decimal places, e.g. "25.00".
 */

/** Same rule the API enforces (src/shared/domain/money.ts): non-negative, no sign/exponent, scale 2, numeric(20,2). */
export const MONEY_REGEX = /^(0|[1-9]\d{0,17})\.\d{2}$/;

/** Max digits typed in the cents mask: 18 integer digits + 2 decimals. */
export const MAX_DIGITS = 20;

/** "2500" (digits typed in the mask) -> "25.00" */
export function digitsToAmount(digits: string): string {
  const clean = digits.replace(/\D/g, '').replace(/^0+/, '').slice(0, MAX_DIGITS);
  const padded = clean.padStart(3, '0');
  return `${padded.slice(0, -2)}.${padded.slice(-2)}`;
}

/** "25.00" -> "2500" (digits for the mask). */
export function amountToDigits(amount: string): string {
  return amount.replace(/\D/g, '').replace(/^0+/, '');
}

/** "1234567.80" -> "1.234.567,80" (pt-BR display). */
export function formatAmount(amount: string): string {
  const [int = '0', frac = '00'] = amount.split('.');
  return `${int.replace(/\B(?=(\d{3})+(?!\d))/g, '.')},${frac.padEnd(2, '0').slice(0, 2)}`;
}

/**
 * Lenient parser for pasted text: "R$ 1.234,5", "1234.56", "25", "25,5" -> canonical "25.50".
 * The LAST "," or "." followed by 1–2 digits is the decimal separator; everything else is grouping.
 * Returns undefined when the text is not a plain amount.
 */
export function parseLooseAmount(text: string): string | undefined {
  const trimmed = text.replace(/R\$|\s/gi, '');
  if (!/^\d[\d.,]*$/.test(trimmed)) return undefined;
  const match = /^(.*?)[.,](\d{1,2})$/.exec(trimmed);
  const intPart = (match ? match[1]! : trimmed).replace(/[.,]/g, '');
  const fracPart = match ? match[2]!.padEnd(2, '0') : '00';
  if (!/^\d+$/.test(intPart || '0')) return undefined;
  const int = (intPart || '0').replace(/^0+(?=\d)/, '');
  const amount = `${int}.${fracPart}`;
  return MONEY_REGEX.test(amount) ? amount : undefined;
}

/** Validation message for an amount, or undefined when valid. */
export function validateAmount(amount: string, { allowZero }: { allowZero: boolean }): string | undefined {
  if (!MONEY_REGEX.test(amount)) return 'Formato inválido: use um valor como 25,00';
  if (!allowZero && /^0\.00$/.test(amount)) return 'O valor precisa ser maior que zero';
  return undefined;
}
