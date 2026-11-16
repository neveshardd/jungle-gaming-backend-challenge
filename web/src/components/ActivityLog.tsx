import { Box, Button, Collapse, List, ListItemButton, Stack, Typography } from '@mui/material';
import { IconActivity, IconTrash } from '@tabler/icons-react';
import { useState } from 'react';
import type { RequestLog } from '../api';
import { Code, Empty, Mono, Panel, StatusChip } from './common';

function summary(entry: RequestLog): string {
  const body = entry.responseBody as Record<string, unknown> | undefined;
  if (!body || typeof body !== 'object') return '';
  if (typeof body.code === 'string') return String(body.code);
  if (typeof body.status === 'string') {
    const parts = [body.status as string];
    if (body.failureCode) parts.push(String(body.failureCode));
    if (body.idempotentReplay === true) parts.push('replay');
    return parts.join(' · ');
  }
  if (typeof body.consistent === 'boolean') return body.consistent ? 'consistente' : 'DIVERGENTE';
  if (body.balance && typeof body.id === 'string') return 'wallet criada';
  return '';
}

const shortenIds = (path: string) => path.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, (m) => `${m.slice(0, 8)}…`);

export function ActivityLog({ entries, onClear }: { entries: RequestLog[]; onClear: () => void }) {
  const [open, setOpen] = useState<number>();
  return (
    <Panel
      title={`Atividade (${entries.length})`}
      icon={<IconActivity size={18} />}
      sx={{ position: { lg: 'sticky' }, top: 16 }}
      action={
        <Button size="small" color="inherit" startIcon={<IconTrash size={14} />} onClick={onClear} disabled={entries.length === 0}>
          Limpar
        </Button>
      }
    >
      {entries.length === 0 ? (
        <Empty>Cada requisição aparece aqui com status, chave de idempotência, correlation id e resposta.</Empty>
      ) : (
        <List dense disablePadding sx={{ overflow: 'auto', maxHeight: { lg: 'calc(100vh - 190px)' }, minHeight: 200 }}>
          {entries.map((e) => (
            <Box key={e.id}>
              <ListItemButton onClick={() => setOpen(open === e.id ? undefined : e.id)} sx={{ borderRadius: 1.5, gap: 1, py: 0.5 }}>
                <StatusChip status={e.status} />
                <Mono style={{ opacity: 0.6, width: 36 }}>{e.method}</Mono>
                <Box flex={1} minWidth={0}>
                  <Typography noWrap sx={{ fontFamily: 'inherit', fontSize: 12 }}>
                    <Mono>{shortenIds(e.path)}</Mono>
                  </Typography>
                  <Typography variant="caption" color="text.secondary" noWrap component="div">
                    {summary(e)}
                  </Typography>
                </Box>
                <Typography variant="caption" color="text.secondary">
                  {Math.round(e.durationMs)} ms
                </Typography>
              </ListItemButton>
              <Collapse in={open === e.id} unmountOnExit>
                <Stack gap={0.75} sx={{ px: 1, pb: 1.5, pt: 0.5 }}>
                  {e.idempotencyKey && (
                    <Typography variant="caption" color="text.secondary">
                      Idempotency-Key: <Mono>{e.idempotencyKey}</Mono>
                    </Typography>
                  )}
                  {e.correlationId && (
                    <Typography variant="caption" color="text.secondary">
                      X-Correlation-Id: <Mono>{e.correlationId}</Mono>
                    </Typography>
                  )}
                  {e.requestBody !== undefined && (
                    <>
                      <Typography variant="caption" color="text.secondary">
                        request
                      </Typography>
                      <Code>{JSON.stringify(e.requestBody, null, 2)}</Code>
                    </>
                  )}
                  <Typography variant="caption" color="text.secondary">
                    response
                  </Typography>
                  <Code>{JSON.stringify(e.responseBody, null, 2)}</Code>
                </Stack>
              </Collapse>
            </Box>
          ))}
        </List>
      )}
    </Panel>
  );
}
