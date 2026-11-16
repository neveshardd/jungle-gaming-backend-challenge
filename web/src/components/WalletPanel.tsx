import { Alert, Button, List, ListItemButton, Stack } from '@mui/material';
import { IconPlus, IconWallet } from '@tabler/icons-react';
import { useState } from 'react';
import { api, isError, type Wallet } from '../api';
import { validateAmount } from '../money';
import { SURFACE } from '../theme';
import { Empty, Mono, Panel } from './common';
import { MoneyField } from './MoneyField';

interface Props {
  wallets: Wallet[];
  selectedId: string | undefined;
  onCreated: (wallet: Wallet) => void;
  onSelect: (id: string) => void;
}

/** Create a wallet (playerId generated) and pick one from the list. */
export function WalletPanel({ wallets, selectedId, onCreated, onSelect }: Props) {
  const [amount, setAmount] = useState('1000.00');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  async function create() {
    setBusy(true);
    setError(undefined);
    const res = await api.createWallet(crypto.randomUUID(), amount);
    setBusy(false);
    if (isError(res.body)) setError(`${res.body.code}: ${res.body.message}`);
    else onCreated(res.body);
  }

  return (
    <Panel title="Wallets" icon={<IconWallet size={18} />}>
      <Stack direction="row" gap={1} alignItems="flex-start">
        <MoneyField label="Saldo inicial" value={amount} onChange={setAmount} allowZero />
        <Button
          variant="contained"
          onClick={create}
          disabled={busy || Boolean(validateAmount(amount, { allowZero: true }))}
          startIcon={<IconPlus size={18} />}
          sx={{ height: 48, flexShrink: 0 }}
        >
          Criar
        </Button>
      </Stack>
      {error && <Alert severity="error" variant="outlined">{error}</Alert>}

      {wallets.length === 0 ? (
        <Empty>Nenhuma wallet ainda.</Empty>
      ) : (
        <List dense disablePadding sx={{ maxHeight: 260, overflow: 'auto', display: 'grid', gap: 0.5 }}>
          {wallets.map((w) => (
            <ListItemButton
              key={w.id}
              selected={w.id === selectedId}
              onClick={() => onSelect(w.id)}
              sx={{ bgcolor: w.id === selectedId ? undefined : SURFACE, justifyContent: 'space-between' }}
            >
              <Mono style={{ opacity: 0.6 }}>{w.id.slice(-8)}</Mono>
              <Mono style={{ fontSize: 13, fontWeight: 600 }}>R$ {w.balance.amount}</Mono>
            </ListItemButton>
          ))}
        </List>
      )}
    </Panel>
  );
}
