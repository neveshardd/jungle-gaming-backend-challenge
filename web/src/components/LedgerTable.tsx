import {
  Button,
  Chip,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Typography,
} from '@mui/material';
import { IconArrowDownLeft, IconArrowUpRight, IconBook2, IconChevronDown } from '@tabler/icons-react';
import { useCallback, useEffect, useState } from 'react';
import { api, isError, type LedgerEntry } from '../api';
import { MONO } from '../theme';
import { Empty, Mono, Panel } from './common';

const num = { fontFamily: MONO, fontSize: 13, textAlign: 'right' as const };

export function LedgerTable({ walletId, refreshKey }: { walletId: string | undefined; refreshKey: number }) {
  const [entries, setEntries] = useState<LedgerEntry[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(
    async (after?: string) => {
      if (!walletId) return;
      setLoading(true);
      const res = await api.getLedger(walletId, after, 20);
      setLoading(false);
      if (isError(res.body)) return;
      const page = res.body;
      setEntries((prev) => (after ? [...prev, ...page.entries] : page.entries));
      setCursor(page.nextCursor);
    },
    [walletId],
  );

  useEffect(() => {
    setEntries([]);
    setCursor(null);
    void load();
  }, [load, refreshKey]);

  return (
    <Panel
      title="Ledger"
      icon={<IconBook2 size={18} />}
      action={
        <Typography variant="caption" color="text.secondary">
          append-only · cursor opaco
        </Typography>
      }
    >
      {!walletId ? (
        <Empty>Nenhuma wallet selecionada.</Empty>
      ) : entries.length === 0 ? (
        <Empty>{loading ? 'Carregando…' : 'Sem lançamentos (saldo inicial zero, ou só LOSS / rejeições).'}</Empty>
      ) : (
        <TableContainer sx={{ maxHeight: 360 }}>
          <Table size="small" stickyHeader>
            <TableHead>
              <TableRow>
                <TableCell>#</TableCell>
                <TableCell>Direção</TableCell>
                <TableCell align="right">Valor</TableCell>
                <TableCell align="right">Antes</TableCell>
                <TableCell align="right">Depois</TableCell>
                <TableCell>Transação</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {entries.map((e, i) => {
                const credit = e.direction === 'CREDIT';
                return (
                  <TableRow key={e.id} hover>
                    <TableCell sx={{ color: 'text.secondary' }}>{i + 1}</TableCell>
                    <TableCell>
                      <Chip
                        size="small"
                        variant="outlined"
                        color={credit ? 'success' : 'error'}
                        icon={credit ? <IconArrowDownLeft size={14} /> : <IconArrowUpRight size={14} />}
                        label={e.direction}
                      />
                    </TableCell>
                    <TableCell sx={{ ...num, color: credit ? 'success.main' : 'error.main' }}>
                      {credit ? '+' : '−'}
                      {e.money.amount}
                    </TableCell>
                    <TableCell sx={num}>{e.balanceBefore.amount}</TableCell>
                    <TableCell sx={{ ...num, fontWeight: 700 }}>{e.balanceAfter.amount}</TableCell>
                    <TableCell>
                      <Mono style={{ opacity: 0.7 }}>{e.transactionId.slice(0, 13)}…</Mono>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </TableContainer>
      )}
      {cursor && (
        <Button size="small" color="inherit" startIcon={<IconChevronDown size={16} />} disabled={loading} onClick={() => load(cursor)}>
          Carregar mais
        </Button>
      )}
    </Panel>
  );
}
