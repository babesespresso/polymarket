import { RiskLimits } from '../config';

/**
 * Pure limit predicates. Separated from the DB-bound risk gate so the core
 * money-safety math can be tested exhaustively in isolation. Each returns a
 * violation string, or null if the check passes.
 */

export interface ExposureState {
  notionalUsd: number;
  marketExposureUsd: number;
  totalExposureUsd: number;
  openPositions: number;
  tradesToday: number;
  realizedPnlTodayUsd: number;
  cashAvailableUsd: number;
}

const EPS = 1e-9;

export function violatesPerTrade(s: ExposureState, l: RiskLimits): string | null {
  return s.notionalUsd > l.maxTradeUsd + EPS
    ? `trade $${s.notionalUsd.toFixed(2)} > MAX_TRADE_USD $${l.maxTradeUsd}`
    : null;
}

export function violatesMarketExposure(s: ExposureState, l: RiskLimits): string | null {
  return s.marketExposureUsd + s.notionalUsd > l.maxMarketExposureUsd + EPS
    ? `market exposure would exceed MAX_MARKET_EXPOSURE_USD $${l.maxMarketExposureUsd}`
    : null;
}

export function violatesTotalExposure(s: ExposureState, l: RiskLimits): string | null {
  return s.totalExposureUsd + s.notionalUsd > l.maxTotalExposureUsd + EPS
    ? `total exposure would exceed MAX_TOTAL_EXPOSURE_USD $${l.maxTotalExposureUsd}`
    : null;
}

export function violatesOpenPositions(s: ExposureState, l: RiskLimits): string | null {
  return s.openPositions >= l.maxOpenPositions
    ? `open positions ${s.openPositions} >= MAX_OPEN_POSITIONS ${l.maxOpenPositions}`
    : null;
}

export function violatesDailyTrades(s: ExposureState, l: RiskLimits): string | null {
  return s.tradesToday >= l.maxTradesPerDay
    ? `daily trades ${s.tradesToday} >= MAX_TRADES_PER_DAY ${l.maxTradesPerDay}`
    : null;
}

export function violatesDailyLoss(s: ExposureState, l: RiskLimits): string | null {
  return s.realizedPnlTodayUsd <= -Math.abs(l.maxDailyLossUsd)
    ? `daily loss $${s.realizedPnlTodayUsd.toFixed(2)} breached MAX_DAILY_LOSS_USD $${l.maxDailyLossUsd}`
    : null;
}

export function violatesCashReserve(s: ExposureState, l: RiskLimits): string | null {
  return s.cashAvailableUsd - s.notionalUsd < l.minCashReserveUsd
    ? `would drop cash below MIN_CASH_RESERVE_USD $${l.minCashReserveUsd}`
    : null;
}

/** Returns all violations for a candidate trade (empty = allowed). */
export function allViolations(s: ExposureState, l: RiskLimits): string[] {
  return [
    violatesPerTrade(s, l),
    violatesMarketExposure(s, l),
    violatesTotalExposure(s, l),
    violatesOpenPositions(s, l),
    violatesDailyTrades(s, l),
    violatesDailyLoss(s, l),
    violatesCashReserve(s, l),
  ].filter((v): v is string => v !== null);
}
