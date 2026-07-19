import path from 'path';
import express, { Request, Response } from 'express';
import { loadConfig } from '../config';
import { log } from '../logger';
import { migrate } from '../db/migrate';
import { audit } from '../db/audit';
import { requireAdmin } from './auth';
import { getClient } from '../polymarket/client';
import {
  getControlState,
  getHealth,
  getTodayStats,
  latestScores,
  listPositions,
  recentOrders,
  recentSignals,
  setControlState,
  totalExposureUsd,
} from '../db/repo';

/**
 * Secure admin-only dashboard + control API. Separate service from the worker.
 * Every route requires the admin bearer token. Destructive controls require a
 * typed confirmation string and are written to the immutable audit log.
 */

const app = express();
app.use(express.json({ limit: '256kb' }));

// Health check is public (Railway probes it); it exposes no sensitive data.
app.get('/healthz', (_req: Request, res: Response) => {
  res.json({ ok: true, service: 'consensus-trader-admin' });
});

// Static dashboard (the page itself asks for the token and stores it in-memory).
app.use('/', express.static(path.join(__dirname, 'public')));

// Everything under /api/admin requires the admin token.
app.use('/api/admin', requireAdmin);

app.get('/api/admin/overview', async (_req: Request, res: Response) => {
  try {
    const cfg = loadConfig();
    const [control, health, scores, positions, orders, signals, today, exposure] =
      await Promise.all([
        getControlState(),
        getHealth(),
        latestScores(),
        listPositions(),
        recentOrders(50),
        recentSignals(50),
        getTodayStats(),
        totalExposureUsd(),
      ]);

    // Live balances (best-effort; never returns credentials).
    let balances: unknown = null;
    try {
      balances = (await getClient().account.balances()).balances;
    } catch (e) {
      balances = { error: e instanceof Error ? e.message : String(e) };
    }

    const unrealized = positions.reduce((a, p) => a + (p.unrealizedPnlUsd ?? 0), 0);
    const realizedToday = today.realizedPnlUsd;

    res.json({
      mode: cfg.tradingMode,
      liveExecutionEnabled: cfg.liveExecutionEnabled,
      limits: cfg.risk,
      exitPolicy: cfg.exits,
      consensus: {
        minConsensusTraders: cfg.minConsensusTraders,
        minConsensusScore: cfg.minConsensusScore,
      },
      control,
      health,
      balances,
      exposureUsd: exposure,
      pnl: { realizedToday, unrealized },
      today,
      scores: scores.slice(0, 30),
      positions,
      orders,
      signals,
    });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// --- Controls (all require confirmation + audit) ----------------------------

function actor(req: Request): string {
  return (req as Request & { adminActor: string }).adminActor ?? 'admin:unknown';
}

function confirmed(req: Request, expected: string): boolean {
  return typeof req.body?.confirm === 'string' && req.body.confirm === expected;
}

app.post('/api/admin/pause', async (req: Request, res: Response) => {
  const paused = req.body?.paused !== false;
  await setControlState({ tradingPaused: paused }, actor(req));
  await audit(actor(req), paused ? 'admin_pause_trades' : 'admin_resume_trades', { paused });
  res.json({ ok: true, tradingPaused: paused });
});

app.post('/api/admin/kill-switch', async (req: Request, res: Response) => {
  if (!confirmed(req, 'ACTIVATE KILL SWITCH')) {
    res.status(400).json({ error: 'confirmation required: send { "confirm": "ACTIVATE KILL SWITCH" }' });
    return;
  }
  await setControlState({ killSwitchActive: true, tradingPaused: true }, actor(req));
  await audit(actor(req), 'admin_kill_switch_activated', {});
  res.json({ ok: true, killSwitchActive: true });
});

app.post('/api/admin/kill-switch/reset', async (req: Request, res: Response) => {
  if (!confirmed(req, 'RESET KILL SWITCH')) {
    res.status(400).json({ error: 'confirmation required: send { "confirm": "RESET KILL SWITCH" }' });
    return;
  }
  await setControlState({ killSwitchActive: false }, actor(req));
  await audit(actor(req), 'admin_kill_switch_reset', {});
  res.json({ ok: true, killSwitchActive: false });
});

app.post('/api/admin/cancel-orders', async (req: Request, res: Response) => {
  if (!confirmed(req, 'CANCEL ALL ORDERS')) {
    res.status(400).json({ error: 'confirmation required: send { "confirm": "CANCEL ALL ORDERS" }' });
    return;
  }
  const cfg = loadConfig();
  try {
    let result: unknown = { note: 'not live — no exchange orders to cancel' };
    if (cfg.liveExecutionEnabled) {
      result = await getClient().orders.cancelAll();
    }
    await audit(actor(req), 'admin_cancel_all_orders', { result });
    res.json({ ok: true, result });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.post('/api/admin/close-positions', async (req: Request, res: Response) => {
  if (!confirmed(req, 'CLOSE ALL POSITIONS')) {
    res.status(400).json({ error: 'confirmation required: send { "confirm": "CLOSE ALL POSITIONS" }' });
    return;
  }
  const cfg = loadConfig();
  try {
    const positions = await listPositions();
    const results: Record<string, unknown> = {};
    if (cfg.liveExecutionEnabled) {
      for (const p of positions) {
        try {
          results[p.usMarketSlug] = await getClient().orders.closePosition({
            marketSlug: p.usMarketSlug,
            slippageTolerance: { currentPrice: { value: '0.50', currency: 'USD' }, bips: 300 },
          });
        } catch (e) {
          results[p.usMarketSlug] = { error: e instanceof Error ? e.message : String(e) };
        }
      }
    } else {
      results.note = 'not live — recorded intent only';
    }
    await audit(actor(req), 'admin_close_all_positions', { count: positions.length, results });
    res.json({ ok: true, count: positions.length, results });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

export async function startAdmin(runMigrate = true): Promise<void> {
  const cfg = loadConfig();
  if (runMigrate) await migrate();
  app.listen(cfg.port, () => {
    log.info('admin dashboard listening', { port: cfg.port });
  });
}

// Run standalone only when invoked directly (not when imported by the combined
// entrypoint). This keeps the dedicated admin service working unchanged.
if (require.main === module) {
  startAdmin().catch((err) => {
    log.error('admin failed to start', { error: err instanceof Error ? err.message : String(err) });
    process.exit(1);
  });
}
