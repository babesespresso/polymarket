import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Keep this test hermetic: never let dotenv load a real .env file from disk,
// so the fail-closed assertions depend only on process.env set here.
vi.mock('dotenv', () => ({ config: () => ({ parsed: {} }) }));

/**
 * Config must fail closed. We reset the module registry between cases so each
 * test re-evaluates loadConfig() with a fresh environment (the config module
 * memoises its result internally).
 */
describe('config fail-closed behaviour', () => {
  const saved = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    for (const k of Object.keys(process.env)) delete process.env[k];
    Object.assign(process.env, {
      POLYMARKET_KEY_ID: 'k',
      POLYMARKET_SECRET_KEY: 's',
      DATABASE_URL: 'postgres://x',
      ADMIN_TOKEN: 'a-very-strong-admin-token',
    });
  });

  afterEach(() => {
    for (const k of Object.keys(process.env)) delete process.env[k];
    Object.assign(process.env, saved);
  });

  async function fresh() {
    return (await import('../src/config')).loadConfig;
  }

  it('defaults to paper mode and live disabled', async () => {
    const loadConfig = await fresh();
    const cfg = loadConfig();
    expect(cfg.tradingMode).toBe('paper');
    expect(cfg.liveExecutionEnabled).toBe(false);
  });

  it('an unrecognised TRADING_MODE falls back to paper', async () => {
    process.env.TRADING_MODE = 'YOLO';
    const loadConfig = await fresh();
    expect(loadConfig().tradingMode).toBe('paper');
  });

  it('live requires BOTH switches', async () => {
    process.env.TRADING_MODE = 'live';
    process.env.POLYMARKET_LIVE_TRADING = 'false';
    const loadConfig = await fresh();
    expect(loadConfig().liveExecutionEnabled).toBe(false);
  });

  it('live enabled only when mode=live AND flag=true', async () => {
    process.env.TRADING_MODE = 'live';
    process.env.POLYMARKET_LIVE_TRADING = 'true';
    const loadConfig = await fresh();
    expect(loadConfig().liveExecutionEnabled).toBe(true);
  });

  it('throws when required credentials are missing', async () => {
    delete process.env.POLYMARKET_KEY_ID;
    const loadConfig = await fresh();
    expect(() => loadConfig()).toThrow(/POLYMARKET_KEY_ID/);
  });

  it('rejects inconsistent exposure limits', async () => {
    process.env.MAX_TRADE_USD = '10';
    process.env.MAX_MARKET_EXPOSURE_USD = '5'; // < per-trade
    const loadConfig = await fresh();
    expect(() => loadConfig()).toThrow(/MAX_MARKET_EXPOSURE_USD/);
  });
});
