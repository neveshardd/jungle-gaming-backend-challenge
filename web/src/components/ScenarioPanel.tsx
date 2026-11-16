import { Box, CircularProgress, Collapse, IconButton, Stack, Tooltip, Typography } from '@mui/material';
import { IconCircleCheckFilled, IconCircleXFilled, IconFlask, IconPlayerPlay } from '@tabler/icons-react';
import { useState } from 'react';
import type { Wallet } from '../api';
import { SCENARIOS, type ScenarioResult } from '../scenarios';
import { SURFACE } from '../theme';
import { Panel } from './common';

type State = { running: boolean; result?: ScenarioResult; error?: string };

/** One-click challenge scenarios: title + verdict, details on expand. */
export function ScenarioPanel({ onWallet }: { onWallet: (wallet: Wallet) => void }) {
  const [states, setStates] = useState<Record<string, State>>({});
  const [open, setOpen] = useState<string>();

  async function run(id: string) {
    const scenario = SCENARIOS.find((s) => s.id === id);
    if (!scenario) return;
    setStates((s) => ({ ...s, [id]: { running: true } }));
    try {
      const result = await scenario.run();
      if (result.wallet) onWallet(result.wallet);
      setStates((s) => ({ ...s, [id]: { running: false, result } }));
      setOpen(id);
    } catch (err) {
      setStates((s) => ({ ...s, [id]: { running: false, error: err instanceof Error ? err.message : String(err) } }));
      setOpen(id);
    }
  }

  return (
    <Panel title="Cenários" icon={<IconFlask size={18} />}>
      <Stack gap={0.5}>
        {SCENARIOS.map((s) => {
          const st = states[s.id];
          const passed = st?.error ? false : st?.result?.passed;
          return (
            <Box key={s.id} sx={{ bgcolor: SURFACE, borderRadius: 1 }}>
              <Stack direction="row" alignItems="center" gap={1} sx={{ pl: 1.25, pr: 0.5, py: 0.5 }}>
                <Box sx={{ width: 18, display: 'flex' }}>
                  {passed === true && <IconCircleCheckFilled size={18} color="#3ddc84" />}
                  {passed === false && <IconCircleXFilled size={18} color="#ff6b6b" />}
                </Box>
                <Typography
                  variant="body2"
                  fontWeight={500}
                  flex={1}
                  sx={{ cursor: 'pointer' }}
                  onClick={() => setOpen(open === s.id ? undefined : s.id)}
                >
                  {s.title}
                </Typography>
                <Tooltip title="Rodar">
                  <span>
                    <IconButton size="small" color="primary" disabled={st?.running} onClick={() => run(s.id)}>
                      {st?.running ? <CircularProgress size={16} /> : <IconPlayerPlay size={16} />}
                    </IconButton>
                  </span>
                </Tooltip>
              </Stack>
              <Collapse in={open === s.id}>
                <Box sx={{ px: 1.5, pb: 1.25, pl: 4.5 }}>
                  <Typography variant="caption" color="text.secondary" component="div">
                    {s.description}
                  </Typography>
                  {st?.result && (
                    <Box component="ul" sx={{ m: 0, mt: 0.75, pl: 2, fontSize: 12 }}>
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
              </Collapse>
            </Box>
          );
        })}
      </Stack>
    </Panel>
  );
}
