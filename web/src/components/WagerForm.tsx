import {
  Autocomplete,
  Box,
  Button,
  Chip,
  Collapse,
  IconButton,
  Stack,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Tooltip,
  Typography,
} from '@mui/material';
import { IconAdjustments, IconArrowsExchange, IconBraces, IconCopy, IconDice5, IconRepeat, IconSend } from '@tabler/icons-react';
import { useMemo, useState } from 'react';
import { api, isError, newExternalId, type WagerKind, type WagerPayload, type WagerResult, type Wallet } from '../api';
import { validateAmount } from '../money';
import { Code, Mono, Panel, StatusChip } from './common';
import { MoneyField } from './MoneyField';

export interface SentWager {
  key: string;
  payload: WagerPayload;
  status: number;
  resultStatus?: string;
}

const KINDS: { value: WagerKind; help: string }[] = [
  { value: 'BET', help: 'Débito. Sem saldo: REJECTED / INSUFFICIENT_FUNDS' },
  { value: 'WIN', help: 'Crédito. Pode referenciar a BET da rodada' },
  { value: 'LOSS', help: 'Registra o resultado, sem mover saldo' },
  { value: 'REFUND', help: 'Crédito que reverte uma BET (uma vez)' },
  { value: 'ROLLBACK', help: 'Inverso da referência (uma vez)' },
];

interface Props {
  wallet: Wallet;
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
  const [advanced, setAdvanced] = useState(false);
  const [showJson, setShowJson] = useState(false);
  const [last, setLast] = useState<{ status: number; body: unknown; label: string }>();
  const [busy, setBusy] = useState(false);

  const needsReference = kind === 'REFUND' || kind === 'ROLLBACK';
  const canReference = needsReference || kind === 'WIN' || kind === 'LOSS';
  const options = useMemo(
    () => history.filter((h) => h.payload.walletId === wallet.id && h.payload.externalTransactionId !== externalId),
    [history, wallet.id, externalId],
  );
  const lastSent = [...history].reverse().find((h) => h.payload.walletId === wallet.id);
  const amountError = validateAmount(amount, { allowZero: false });

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

  async function send(label: string, p: WagerPayload, k: string, rotate: boolean) {
    setBusy(true);
    const res = await api.submitWager(k, p);
    setBusy(false);
    setLast({ status: res.status, body: res.body, label });
    onSent({ key: k, payload: p, status: res.status, resultStatus: isError(res.body) ? undefined : res.body.status });
    if (rotate && res.status !== 0) {
      setExternalId(newExternalId());
      setReference('');
    }
  }

  return (
    <Panel
      title="Nova transação"
      icon={<IconSend size={18} />}
      action={
        <Button
          size="small"
          color="inherit"
          startIcon={<IconAdjustments size={16} />}
          onClick={() => setAdvanced((v) => !v)}
          sx={{ opacity: advanced ? 1 : 0.7 }}
        >
          Avançado
        </Button>
      }
    >
      <Box>
        <ToggleButtonGroup
          exclusive
          fullWidth
          size="small"
          color="primary"
          value={kind}
          onChange={(_, v: WagerKind | null) => v && setKind(v)}
        >
          {KINDS.map((k) => (
            <ToggleButton key={k.value} value={k.value} sx={{ fontWeight: 700, border: 'none' }}>
              {k.value}
            </ToggleButton>
          ))}
        </ToggleButtonGroup>
        <Typography variant="caption" color="text.secondary" component="div" mt={0.75}>
          {KINDS.find((k) => k.value === kind)?.help}
        </Typography>
      </Box>

      <Stack direction={{ xs: 'column', sm: 'row' }} gap={1.5} alignItems="flex-start">
        <MoneyField label="Valor" value={amount} onChange={setAmount} sx={{ flex: 1 }} />
        {canReference && (
          <Autocomplete
            freeSolo
            options={options.map((o) => o.payload.externalTransactionId)}
            inputValue={reference}
            onInputChange={(_, value) => setReference(value)}
            sx={{ flex: 1.4, width: '100%' }}
            renderOption={(props, option) => {
              const sent = options.find((o) => o.payload.externalTransactionId === option);
              const { key: optionKey, ...rest } = props as typeof props & { key: string };
              return (
                <li key={optionKey} {...rest}>
                  <Stack direction="row" gap={1} alignItems="center" width="100%">
                    <Mono>{option}</Mono>
                    <Box flex={1} />
                    <Typography variant="caption" color="text.secondary">
                      {sent?.payload.kind} {sent?.payload.money.amount} · {sent?.resultStatus ?? sent?.status}
                    </Typography>
                  </Stack>
                </li>
              );
            }}
            renderInput={(params) => (
              <TextField
                {...params}
                label={needsReference ? 'Referência' : 'Referência (opcional)'}
                error={needsReference && !reference}
              />
            )}
          />
        )}
      </Stack>

      <Collapse in={advanced} unmountOnExit>
        <Stack direction={{ xs: 'column', sm: 'row' }} gap={1.5}>
          <TextField label="externalTransactionId" value={externalId} onChange={(e) => setExternalId(e.target.value)}
            slotProps={{
              input: {
                endAdornment: (
                  <IconButton size="small" onClick={() => setExternalId(newExternalId())}>
                    <IconDice5 size={16} />
                  </IconButton>
                ),
              },
            }}
          />
          <TextField label="roundId" value={roundId} onChange={(e) => setRoundId(e.target.value)} />
          <TextField label="providerId" value={providerId} onChange={(e) => setProviderId(e.target.value)} />
        </Stack>
      </Collapse>

      <Stack direction="row" gap={1} alignItems="center" flexWrap="wrap">
        <Button
          variant="contained"
          startIcon={<IconSend size={18} />}
          disabled={busy || Boolean(amountError) || (needsReference && !reference)}
          onClick={() => send('Enviar', payload, key, true)}
        >
          Enviar
        </Button>
        <Tooltip title="Reenvia o último request: mesma chave e mesmo payload (replay → 200)">
          <span>
            <Button
              variant="outlined"
              color="info"
              startIcon={<IconRepeat size={18} />}
              disabled={busy || !lastSent}
              onClick={() => lastSent && send('Replay', lastSent.payload, lastSent.key, false)}
            >
              Replay
            </Button>
          </span>
        </Tooltip>
        <Tooltip title="Mesma chave do último request com outro valor (conflito → 409)">
          <span>
            <Button
              variant="outlined"
              color="warning"
              startIcon={<IconArrowsExchange size={18} />}
              disabled={busy || !lastSent}
              onClick={() =>
                lastSent &&
                send(
                  'Conflito',
                  { ...lastSent.payload, money: { ...lastSent.payload.money, amount: bump(lastSent.payload.money.amount) } },
                  lastSent.key,
                  false,
                )
              }
            >
              Conflito
            </Button>
          </span>
        </Tooltip>
        <Box flex={1} />
        <Tooltip title="Idempotency-Key do próximo envio (clique para copiar)">
          <Chip
            size="small"
            icon={<IconCopy size={13} />}
            label={key}
            onClick={() => void navigator.clipboard?.writeText(key)}
            sx={{ fontFamily: 'inherit', opacity: 0.7, maxWidth: 260 }}
          />
        </Tooltip>
      </Stack>

      {last && <ResultLine last={last} showJson={showJson} onToggleJson={() => setShowJson((v) => !v)} />}
    </Panel>
  );
}

function ResultLine({
  last,
  showJson,
  onToggleJson,
}: {
  last: { status: number; body: unknown; label: string };
  showJson: boolean;
  onToggleJson: () => void;
}) {
  const error = isError(last.body) ? last.body : undefined;
  const result = !error ? (last.body as WagerResult) : undefined;
  return (
    <Box sx={{ bgcolor: 'rgba(255,255,255,0.03)', borderRadius: 1, p: 1.25 }}>
      <Stack direction="row" gap={1} alignItems="center" flexWrap="wrap">
        <StatusChip status={last.status} />
        <Typography variant="body2" color="text.secondary">
          {last.label}
        </Typography>
        {result?.status && <Typography variant="body2" fontWeight={600}>{result.status}</Typography>}
        {result?.failureCode && <Chip size="small" color="warning" variant="outlined" label={result.failureCode} />}
        {result?.idempotentReplay && <Chip size="small" color="info" variant="outlined" label="replay" />}
        {error && <Chip size="small" color="error" variant="outlined" label={error.code} />}
        <Box flex={1} />
        {result?.balance && (
          <Typography variant="body2" sx={{ fontVariantNumeric: 'tabular-nums' }}>
            saldo R$ {result.balance.amount}
          </Typography>
        )}
        <Tooltip title={showJson ? 'Esconder JSON' : 'Ver JSON'}>
          <IconButton size="small" onClick={onToggleJson} color={showJson ? 'primary' : 'default'}>
            <IconBraces size={16} />
          </IconButton>
        </Tooltip>
      </Stack>
      {error && !showJson && (
        <Typography variant="caption" color="text.secondary" component="div" mt={0.5}>
          {error.message}
        </Typography>
      )}
      <Collapse in={showJson}>
        <Code sx={{ mt: 1 }}>{JSON.stringify(last.body, null, 2)}</Code>
      </Collapse>
    </Box>
  );
}

/** "25.00" -> "26.00" without ever using floating point. */
function bump(amount: string): string {
  const [int = '0', frac = '00'] = amount.split('.');
  return `${(BigInt(int) + 1n).toString()}.${frac}`;
}
