import { readFileSync } from 'fs';
import { join } from 'path';
import { getPool, closePool } from './index';
import { log } from '../logger';

/**
 * Applies the idempotent schema. Safe to run on every deploy/startup.
 */
export async function migrate(): Promise<void> {
  const sql = readFileSync(join(__dirname, 'schema.sql'), 'utf8');
  await getPool().query(sql);
  log.info('database schema applied');
}

if (require.main === module) {
  migrate()
    .then(() => closePool())
    .then(() => process.exit(0))
    .catch((err) => {
      log.error('migration failed', { error: err instanceof Error ? err.message : String(err) });
      process.exit(1);
    });
}
