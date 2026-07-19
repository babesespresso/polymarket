import { loadConfig } from './config';
import { log } from './logger';
import { migrate } from './db/migrate';
import { startAdmin } from './admin/index';
import { startWorker } from './worker/index';

/**
 * Combined single-process entrypoint.
 *
 * Runs BOTH the admin dashboard (HTTP) and the execution worker in one process.
 * This exists so the whole system can be deployed as a SINGLE Railway service
 * with zero custom configuration: point a service at this repo, add Postgres +
 * env vars, generate a domain — done.
 *
 * For production you can still run them as two dedicated services (see the
 * Procfile) — `dist/worker/index.js` and `dist/admin/index.js` remain valid
 * standalone entrypoints. This combined mode is the easy default.
 *
 * Design choice: the admin dashboard always comes up first, and the worker is
 * started without letting a worker startup failure (e.g. invalid Polymarket
 * credentials) tear the process down. That way you can always reach the UI to
 * see status, fix variables, and use the controls — even before trading is live.
 */
async function main(): Promise<void> {
  const cfg = loadConfig();
  log.info('starting combined service (admin + worker)', { mode: cfg.tradingMode });

  // Apply the schema once, here, so neither sub-process races the other.
  await migrate();

  // Admin first, so the dashboard is reachable no matter what the worker does.
  await startAdmin(false);

  // Worker second; failures are logged but do not bring down the dashboard.
  void startWorker({ runMigrate: false, exitOnFatal: false });
}

main().catch((err) => {
  log.error('combined service failed to start', {
    error: err instanceof Error ? err.message : String(err),
  });
  process.exit(1);
});
