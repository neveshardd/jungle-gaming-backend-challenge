import { AppBar, Box, Button, Chip, Container, Stack, Toolbar, Tooltip, Typography } from '@mui/material';
import { IconApi, IconCircleFilled, IconPlant2 } from '@tabler/icons-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, isError, onRequest, type RequestLog, type Wallet } from './api';
import { ActivityLog } from './components/ActivityLog';
import { LedgerTable } from './components/LedgerTable';
import { ScenarioPanel } from './components/ScenarioPanel';
import { WagerForm, type SentWager } from './components/WagerForm';
import { WalletPanel } from './components/WalletPanel';

const STORAGE_KEY = 'wagering-console:wallet-ids';

function loadIds(): string[] {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]') as string[];
  } catch {
    return [];
  }
}

function saveIds(ids: string[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(ids));
  } catch {
    // storage unavailable: the console still works for this session
  }
}

type Health = { ok: boolean; detail: string };

export function App() {
  const [wallets, setWallets] = useState<Wallet[]>([]);
  const [selectedId, setSelectedId] = useState<string>();
  const [history, setHistory] = useState<SentWager[]>([]);
  const [log, setLog] = useState<RequestLog[]>([]);
  const [refreshKey, setRefreshKey] = useState(0);
  const [health, setHealth] = useState<Health>();

  useEffect(() => onRequest((entry) => setLog((prev) => [entry, ...prev].slice(0, 300))), []);

  // Health indicator
  useEffect(() => {
    let alive = true;
    const check = async () => {
      const res = await api.health();
      if (!alive) return;
      const body = res.body as { checks?: Record<string, { status: string }> };
      const detail = body?.checks
        ? Object.entries(body.checks)
            .map(([k, v]) => `${k}: ${v.status}`)
            .join(' · ')
        : 'API inacessível';
      setHealth({ ok: res.status === 200, detail });
    };
    void check();
    const timer = setInterval(check, 5000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);

  // Restore wallets created in previous sessions
  useEffect(() => {
    void (async () => {
      const restored: Wallet[] = [];
      for (const id of loadIds()) {
        const res = await api.getWallet(id, true);
        if (!isError(res.body) && res.status === 200) restored.push(res.body);
      }
      setWallets(restored);
      setSelectedId(restored[0]?.id);
      saveIds(restored.map((w) => w.id));
    })();
  }, []);

  const selected = useMemo(() => wallets.find((w) => w.id === selectedId), [wallets, selectedId]);

  const upsertWallet = useCallback((wallet: Wallet, select = true) => {
    setWallets((prev) => {
      const next = prev.some((w) => w.id === wallet.id) ? prev.map((w) => (w.id === wallet.id ? wallet : w)) : [wallet, ...prev];
      saveIds(next.map((w) => w.id));
      return next;
    });
    if (select) setSelectedId(wallet.id);
  }, []);

  const refreshSelected = useCallback(async () => {
    if (!selectedId) return;
    const res = await api.getWallet(selectedId, true);
    if (!isError(res.body) && res.status === 200) upsertWallet(res.body, false);
    setRefreshKey((k) => k + 1);
  }, [selectedId, upsertWallet]);

  // Refresh balance + ledger after every transaction sent from the form
  const onSent = useCallback(
    (sent: SentWager) => {
      setHistory((prev) => [...prev, sent]);
      void refreshSelected();
    },
    [refreshSelected],
  );

  return (
    <Box minHeight="100vh">
      <AppBar position="sticky" color="transparent" elevation={0} sx={{ backdropFilter: 'blur(8px)', borderBottom: 1, borderColor: 'divider' }}>
        <Toolbar sx={{ gap: 1.5 }}>
          <IconPlant2 color="#3ddc84" />
          <Typography variant="h6" fontWeight={700} sx={{ flex: 1 }}>
            Wagering Console
            <Typography component="span" color="text.secondary" variant="body2" sx={{ ml: 1.5, display: { xs: 'none', sm: 'inline' } }}>
              Distributed Wagering Processor
            </Typography>
          </Typography>
          {health && (
            <Tooltip title={health.detail}>
              <Chip
                size="small"
                variant="outlined"
                color={health.ok ? 'success' : 'error'}
                icon={<IconCircleFilled size={10} />}
                label={health.ok ? 'API pronta' : 'API indisponível'}
              />
            </Tooltip>
          )}
          <Button size="small" color="inherit" variant="outlined" startIcon={<IconApi size={16} />} href="http://localhost:8080/docs" target="_blank">
            Swagger
          </Button>
        </Toolbar>
      </AppBar>

      <Container maxWidth={false} sx={{ py: 2.5, maxWidth: 1600 }}>
        <Box
          sx={{
            display: 'grid',
            gap: 2,
            gridTemplateColumns: { xs: '1fr', md: '360px 1fr', lg: '360px minmax(0, 1fr) 400px' },
            alignItems: 'start',
          }}
        >
          <Stack gap={2} minWidth={0}>
            <WalletPanel
              wallets={wallets}
              selected={selected}
              onCreated={(w) => upsertWallet(w)}
              onSelect={(id) => {
                setSelectedId(id);
                setRefreshKey((k) => k + 1);
              }}
              onRefresh={refreshSelected}
            />
            <ScenarioPanel onWallet={(w) => upsertWallet(w)} />
          </Stack>

          <Stack gap={2} minWidth={0}>
            <WagerForm wallet={selected} history={history} onSent={onSent} />
            <LedgerTable walletId={selected?.id} refreshKey={refreshKey} />
          </Stack>

          <Box minWidth={0} sx={{ gridColumn: { md: '1 / -1', lg: 'auto' } }}>
            <ActivityLog entries={log} onClear={() => setLog([])} />
          </Box>
        </Box>
      </Container>
    </Box>
  );
}
