import { InputAdornment, TextField, type SxProps, type Theme } from '@mui/material';
import { useRef } from 'react';
import { amountToDigits, digitsToAmount, formatAmount, MAX_DIGITS, parseLooseAmount, validateAmount } from '../money';
import { MONO } from '../theme';

interface Props {
  label: string;
  /** Canonical amount sent to the API, e.g. "25.00". */
  value: string;
  onChange: (amount: string) => void;
  /** Wallet opening balance may be zero; wager amounts may not. */
  allowZero?: boolean;
  helperText?: string;
  sx?: SxProps<Theme>;
}

/**
 * Currency input with a cents mask (bank-app style): every digit typed shifts in from the
 * right, so "2" "5" "0" "0" shows "R$ 25,00" and emits "25.00". Only digits are accepted,
 * paste of "R$ 1.234,56" / "25,5" / "25.50" is normalized, and the value is validated with
 * the same regex as the API before it can be sent.
 */
export function MoneyField({ label, value, onChange, allowZero = false, helperText, sx }: Props) {
  const ref = useRef<HTMLInputElement>(null);
  const error = validateAmount(value, { allowZero });
  const display = formatAmount(value);

  const moveCaretToEnd = () =>
    requestAnimationFrame(() => {
      const el = ref.current;
      if (el) el.setSelectionRange(el.value.length, el.value.length);
    });

  return (
    <TextField
      label={label}
      value={display}
      error={Boolean(error)}
      helperText={error ?? helperText ?? `enviado como "${value}"`}
      sx={sx}
      inputRef={ref}
      onFocus={moveCaretToEnd}
      onClick={moveCaretToEnd}
      onKeyDown={(e) => {
        // Backspace/Delete always remove the last cent digit, regardless of caret position.
        if (e.key === 'Backspace' || e.key === 'Delete') {
          e.preventDefault();
          onChange(digitsToAmount(amountToDigits(value).slice(0, -1)));
          return;
        }
        // Block anything that is not a digit (letters, "-", "e", "+", ...). Shortcuts still work.
        if (e.key.length === 1 && !/\d/.test(e.key) && !e.ctrlKey && !e.metaKey) e.preventDefault();
      }}
      onPaste={(e) => {
        e.preventDefault();
        const parsed = parseLooseAmount(e.clipboardData.getData('text'));
        if (parsed) onChange(parsed);
        moveCaretToEnd();
      }}
      onChange={(e) => {
        const digits = e.target.value.replace(/\D/g, '');
        if (digits.replace(/^0+/, '').length > MAX_DIGITS) return;
        onChange(digitsToAmount(digits));
        moveCaretToEnd();
      }}
      slotProps={{
        input: {
          startAdornment: <InputAdornment position="start">R$</InputAdornment>,
          sx: { fontFamily: MONO, '& input': { textAlign: 'right' } },
        },
        htmlInput: { inputMode: 'numeric', autoComplete: 'off', 'aria-label': label },
      }}
    />
  );
}
