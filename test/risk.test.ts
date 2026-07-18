import { describe, it, expect } from 'vitest';
import { allViolations, ExposureState } from '../src/engine/limits';
import { RiskLimits } from '../src/config';

const LIMITS: RiskLimits = {
  maxTradeUsd: 2,
  maxMarketExposureUsd: 4,
  maxTotalExposureUsd: 20,
  maxDailyLossUsd: 5,
  maxOpenPositions: 5,
  maxTradesPerDay: 10,
  minCashReserveUsd: 20,
};

function state(over: Partial<ExposureState> = {}): ExposureState {
  return {
    notionalUsd: 2,
    marketExposureUsd: 0,
    totalExposureUsd: 0,
    openPositions: 0,
    tradesToday: 0,
    realizedPnlTodayUsd: 0,
    cashAvailableUsd: 100,
    ...over,
  };
}

describe('risk limit predicates', () => {
  it('allows a compliant proof-of-concept trade', () => {
    expect(allViolations(state(), LIMITS)).toHaveLength(0);
  });

  it('blocks trades above MAX_TRADE_USD', () => {
    const v = allViolations(state({ notionalUsd: 3 }), LIMITS);
    expect(v.some((x) => x.includes('MAX_TRADE_USD'))).toBe(true);
  });

  it('blocks exceeding per-market exposure', () => {
    const v = allViolations(state({ marketExposureUsd: 3, notionalUsd: 2 }), LIMITS);
    expect(v.some((x) => x.includes('MAX_MARKET_EXPOSURE_USD'))).toBe(true);
  });

  it('blocks exceeding total exposure', () => {
    const v = allViolations(state({ totalExposureUsd: 19, notionalUsd: 2 }), LIMITS);
    expect(v.some((x) => x.includes('MAX_TOTAL_EXPOSURE_USD'))).toBe(true);
  });

  it('blocks when max open positions reached', () => {
    const v = allViolations(state({ openPositions: 5 }), LIMITS);
    expect(v.some((x) => x.includes('MAX_OPEN_POSITIONS'))).toBe(true);
  });

  it('blocks when daily trade count reached', () => {
    const v = allViolations(state({ tradesToday: 10 }), LIMITS);
    expect(v.some((x) => x.includes('MAX_TRADES_PER_DAY'))).toBe(true);
  });

  it('blocks after the daily loss limit is breached', () => {
    const v = allViolations(state({ realizedPnlTodayUsd: -5 }), LIMITS);
    expect(v.some((x) => x.includes('MAX_DAILY_LOSS_USD'))).toBe(true);
  });

  it('preserves the minimum cash reserve', () => {
    const v = allViolations(state({ cashAvailableUsd: 21, notionalUsd: 2 }), LIMITS);
    expect(v.some((x) => x.includes('MIN_CASH_RESERVE_USD'))).toBe(true);
  });

  it('reports multiple simultaneous violations', () => {
    const v = allViolations(
      state({ notionalUsd: 10, openPositions: 5, realizedPnlTodayUsd: -6 }),
      LIMITS,
    );
    expect(v.length).toBeGreaterThanOrEqual(3);
  });
});
