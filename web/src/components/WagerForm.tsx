import {
  Autocomplete,
  Box,
  Button,
  Chip,
  IconButton,
  InputAdornment,
  MenuItem,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import { IconArrowsExchange, IconCopy, IconDice5, IconRepeat, IconSend } from '@tabler/icons-react';
import { useMemo, useState } from 'react';
import { api, isError, newExternalId, type WagerKind, type WagerPayload, type Wallet } from '../api';
import { MONO } from '../theme';
import { Code, Empty, Mono, Panel, StatusChip } from './common';

export interface SentWager {
  key: string;
  payload: WagerPayload;
  status: number;
  resultStatus?: string;
}

const KINDS: { value: WagerKind; help: string }[] = [
  { value: 'BET', help: 'Débito. Rejeitada com INSUFFICIENT_FUNDS sem saldo.' },
  { value: 'WIN', help: 'Crédito. Pode referenciar a BET da mesma rodada.' },
  { value: 'LOSS', help: 'Registra o resultado sem mover saldo (sem ledger).' },
  { value: 'REFUND', help: 'Crédito que reverte uma BET processada, uma única vez.' },
  { value: 'ROLLBACK', help: 'Inverso da referência (BET, WIN ou REFUND), uma única vez.' },
];

interface Props {
  wallet: Wallet | undefined;
  history: SentWager[];
  onSent: (sent: SentWager) => void;
}

export function WagerForm({ wallet, history, onSent }: Props) {
  const [kind, setKind] = useState<WagerKind>('BET');
  const [amount, setAmount] = useState('25.00');
  const [roundId, setRoundId] = useState('round-1');
  const [providerId, setProviderId] = useState('provider-a');
  const [externalId, setExternalId] = useState(() => newExternalId());
  const [reference, setReference] = useState('');
  const [last, setLast] = useState<{ status: number; body: unknown; label: string }>();
  const [busy, setBusy] = useState(false);

  const needsReference = kind === 'REFUND' || kind === 'ROLLBACK';
  const canReference = needsReference || kind === 'WIN' || kind === 'LOSS';
  const options = useMemo(
    () => history.filter((h) => h.payload.walletId === wallet?.id && h.payload.externalTransactionId !== externalId),
    [history, wallet?.id, externalId],
  );

  if (!wallet) {
    return (
      <Panel title="Enviar transação" icon={<IconSend size={18} />}>
        <Empty>Selecione ou crie uma wallet.</Empty>
      </Panel>
    );
  }

  const key = `${providerId}:${externalId}`;
  const payload: WagerPayload = {
    providerId,
    externalTransactionId: externalId,
    playerId: wallet.playerId,
    walletId: wallet.id,
    roundId,
    gameId: 'fortune-chimp',
    kind,
    money: { amount, currency: 'BRL' },
    ...(canReference && reference ? { referenceExternalTransactionId: reference } : {}),
  };
  const lastSent = history[history.length - 1];

  async function send(label: string, p: WagerPayload, k: string, rotate: boolean) {
    setBusy(true);
    const res = await api.submitWager(k, p);
    setBusy(false);
    setLast({ status: res.status, body: res.body, label });
    onSent({ key: k, payload: p, status: res.status, resultStatus: isError(res.body) ? undefined : res.body.status });
    if (rotate && res.status !== 0) setExternalId(newExternalId());
  }

  const replayFlag =
    last && !isError(last.body) && typeof last.body === 'object' && last.body && 'idempotentReplay' in last.body
      ? (last.body as { idempotentReplay: boolean }).idempotentReplay
      : undefined;

  return (
    <Panel
      title="Enviar transação"
      icon={<IconSend size={18} />}
      action={<Mono style={{ opacity: 0.6 }}>POST /wagering/transactions</Mono>}
    >
      <Stack direction={{ xs: 'column', sm: 'row' }} gap={1.5}>
        <TextField
          select
          label="kind"
          value={kind}
          onChange={(e) => {
            const next = e.target.value as WagerKind;
            setKind(next);
            if (next === 'BET') setReference('');
          }}
          helperText={KINDS.find((k) => k.value === kind)?.help}
          sx={{ flex: 2 }}
        >
          {KINDS.map((k) => (
            <MenuItem key={k.value} value={k.value}>
              {k.value}
            </MenuItem>
          ))}
        </TextField>
        <TextField
          label="Valor"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          helperText='string decimal, ex.: "25.00"'
          sx={{ flex: 1 }}
          slotProps={{ input: { endAdornment: <InputAdornment position="end">BRL</InputAdornment> } }}
        />
        <TextField label="roundId" value={roundId} onChange={(e) => setRoundId(e.target.value)} sx={{ flex: 1 }} />
        <TextField label="providerId" value={providerId} onChange={(e) => setProviderId(e.target.value)} sx={{ flex: 1 }} />
      </Stack>

      <Stack direction={{ xs: 'column', sm: 'row' }} gap={1.5}>
        <TextField
          label="externalTransactionId"
          value={externalId}
          onChange={(e) => setExternalId(e.target.value)}
          slotProps={{
            input: {
              sx: { fontFamily: MONO, fontSize: 13 },
              endAdornment: (
                <InputAdornment position="end">
                  <Tooltip title="Gerar novo id">
                    <IconButton size="small" edge="end" onClick={() => setExternalId(newExternalId())}>
                      <IconDice5 size={16} />
                    </IconButton>
                  </Tooltip>
                </InputAdornment>
              ),
            },
          }}
        />
        <Autocomplete
          freeSolo
          fullWidth
          disabled={!canReference}
          options={options.map((o) => o.payload.externalTransactionId)}
          inputValue={reference}
          onInputChange={(_, value) => setReference(value)}
          renderOption={(props, option) => {
            const sent = options.find((o) => o.payload.externalTransactionId === option);
            const { key: optionKey, ...rest } = props as typeof props & { key: string };
            return (
              <li key={optionKey} {...rest}>
                <Stack direction="row" gap={1} alignItems="center" width="100%">
                  <Mono>{option}</Mono>
                  <Box flex={1} />
                  <Chip size="small" label={`${sent?.payload.kind} ${sent?.payload.money.amount}`} />
                  <Chip size="small" variant="outlined" label={sent?.resultStatus ?? sent?.status} />
                </Stack>
              </li>
            );
          }}
          renderInput={(params) => (
            <TextField
              {...params}
              label={`Referência ${needsReference ? '(obrigatória)' : canReference ? '(opcional)' : '(n/a)'}`}
              helperText={
                needsReference ? 'Use um id que ainda não existe para ver o 202 PENDING_REFERENCE' : 'externalTransactionId referenciado'
              }
            />
          )}
        />
      </Stack>

      <Stack direction="row" alignItems="center" gap={1}>
        <Typography variant="caption" color="text.secondary">
          Idempotency-Key
        </Typography>
        <Chip size="small" label={key} sx={{ fontFamily: MONO }} />
        <Tooltip title="Copiar">
          <IconButton size="small" onClick={() => void navigator.clipboard?.writeText(key)}>
            <IconCopy size={14} />
          </IconButton>
        </Tooltip>
      </Stack>

      <Stack direction="row" gap={1} flexWrap="wrap">
        <Button variant="contained" startIcon={<IconSend size={18} />} disabled={busy} onClick={() => send('Enviar', payload, key, true)}>
          Enviar
        </Button>
        <Tooltip title="Reenvia exatamente o último request: mesma chave e mesmo payload">
          <span>
            <Button
              variant="outlined"
              color="info"
              startIcon={<IconRepeat size={18} />}
              disabled={busy || !lastSent}
              onClick={() => lastSent && send('Replay: mesma chave, mesmo payload', lastSent.payload, lastSent.key, false)}
            >
              Reenviar último (replay)
            </Button>
          </span>
        </Tooltip>
        <Tooltip title="Mesma chave do último request com o valor alterado: conflito, não replay">
          <span>
            <Button
              variant="outlined"
              color="warning"
              startIcon={<IconArrowsExchange size={18} />}
              disabled={busy || !lastSent}
              onClick={() =>
                lastSent &&
                send(
                  'Mesma chave, valor alterado',
                  { ...lastSent.payload, money: { ...lastSent.payload.money, amount: bump(lastSent.payload.money.amount) } },
                  lastSent.key,
                  false,
                )
              }
            >
              Mesma chave, outro valor (409)
            </Button>
          </span>
        </Tooltip>
      </Stack>

      {last && (
        <Box>
          <Stack direction="row" gap={1} alignItems="center" mb={1}>
            <StatusChip status={last.status} />
            <Typography variant="body2" color="text.secondary">
              {last.label}
            </Typography>
            {replayFlag !== undefined && (
              <Chip
                size="small"
                color={replayFlag ? 'info' : 'success'}
                label={`idempotentReplay: ${String(replayFlag)}`}
              />
            )}
          </Stack>
          <Code>{JSON.stringify(last.body, null, 2)}</Code>
        </Box>
      )}
    </Panel>
  );
}

/** "25.00" -> "26.00" without ever using floating point. */
function bump(amount: string): string {
  const [int = '0', frac = '00'] = amount.split('.');
  return `${(BigInt(int) + 1n).toString()}.${frac}`;
}
