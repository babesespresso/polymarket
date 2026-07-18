/**
 * Shared test environment. Imported first by config-dependent test files so
 * loadConfig() has the required variables and never hits a real network/DB.
 */
process.env.POLYMARKET_KEY_ID = process.env.POLYMARKET_KEY_ID ?? 'test-key-id';
process.env.POLYMARKET_SECRET_KEY = process.env.POLYMARKET_SECRET_KEY ?? 'test-secret-key';
process.env.DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://test:test@localhost:5432/test';
process.env.ADMIN_TOKEN = process.env.ADMIN_TOKEN ?? 'test-admin-token-abcdefgh';
process.env.TRADING_MODE = process.env.TRADING_MODE ?? 'paper';
process.env.MIN_CONSENSUS_TRADERS = '3';
process.env.MIN_CONSENSUS_SCORE = '75';
process.env.DISABLE_PUBLIC_API = 'true';

export {};
