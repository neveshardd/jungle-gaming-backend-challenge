import { createTheme } from '@mui/material/styles';

/** Dark "jungle" theme for Material UI (MUI is styled with Emotion under the hood). */
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
    divider: '#26332d',
    text: { primary: '#e6efe9', secondary: '#8fa39a' },
  },
  shape: { borderRadius: 10 },
  typography: {
    fontFamily: "'Inter', system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
    button: { textTransform: 'none', fontWeight: 600 },
    overline: { fontWeight: 600, letterSpacing: '0.08em' },
  },
  components: {
    MuiPaper: { styleOverrides: { root: { backgroundImage: 'none', border: '1px solid #26332d' } } },
    MuiButton: { defaultProps: { disableElevation: true } },
    MuiTextField: { defaultProps: { size: 'small', fullWidth: true } },
    MuiChip: { styleOverrides: { label: { fontWeight: 600 } } },
    MuiTableCell: { styleOverrides: { root: { borderColor: '#26332d' } } },
  },
});

export const MONO = "'JetBrains Mono', ui-monospace, 'Cascadia Code', Consolas, monospace";

export type ChipColor = 'default' | 'primary' | 'secondary' | 'success' | 'warning' | 'error' | 'info';

/** Chip color for an HTTP status (consistent with the API mapping). */
export function statusColor(status: number): ChipColor {
  if (status === 201) return 'success';
  if (status === 200) return 'info';
  if (status === 202 || status === 409 || status === 422) return 'warning';
  if (status === 0 || status >= 400) return 'error';
  return 'default';
}
