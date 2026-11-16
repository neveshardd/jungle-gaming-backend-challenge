import { Box, Chip, Paper, Stack, Typography } from '@mui/material';
import { styled } from '@mui/material/styles';
import type { ReactNode } from 'react';
import { MONO, statusColor } from '../theme';

/** Section card with an overline title and an optional action on the right. */
export function Panel({
  title,
  icon,
  action,
  children,
  sx,
}: {
  title: string;
  icon?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  sx?: object;
}) {
  return (
    <Paper sx={{ p: 2, display: 'flex', flexDirection: 'column', gap: 1.5, minWidth: 0, ...sx }}>
      <Stack direction="row" alignItems="center" justifyContent="space-between" gap={1}>
        <Stack direction="row" alignItems="center" gap={1} color="text.secondary">
          {icon}
          <Typography variant="overline" lineHeight={1.4}>
            {title}
          </Typography>
        </Stack>
        {action}
      </Stack>
      {children}
    </Paper>
  );
}

export function StatusChip({ status }: { status: number }) {
  return (
    <Chip
      size="small"
      variant="outlined"
      color={statusColor(status)}
      label={status === 0 ? 'ERR' : status}
      sx={{ fontFamily: MONO, minWidth: 48 }}
    />
  );
}

export const Mono = styled('span')({ fontFamily: MONO, fontSize: 12 });

export const Code = styled('pre')(({ theme }) => ({
  margin: 0,
  background: '#0b100e',
  border: `1px solid ${theme.palette.divider}`,
  borderRadius: 8,
  padding: 10,
  fontFamily: MONO,
  fontSize: 12,
  lineHeight: 1.45,
  overflow: 'auto',
  maxHeight: 260,
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
}));

export function Empty({ children }: { children: ReactNode }) {
  return (
    <Box
      sx={{
        color: 'text.secondary',
        fontSize: 13,
        p: 2.5,
        textAlign: 'center',
        border: 1,
        borderStyle: 'dashed',
        borderColor: 'divider',
        borderRadius: 2,
      }}
    >
      {children}
    </Box>
  );
}
