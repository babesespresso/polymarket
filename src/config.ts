import * as dotenv from 'dotenv';

dotenv.config();

/**
 * Central, validated configuration. Reading config through this module keeps
 * secrets out of the rest of the codebase and makes the safety posture
 * explicit: anything ambiguous fails closed (defaults to the safest value).
 */

export type TradingMode = 'paper' | 'approval' | 'live';

function req(name: string): string {
  const v = process.env[name];
  if (v === undefined || v.trim() === '') {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return v.trim();
}

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    throw new Error(`Environment variable ${name} must be a number, got: ${raw}`);
  }
  return n;
}

function bool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  return raw.trim().toLowerCase() === 'true';
}

function parseMode(): TradingMode {
  const raw = (process.env.TRADING_MODE ?? 'paper').trim().toLowerCase();
  if (raw === 'paper' || raw === 'approval' || raw === 'live') return raw;
  // Fail closed: any unrecognised mode becomes paper.
  return 'paper';
}

export interface RiskLimits {
  maxTradeUsd: number;
  maxMarketExposureUsd: number;
  maxTotalExposureUsd: number;
  maxDailyLossUsd: number;
  maxOpenPositions: number;
  maxTradesPerDay: number;
  minCashReserveUsd: number;
}

export interface ExitPolicy {
  takeProfitPct: number;
  stopLossPct: number;
  maxHoldHours: number;
  approachingResolutionHours: number;
  minExitLiquidityUsd: number;
}

export interface Config {
  tradingMode: TradingMode;
  liveTradingFlag: boolean;
  /** True only when BOTH switches are set — the single source of truth for real orders. */
  liveExecutionEnabled: boolean;

  risk: RiskLimits;
  exits: ExitPolicy;

  minConsensusTraders: number;
  minConsensusScore: number;
  consensusMaxAgeHours: number;
  leaderboardSize: number;
  tradeCooldownMinutes: number;

  workerCycleMs: number;
  reconcileIntervalMs: number;

  databaseUrl: string;
  adminToken: string;
  port: number;

  publicDataApiBase: string;
  publicLeaderboardApiBase: string;
  disablePublicApi: boolean;
}

let cached: Config | null = null;

/**
 * Build and validate the full configuration. Throws on missing required
 * secrets so the process fails closed at startup rather than mid-trade.
 */
export function loadConfig(): Config {
  if (cached) return cached;

  const tradingMode = parseMode();
  const liveTradingFlag = bool('POLYMARKET_LIVE_TRADING', false);
  const liveExecutionEnabled = tradingMode === 'live' && liveTradingFlag;

  const risk: RiskLimits = {
    maxTradeUsd: num('MAX_TRADE_USD', 2),
    maxMarketExposureUsd: num('MAX_MARKET_EXPOSURE_USD', 4),
    maxTotalExposureUsd: num('MAX_TOTAL_EXPOSURE_USD', 20),
    maxDailyLossUsd: num('MAX_DAILY_LOSS_USD', 5),
    maxOpenPositions: num('MAX_OPEN_POSITIONS', 5),
    maxTradesPerDay: num('MAX_TRADES_PER_DAY', 10),
    minCashReserveUsd: num('MIN_CASH_RESERVE_USD', 20),
  };

  const exits: ExitPolicy = {
    takeProfitPct: num('TAKE_PROFIT_PCT', 25),
    stopLossPct: num('STOP_LOSS_PCT', 20),
    maxHoldHours: num('MAX_HOLD_HOURS', 168),
    approachingResolutionHours: num('APPROACHING_RESOLUTION_HOURS', 6),
    minExitLiquidityUsd: num('MIN_EXIT_LIQUIDITY_USD', 50),
  };

  const cfg: Config = {
    tradingMode,
    liveTradingFlag,
    liveExecutionEnabled,
    risk,
    exits,
    minConsensusTraders: num('MIN_CONSENSUS_TRADERS', 3),
    minConsensusScore: num('MIN_CONSENSUS_SCORE', 75),
    consensusMaxAgeHours: num('CONSENSUS_MAX_AGE_HOURS', 72),
    leaderboardSize: num('LEADERBOARD_SIZE', 25),
    tradeCooldownMinutes: num('TRADE_COOLDOWN_MINUTES', 60),
    workerCycleMs: num('WORKER_CYCLE_MS', 60_000),
    reconcileIntervalMs: num('RECONCILE_INTERVAL_MS', 300_000),
    databaseUrl: req('DATABASE_URL'),
    adminToken: process.env.ADMIN_TOKEN?.trim() ?? '',
    port: num('PORT', 8080),
    publicDataApiBase: (process.env.PUBLIC_DATA_API_BASE ?? 'https://data-api.polymarket.com').trim(),
    publicLeaderboardApiBase: (process.env.PUBLIC_LEADERBOARD_API_BASE ?? 'https://lb-api.polymarket.com').trim(),
    disablePublicApi: bool('DISABLE_PUBLIC_API', false),
  };

  validate(cfg);
  cached = cfg;
  return cfg;
}

function validate(cfg: Config): void {
  const problems: string[] = [];

  // Credentials must exist for the authenticated client. We read them here so
  // a missing secret is caught at startup, but we never store them on Config.
  if (!process.env.POLYMARKET_KEY_ID?.trim()) problems.push('POLYMARKET_KEY_ID is required');
  if (!process.env.POLYMARKET_SECRET_KEY?.trim()) problems.push('POLYMARKET_SECRET_KEY is required');

  if (cfg.risk.maxTradeUsd <= 0) problems.push('MAX_TRADE_USD must be > 0');
  if (cfg.risk.maxMarketExposureUsd < cfg.risk.maxTradeUsd) {
    problems.push('MAX_MARKET_EXPOSURE_USD must be >= MAX_TRADE_USD');
  }
  if (cfg.risk.maxTotalExposureUsd < cfg.risk.maxMarketExposureUsd) {
    problems.push('MAX_TOTAL_EXPOSURE_USD must be >= MAX_MARKET_EXPOSURE_USD');
  }
  if (cfg.risk.maxDailyLossUsd <= 0) problems.push('MAX_DAILY_LOSS_USD must be > 0');
  if (cfg.risk.minCashReserveUsd < 0) problems.push('MIN_CASH_RESERVE_USD must be >= 0');
  if (cfg.minConsensusTraders < 1) problems.push('MIN_CONSENSUS_TRADERS must be >= 1');
  if (cfg.minConsensusScore < 0 || cfg.minConsensusScore > 100) {
    problems.push('MIN_CONSENSUS_SCORE must be between 0 and 100');
  }
  if (!cfg.adminToken || cfg.adminToken.length < 16) {
    // Admin API is a control surface; a weak token is a real risk. Warn loudly
    // but do not block the worker (the worker can run headless).
    console.warn(
      '[config] ADMIN_TOKEN is missing or shorter than 16 chars. The admin ' +
        'dashboard/API will refuse to start until a strong token is set.',
    );
  }

  if (problems.length > 0) {
    throw new Error(`Invalid configuration (failing closed):\n  - ${problems.join('\n  - ')}`);
  }
}

/** Credentials are read on demand and never cached on the Config object. */
export function readCredentials(): { keyId: string; secretKey: string } {
  return {
    keyId: req('POLYMARKET_KEY_ID'),
    secretKey: req('POLYMARKET_SECRET_KEY'),
  };
}
