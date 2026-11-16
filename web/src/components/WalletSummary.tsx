import { Box, Button, Chip, IconButton, Paper, Stack, Tooltip, Typography } from '@mui/material';
import { IconCircleCheck, IconCircleX, IconCopy, IconRefresh, IconScale } from '@tabler/icons-react';
import { useEffect, useState } from 'react';
import { api, isError, type Reconciliation, type Wallet } from '../api';
import { formatAmount } from '../money';
import { Mono } from './common';

const CHECK_LABELS: Record<string, string> = {
  balanceMatchesLedgerSum: 'Saldo = soma do ledger',
  balanceMatchesLastEntry: 'Saldo = último lançamento',
  ledgerChainIntact: 'Cadeia do ledger íntegra',
  versionMatchesMovements: 'version = 1 + movimentações',
};

/** Top bar of the selected wallet: balance first, actions on the right. */
export function WalletSummary({ wallet, onRefresh }: { wallet: Wallet; onRefresh: () => void }) {
  const [recon, setRecon] = useState<Reconciliation>();

  useEffect(() => setRecon(undefined), [wallet.id, wallet.version]);

  async function reconcile() {
    const res = await api.reconcile(wallet.id);
    if (!isError(res.body)) setRecon(res.body);
  }

  return (
    <Paper sx={{ px: 2.5, py: 2 }}>
      <Stack direction={{ xs: 'column', sm: 'row' }} alignItems={{ sm: 'center' }} gap={2}>
        <Box flex={1} minWidth={0}>
          <Stack direction="row" alignItems="baseline" gap={1.5}>
            <Typography variant="h4" fontWeight={700} sx={{ fontVariantNumeric: 'tabular-nums' }}>
              R$ {formatAmount(wallet.balance.amount)}
            </Typography>
            <Chip size="small" label={`v${wallet.version}`} />
          </Stack>
          <Stack direction="row" alignItems="center" gap={0.5} sx={{ opacity: 0.6 }}>
            <Mono>{wallet.id}</Mono>
            <Tooltip title="Copiar id">
              <IconButton size="small" onClick={() => void navigator.clipboard?.writeText(wallet.id)}>
                <IconCopy size={13} />
              </IconButton>
            </Tooltip>
          </Stack>
        </Box>

        <Stack direction="row" gap={1} alignItems="center">
          {recon && (
            <Tooltip
              title={
                <Box>
                  {Object.entries(recon.checks).map(([k, ok]) => (
                    <div key={k}>
                      {ok ? '✓' : '✗'} {CHECK_LABELS[k] ?? k}
                    </div>
                  ))}
                  <div style={{ marginTop: 6 }}>
                    ledger R$ {recon.calculatedBalance.amount} · diferença {recon.difference.amount}
                  </div>
                </Box>
              }
            >
              <Chip
                color={recon.consistent ? 'success' : 'error'}
                variant="outlined"
                icon={recon.consistent ? <IconCircleCheck size={16} /> : <IconCircleX size={16} />}
                label={`${recon.consistent ? 'Consistente' : 'Divergente'} · ${recon.checkedEntries} lanç.`}
              />
            </Tooltip>
          )}
          <Button variant="outlined" startIcon={<IconScale size={16} />} onClick={reconcile}>
            Reconciliar
          </Button>
          <Tooltip title="Atualizar saldo e ledger">
            <IconButton onClick={onRefresh}>
              <IconRefresh size={18} />
            </IconButton>
          </Tooltip>
        </Stack>
      </Stack>
    </Paper>
  );
}
