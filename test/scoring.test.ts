import { describe, it, expect } from 'vitest';
import { scoreTrader } from '../src/engine/scoring';
import { TraderHistory } from '../src/types';

const NOW = 1_700_000_000_000;

function baseHistory(overrides: Partial<TraderHistory> = {}): TraderHistory {
  return {
    traderId: 't1',
    handle: 'alpha',
    realizedPnlUsd: 5000,
    deployedCapitalUsd: 20000,
    wins: 30,
    losses: 15,
    grossProfitUsd: 9000,
    grossLossUsd: 4000,
    resolvedMarkets: 45,
    avgResolvedReturnPct: 20,
    maxDrawdownPct: 15,
    topWinConcentration: 0.2,
    marketConcentration: 0.2,
    consistency7dPct: 60,
    consistency30dPct: 65,
    unrealizedPnlUsd: 500,
    lastActiveTs: NOW - 2 * 24 * 3600 * 1000,
    contradictoryTrades: 0,
    ...overrides,
  };
}

describe('scoreTrader', () => {
  it('produces a score in 0..100', () => {
    const s = scoreTrader(baseHistory(), NOW);
    expect(s.score).toBeGreaterThanOrEqual(0);
    expect(s.score).toBeLessThanOrEqual(100);
  });

  it('qualifies a strong, consistent, well-sampled trader', () => {
    const s = scoreTrader(baseHistory(), NOW);
    expect(s.qualified).toBe(true);
    expect(s.score).toBeGreaterThan(50);
  });

  it('does not rank on raw dollar PnL: a huge single-win trader with tiny sample scores low', () => {
    const whale = scoreTrader(
      baseHistory({
        realizedPnlUsd: 1_000_000,
        grossProfitUsd: 1_000_000,
        grossLossUsd: 0,
        wins: 1,
        losses: 0,
        resolvedMarkets: 1,
        topWinConcentration: 1,
        deployedCapitalUsd: 1_000_000,
      }),
      NOW,
    );
    const steady = scoreTrader(baseHistory(), NOW);
    expect(whale.score).toBeLessThan(steady.score);
    expect(whale.qualified).toBe(false); // tiny sample must not qualify
  });

  it('penalises tiny sample sizes', () => {
    const big = scoreTrader(baseHistory({ resolvedMarkets: 45 }), NOW);
    const tiny = scoreTrader(baseHistory({ resolvedMarkets: 2 }), NOW);
    expect(tiny.penalties.tinySample).toBeLessThan(1);
    expect(tiny.score).toBeLessThan(big.score);
  });

  it('penalises inactivity heavily', () => {
    const active = scoreTrader(baseHistory({ lastActiveTs: NOW - 1 * 24 * 3600 * 1000 }), NOW);
    const stale = scoreTrader(baseHistory({ lastActiveTs: NOW - 45 * 24 * 3600 * 1000 }), NOW);
    expect(stale.penalties.inactivity).toBeLessThan(active.penalties.inactivity);
    expect(stale.qualified).toBe(false);
  });

  it('penalises excessive market concentration', () => {
    const diversified = scoreTrader(baseHistory({ marketConcentration: 0.1 }), NOW);
    const concentrated = scoreTrader(baseHistory({ marketConcentration: 0.9 }), NOW);
    expect(concentrated.penalties.concentration).toBeLessThan(diversified.penalties.concentration);
  });

  it('penalises contradictory trades', () => {
    const clean = scoreTrader(baseHistory({ contradictoryTrades: 0 }), NOW);
    const messy = scoreTrader(baseHistory({ contradictoryTrades: 5 }), NOW);
    expect(messy.penalties.contradictory).toBeLessThan(clean.penalties.contradictory);
  });

  it('rejects break-even/negative profit factor from qualifying', () => {
    const s = scoreTrader(
      baseHistory({ grossProfitUsd: 1000, grossLossUsd: 1000, realizedPnlUsd: 0 }),
      NOW,
    );
    expect(s.qualified).toBe(false);
  });

  it('exposes all component and penalty breakdowns for transparency', () => {
    const s = scoreTrader(baseHistory(), NOW);
    expect(Object.keys(s.components)).toContain('returnOnCapital');
    expect(Object.keys(s.components)).toContain('profitFactor');
    expect(Object.keys(s.penalties)).toContain('tinySample');
    expect(Object.keys(s.penalties)).toContain('oversizedWin');
  });
});
