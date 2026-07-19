import { randomUUID } from 'crypto';
import { hostname } from 'os';
import { loadConfig } from '../config';
import { log } from '../logger';
import { audit } from '../db/audit';
import { migrate } from '../db/migrate';
import { closePool } from '../db/index';
import { validateAuthentication } from '../polymarket/client';
import { reconcile } from '../engine/reconcile';
import { runCycle } from './cycle';
import { WsManager } from '../ws/manager';
import { acquireLease, releaseLease, upsertHealth } from '../db/repo';
import { WorkerHealth } from '../types';

/**
 * Long-running execution worker. This is the always-on Railway process,
 * separate from the admin web UI. It:
 *   - fails closed on config/auth errors,
 *   - holds a distributed lease so only ONE execution worker acts at a time,
 *   - runs decision cycles on an interval (polling), backed by live WebSockets,
 *   - reconciles exchange vs DB on startup and periodically,
 *   - reports health/heartbeat continuously and recovers on restart.
 */

const LOCK_NAME = 'consensus-trader-execution';
const LEASE_TTL_SECONDS = 90;

const workerId = `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;
const startedAt = Date.now();

const health: WorkerHealth = {
  workerId,
  leaseHolder: false,
  lastCycleAt: null,
  lastCycleStatus: 'starting',
  wsMarketsConnected: false,
  wsPrivateConnected: false,
  errorState: null,
  tradingPaused: false,
  killSwitchActive: false,
  startedAt,
};

const ws = new WsManager();
let stopping = false;
let consecutiveErrors = 0;
let lastReconcileAt = 0;

async function writeHealth(): Promise<void> {
  health.wsMarketsConnected = ws.status.marketsConnected;
  health.wsPrivateConnected = ws.status.privateConnected;
  await upsertHealth(health).catch((e) => log.warn('health write failed', { error: String(e) }));
}

async function heartbeatLease(): Promise<boolean> {
  const held = await acquireLease(LOCK_NAME, workerId, LEASE_TTL_SECONDS);
  health.leaseHolder = held;
  return held;
}

async function tick(): Promise<void> {
  if (stopping) return;
  const cfg = loadConfig();

  // Only the lease holder runs cycles. A standby worker keeps heartbeating and
  // will take over if the holder's lease expires (restart recovery).
  const held = await heartbeatLease();
  if (!held) {
    health.lastCycleStatus = 'ok';
    await writeHealth();
    log.debug('standby: another worker holds the execution lease');
    return;
  }

  // Periodic reconciliation. A failure halts new trading for this cycle.
  if (Date.now() - lastReconcileAt >= cfg.reconcileIntervalMs) {
    const rec = await reconcile();
    lastReconcileAt = Date.now();
    if (!rec.ok) {
      consecutiveErrors++;
      health.lastCycleStatus = 'error';
      health.errorState = `reconciliation failed: ${rec.error ?? 'unknown'}`;
      await writeHealth();
      log.error('halting cycle: reconciliation failed', { error: rec.error });
      return;
    }
  }

  // WebSocket desync is a stop-new-trading condition; the cycle still runs to
  // manage exits but execution is guarded by the halt logic in the cycle/risk.
  if (ws.status.desynced) {
    log.warn('websockets desynced — running on polling fallback');
  }

  try {
    const result = await runCycle();
    consecutiveErrors = 0;
    health.lastCycleAt = Date.now();
    health.lastCycleStatus = 'ok';
    health.errorState = null;
    ws.updateTrackedMarkets(result.trackedSlugs);
    await writeHealth();
    log.info('cycle complete', { ...result });
  } catch (err) {
    consecutiveErrors++;
    health.lastCycleAt = Date.now();
    health.lastCycleStatus = 'error';
    health.errorState = err instanceof Error ? err.message : String(err);
    await writeHealth();
    await audit('worker', 'cycle_error', { error: health.errorState, consecutiveErrors });
    log.error('cycle failed', { error: health.errorState, consecutiveErrors });

    // Repeated API/errors: back off progressively to avoid hammering the API.
    if (consecutiveErrors >= 3) {
      const backoff = Math.min(60_000, 5000 * consecutiveErrors);
      log.warn('repeated errors — backing off', { backoffMs: backoff });
      await new Promise((r) => setTimeout(r, backoff));
    }
  }
}

async function main(runMigrate = true): Promise<void> {
  const cfg = loadConfig();
  log.info('starting consensus trader worker', {
    workerId,
    mode: cfg.tradingMode,
    liveExecution: cfg.liveExecutionEnabled,
  });

  // Fail closed: schema, then authentication, before anything else.
  if (runMigrate) await migrate();
  await validateAuthentication();
  await audit('worker', 'worker_started', {
    workerId,
    mode: cfg.tradingMode,
    liveExecution: cfg.liveExecutionEnabled,
  });

  // Startup reconciliation (restart recovery).
  const rec = await reconcile();
  lastReconcileAt = Date.now();
  if (!rec.ok) {
    log.error('startup reconciliation failed — will retry on cycle, not trading yet', {
      error: rec.error,
    });
  }

  // Bring up WebSockets (non-fatal if they fail; polling fallback covers it).
  ws.onPrivateUpdate = () => {
    // A private update means order/position/balance changed; trigger a fast
    // reconcile on the next tick by resetting the reconcile timer.
    lastReconcileAt = 0;
  };
  await ws.start([]).catch((e) => log.warn('ws start failed', { error: String(e) }));

  health.lastCycleStatus = 'ok';
  await writeHealth();

  // Main loop.
  const loop = async () => {
    while (!stopping) {
      await tick();
      await new Promise((r) => setTimeout(r, cfg.workerCycleMs));
    }
  };
  void loop();
}

async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  log.info('shutting down', { signal });
  await audit('worker', 'worker_stopping', { workerId, signal }).catch(() => {});
  await ws.stop().catch(() => {});
  await releaseLease(LOCK_NAME, workerId).catch(() => {});
  health.leaseHolder = false;
  health.lastCycleStatus = 'ok';
  await writeHealth().catch(() => {});
  await closePool().catch(() => {});
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('unhandledRejection', (reason) => {
  log.error('unhandled rejection', { reason: String(reason) });
});

/**
 * Start the worker. When `exitOnFatal` is true (the dedicated worker service),
 * a fatal startup error kills the process — fail-closed. When false (the
 * combined single-service entrypoint), a fatal error is logged but the process
 * keeps running so the admin dashboard stays available; the worker will retry
 * on its next tick / restart.
 */
export async function startWorker(
  opts: { runMigrate?: boolean; exitOnFatal?: boolean } = {},
): Promise<void> {
  const { runMigrate = true, exitOnFatal = true } = opts;
  try {
    await main(runMigrate);
  } catch (err) {
    log.error('fatal startup error (failing closed)', {
      error: err instanceof Error ? err.message : String(err),
    });
    await audit('system', 'worker_fatal', {
      error: err instanceof Error ? err.message : String(err),
    }).catch(() => {});
    if (exitOnFatal) {
      await closePool().catch(() => {});
      process.exit(1);
    }
  }
}

// Run standalone only when invoked directly (not when imported by the combined
// entrypoint). This keeps the dedicated worker service working unchanged.
if (require.main === module) {
  void startWorker({ exitOnFatal: true });
}
