import { Box, Button, CircularProgress, Stack, Typography } from '@mui/material';
import { IconCircleCheckFilled, IconCircleXFilled, IconFlask, IconPlayerPlay } from '@tabler/icons-react';
import { useState } from 'react';
import type { Wallet } from '../api';
import { SCENARIOS, type ScenarioResult } from '../scenarios';
import { Panel } from './common';

type State = { running: boolean; result?: ScenarioResult; error?: string };

export function ScenarioPanel({ onWallet }: { onWallet: (wallet: Wallet) => void }) {
  const [states, setStates] = useState<Record<string, State>>({});

  async function run(id: string) {
    const scenario = SCENARIOS.find((s) => s.id === id);
    if (!scenario) return;
    setStates((s) => ({ ...s, [id]: { running: true } }));
    try {
      const result = await scenario.run();
      if (result.wallet) onWallet(result.wallet);
      setStates((s) => ({ ...s, [id]: { running: false, result } }));
    } catch (err) {
      setStates((s) => ({ ...s, [id]: { running: false, error: err instanceof Error ? err.message : String(err) } }));
    }
  }

  return (
    <Panel title="Cenários do desafio" icon={<IconFlask size={18} />}>
      <Stack gap={1}>
        {SCENARIOS.map((s) => {
          const st = states[s.id];
          const passed = st?.result?.passed;
          return (
            <Box
              key={s.id}
              sx={{
                border: 1,
                borderColor: passed === undefined ? 'divider' : passed ? 'success.main' : 'error.main',
                borderRadius: 2,
                p: 1.25,
              }}
            >
              <Stack direction="row" alignItems="flex-start" gap={1}>
                <Box flex={1} minWidth={0}>
                  <Stack direction="row" alignItems="center" gap={0.75}>
                    {passed === true && <IconCircleCheckFilled size={18} color="#3ddc84" />}
                    {passed === false && <IconCircleXFilled size={18} color="#ff6b6b" />}
                    <Typography variant="body2" fontWeight={600}>
                      {s.title}
                    </Typography>
                  </Stack>
                  <Typography variant="caption" color="text.secondary" component="div">
                    {s.description}
                  </Typography>
                </Box>
                <Button
                  size="small"
                  variant="outlined"
                  disabled={st?.running}
                  onClick={() => run(s.id)}
                  startIcon={st?.running ? <CircularProgress size={14} /> : <IconPlayerPlay size={14} />}
                >
                  Rodar
                </Button>
              </Stack>
              {st?.result && (
                <Box component="ul" sx={{ m: 0, mt: 1, pl: 2.5, fontSize: 12, color: 'text.secondary' }}>
                  {st.result.steps.map((step) => (
                    <li key={step}>{step}</li>
                  ))}
                </Box>
              )}
              {st?.error && (
                <Typography variant="caption" color="error.main">
                  {st.error}
                </Typography>
              )}
            </Box>
          );
        })}
      </Stack>
    </Panel>
  );
}
