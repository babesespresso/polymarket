import { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';
import { loadConfig } from '../config';
import { log } from '../logger';

/**
 * Shared Postgres pool. Railway provides DATABASE_URL for its Postgres plugin.
 * SSL is enabled for non-local hosts; Railway's internal networking uses plain
 * connections, so we only require SSL when the URL is clearly external.
 */

let pool: Pool | null = null;

export function getPool(): Pool {
  if (pool) return pool;
  const cfg = loadConfig();
  const needsSsl = /sslmode=require/.test(cfg.databaseUrl) ||
    (!/localhost|127\.0\.0\.1|\.railway\.internal/.test(cfg.databaseUrl) &&
      /@[^/]+\.(com|net|io|dev|app|co)\b/.test(cfg.databaseUrl));
  pool = new Pool({
    connectionString: cfg.databaseUrl,
    max: 10,
    idleTimeoutMillis: 30_000,
    ssl: needsSsl ? { rejectUnauthorized: false } : undefined,
  });
  pool.on('error', (err) => log.error('pg pool error', { error: err.message }));
  return pool;
}

export async function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: unknown[],
): Promise<QueryResult<T>> {
  return getPool().query<T>(text, params as never[]);
}

/** Run a function inside a transaction, rolling back on any error. */
export async function withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
