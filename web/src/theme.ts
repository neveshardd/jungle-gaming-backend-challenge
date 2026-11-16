import { alpha, createTheme, type Theme } from '@mui/material/styles';

const SURFACE_ALT = '#1b2520';

/**
 * Dark "jungle" theme for Material UI (MUI is styled with Emotion under the hood).
 * Flat look: small radius and no borders — surfaces are separated by tone only.
 */
export const theme = createTheme({
  palette: {
    mode: 'dark',
    primary: { main: '#3ddc84', contrastText: '#06200f' },
    secondary: { main: '#5aa9ff' },
    warning: { main: '#f5b942' },
    error: { main: '#ff6b6b' },
    success: { main: '#3ddc84' },
    info: { main: '#5aa9ff' },
    background: { default: '#0c110f', paper: '#141c18' },
    // Invisible dividers (flat look). Must be a parseable color: MUI runs alpha() on it.
    divider: 'rgba(0, 0, 0, 0)',
    text: { primary: '#e6efe9', secondary: '#8fa39a' },
  },
  shape: { borderRadius: 4 },
  typography: {
    fontFamily: "'Inter', system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
    button: { textTransform: 'none', fontWeight: 600 },
    overline: { fontWeight: 600, letterSpacing: '0.08em' },
  },
  components: {
    MuiPaper: { styleOverrides: { root: { backgroundImage: 'none', border: 'none' } } },
    MuiAppBar: { styleOverrides: { root: { border: 'none' } } },
    MuiButton: {
      defaultProps: { disableElevation: true },
      styleOverrides: {
        // "Outlined" buttons become tonal: tinted background instead of a border.
        outlined: ({ ownerState, theme: t }: { ownerState: { color?: string }; theme: Theme }) => {
          const main = tone(t, ownerState.color);
          return {
            border: 'none',
            backgroundColor: alpha(main, 0.12),
            '&:hover': { border: 'none', backgroundColor: alpha(main, 0.22) },
            '&.Mui-disabled': { border: 'none', backgroundColor: alpha(main, 0.05) },
          };
        },
      },
    },
    // Inputs: filled, no outline, no underline.
    MuiTextField: { defaultProps: { size: 'small', fullWidth: true, variant: 'filled' } },
    MuiFilledInput: {
      defaultProps: { disableUnderline: true },
      styleOverrides: {
        root: {
          borderRadius: 4,
          backgroundColor: SURFACE_ALT,
          '&:hover': { backgroundColor: '#212d27' },
          '&.Mui-focused': { backgroundColor: '#212d27', boxShadow: 'inset 0 -2px 0 #3ddc84' },
          '&.Mui-error': { boxShadow: 'inset 0 -2px 0 #ff6b6b' },
        },
      },
    },
    MuiChip: {
      styleOverrides: {
        root: { borderRadius: 4 },
        label: { fontWeight: 600 },
        // Outlined chips become tonal (tinted background, no border).
        outlined: ({ ownerState, theme: t }: { ownerState: { color?: string }; theme: Theme }) => {
          const main = tone(t, ownerState.color);
          return { border: 'none', backgroundColor: alpha(main, 0.14), color: ownerState.color === 'default' ? undefined : main };
        },
      },
    },
    MuiAlert: {
      styleOverrides: {
        outlined: ({ ownerState, theme: t }: { ownerState: { severity?: string }; theme: Theme }) => {
          const main = tone(t, ownerState.severity);
          return { border: 'none', backgroundColor: alpha(main, 0.1) };
        },
      },
    },
    MuiTableCell: { styleOverrides: { root: { borderBottom: 'none' }, stickyHeader: { backgroundColor: '#141c18' } } },
    MuiTableRow: { styleOverrides: { root: { '&:nth-of-type(even) td': { backgroundColor: alpha('#ffffff', 0.02) } } } },
    MuiListItemButton: {
      styleOverrides: {
        root: {
          borderRadius: 4,
          '&.Mui-selected': { backgroundColor: alpha('#3ddc84', 0.14) },
          '&.Mui-selected:hover': { backgroundColor: alpha('#3ddc84', 0.2) },
        },
      },
    },
  },
});

/** Main color for a palette key ("primary", "error", "inherit"…). */
function tone(t: Theme, color: string | undefined): string {
  const palette = t.palette as unknown as Record<string, { main?: string } | undefined>;
  return (color && palette[color]?.main) || t.palette.text.primary;
}

export const MONO = "'JetBrains Mono', ui-monospace, 'Cascadia Code', Consolas, monospace";
export const SURFACE = SURFACE_ALT;

export type ChipColor = 'default' | 'primary' | 'secondary' | 'success' | 'warning' | 'error' | 'info';

/** Chip color for an HTTP status (consistent with the API mapping). */
export function statusColor(status: number): ChipColor {
  if (status === 201) return 'success';
  if (status === 200) return 'info';
  if (status === 202 || status === 409 || status === 422) return 'warning';
  if (status === 0 || status >= 400) return 'error';
  return 'default';
}
