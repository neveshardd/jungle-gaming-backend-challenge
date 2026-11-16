import {
  Alert,
  Box,
  Button,
  Chip,
  IconButton,
  InputAdornment,
  List,
  ListItemButton,
  ListItemText,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import {
  IconCircleCheck,
  IconCircleX,
  IconDice5,
  IconPlus,
  IconRefresh,
  IconScale,
  IconWallet,
} from '@tabler/icons-react';
import { useState } from 'react';
import { api, isError, type Reconciliation, type Wallet } from '../api';
import { MONO, SURFACE } from '../theme';
import { validateAmount } from '../money';
import { Empty, Mono, Panel } from './common';
import { MoneyField } from './MoneyField';

interface Props {
  wallets: Wallet[];
  selected: Wallet | undefined;
  onCreated: (wallet: Wallet) => void;
  onSelect: (id: string) => void;
  onRefresh: () => void;
}

export function WalletPanel({ wallets, selected, onCreated, onSelect, onRefresh }: Props) {
  const [amount, setAmount] = useState('1000.00');
  const [playerId, setPlayerId] = useState<string>(() => crypto.randomUUID());
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [recon, setRecon] = useState<Reconciliation>();

  async function create() {
    setBusy(true);
    setError(undefined);
    const res = await api.createWallet(playerId, amount);
    setBusy(false);
    if (isError(res.body)) {
      setError(`${res.status} ${res.body.code}: ${res.body.message}`);
      return;
    }
    onCreated(res.body);
    setPlayerId(crypto.randomUUID());
    setRecon(undefined);
  }

  async function reconcile() {
    if (!selected) return;
    const res = await api.reconcile(selected.id);
    if (!isError(res.body)) setRecon(res.body);
  }

  return (
    <Panel title="Wallets" icon={<IconWallet size={18} />}>
      <Stack direction="row" gap={1}>
        <TextField
          label="playerId"
          value={playerId}
          onChange={(e) => setPlayerId(e.target.value)}
          slotProps={{
            input: {
              sx: { fontFamily: MONO, fontSize: 12 },
              endAdornment: (
                <InputAdornment position="end">
                  <Tooltip title="Novo playerId">
                    <IconButton size="small" edge="end" onClick={() => setPlayerId(crypto.randomUUID())}>
                      <IconDice5 size={16} />
                    </IconButton>
                  </Tooltip>
                </InputAdornment>
              ),
            },
          }}
        />
        <MoneyField label="Saldo inicial" value={amount} onChange={setAmount} allowZero sx={{ maxWidth: 170 }} />
      </Stack>
      <Button
        variant="contained"
        startIcon={<IconPlus size={18} />}
        onClick={create}
        disabled={busy || Boolean(validateAmount(amount, { allowZero: true }))}
      >
        Criar wallet
      </Button>
      {error && (
        <Alert severity="error" variant="outlined">
          {error}
        </Alert>
      )}

      {wallets.length === 0 ? (
        <Empty>Crie uma wallet para começar.</Empty>
      ) : (
        <List dense disablePadding sx={{ maxHeight: 220, overflow: 'auto', display: 'grid', gap: 0.75 }}>
          {wallets.map((w) => (
            <ListItemButton
              key={w.id}
              selected={w.id === selected?.id}
              onClick={() => onSelect(w.id)}
              sx={{ bgcolor: w.id === selected?.id ? undefined : SURFACE }}
            >
              <ListItemText primary={<Mono>{w.id.slice(0, 13)}…</Mono>} />
              <Mono>{w.balance.amount}</Mono>
            </ListItemButton>
          ))}
        </List>
      )}

      {selected && (
        <Box>
          <Typography variant="caption" color="text.secondary">
            Saldo da wallet selecionada
          </Typography>
          <Typography variant="h4" fontWeight={700} sx={{ fontVariantNumeric: 'tabular-nums' }}>
            {selected.balance.amount}{' '}
            <Typography component="span" color="text.secondary">
              {selected.balance.currency}
            </Typography>
          </Typography>
          <Stack direction="row" gap={1} alignItems="center" flexWrap="wrap" mt={0.5}>
            <Chip size="small" label={`version ${selected.version}`} />
            <Mono style={{ opacity: 0.7 }}>{selected.id}</Mono>
          </Stack>
          <Typography variant="caption" color="text.secondary" component="div" mt={0.5}>
            player {selected.playerId}
          </Typography>
          <Stack direction="row" gap={1} mt={1.5}>
            <Button size="small" variant="outlined" color="inherit" startIcon={<IconRefresh size={16} />} onClick={onRefresh}>
              Atualizar
            </Button>
            <Button size="small" variant="outlined" startIcon={<IconScale size={16} />} onClick={reconcile}>
              Reconciliar com ledger
            </Button>
          </Stack>
          {recon && (
            <Alert
              sx={{ mt: 1.5 }}
              variant="outlined"
              severity={recon.consistent ? 'success' : 'error'}
              icon={recon.consistent ? <IconCircleCheck /> : <IconCircleX />}
            >
              <Typography variant="body2" fontWeight={600}>
                {recon.consistent ? 'Consistente' : 'DIVERGENTE'}: armazenado {recon.storedBalance.amount}, ledger{' '}
                {recon.calculatedBalance.amount}, diferença {recon.difference.amount} ({recon.checkedEntries} lançamentos)
              </Typography>
              <Stack direction="row" gap={0.5} flexWrap="wrap" mt={1}>
                {Object.entries(recon.checks).map(([k, ok]) => (
                  <Chip key={k} size="small" variant="outlined" color={ok ? 'success' : 'error'} label={k} />
                ))}
              </Stack>
            </Alert>
          )}
        </Box>
      )}
    </Panel>
  );
}
