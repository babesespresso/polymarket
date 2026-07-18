import { TraderHistory, TraderScore } from '../types';

/**
 * Transparent 0..100 Trader Quality Score.
 *
 * The score rewards *repeatable, risk-adjusted* performance and explicitly
 * refuses to rank on raw dollar PnL. Each component is normalised to 0..1, then
 * combined with fixed weights into a 0..100 base. Penalties (also 0..1) then
 * multiplicatively discount the base for the failure modes the spec calls out:
 * tiny samples, one oversized win, unrealised PnL, inactivity, excessive
 * concentration, and contradictory trades.
 *
 * Every component and penalty is returned alongside the score so the admin
 * dashboard can show exactly why a trader ranks where they do.
 */

// Component weights sum to 1.0.
const WEIGHTS = {
  returnOnCapital: 0.22,
  winRate: 0.14,
  profitFactor: 0.18,
  avgResolvedReturn: 0.14,
  consistency: 0.16,
  drawdown: 0.1,
  sampleSize: 0.06,
} as const;

const clamp01 = (n: number): number => (n < 0 ? 0 : n > 1 ? 1 : n);

/** Smoothly map an unbounded ratio into 0..1 via a saturating curve. */
function saturate(value: number, scale: number): number {
  if (value <= 0) return 0;
  return clamp01(value / (value + scale));
}

export function scoreTrader(h: TraderHistory, now = Date.now()): TraderScore {
  // --- Components (each 0..1) ---
  const returnOnCapital = saturate(
    h.deployedCapitalUsd > 0 ? h.realizedPnlUsd / h.deployedCapitalUsd : 0,
    0.25, // a 25% return on deployed capital scores ~0.5
  );

  const totalResolved = h.wins + h.losses;
  const winRate = totalResolved > 0 ? clamp01(h.wins / totalResolved) : 0;

  // Profit factor = gross profit / gross loss. 1.0 is break-even.
  const profitFactorRaw =
    h.grossLossUsd > 0 ? h.grossProfitUsd / h.grossLossUsd : h.grossProfitUsd > 0 ? 4 : 0;
  const profitFactor = saturate(Math.max(0, profitFactorRaw - 1), 1.5);

  const avgResolvedReturn = saturate(Math.max(0, h.avgResolvedReturnPct) / 100, 0.25);

  const consistency = clamp01(
    (Math.max(0, h.consistency7dPct) / 100) * 0.4 +
      (Math.max(0, h.consistency30dPct) / 100) * 0.6,
  );

  // Lower drawdown is better. 0% dd -> 1.0, 50%+ dd -> ~0.
  const drawdown = clamp01(1 - Math.min(1, Math.max(0, h.maxDrawdownPct) / 50));

  const sampleSize = saturate(h.resolvedMarkets, 20); // ~20 resolved markets -> 0.5

  const components: Record<string, number> = {
    returnOnCapital,
    winRate,
    profitFactor,
    avgResolvedReturn,
    consistency,
    drawdown,
    sampleSize,
  };

  const base =
    (returnOnCapital * WEIGHTS.returnOnCapital +
      winRate * WEIGHTS.winRate +
      profitFactor * WEIGHTS.profitFactor +
      avgResolvedReturn * WEIGHTS.avgResolvedReturn +
      consistency * WEIGHTS.consistency +
      drawdown * WEIGHTS.drawdown +
      sampleSize * WEIGHTS.sampleSize) *
    100;

  // --- Penalties (each is a multiplier in 0..1; 1 = no penalty) ---
  const penalties: Record<string, number> = {};

  // Tiny sample: below 5 resolved markets is heavily discounted.
  penalties.tinySample =
    h.resolvedMarkets >= 10 ? 1 : h.resolvedMarkets <= 1 ? 0.25 : 0.25 + 0.075 * (h.resolvedMarkets - 1);

  // One oversized win dominating gross profit.
  penalties.oversizedWin =
    h.topWinConcentration <= 0.4 ? 1 : clamp01(1 - (h.topWinConcentration - 0.4) * 1.2);

  // Unrealised PnL relative to realised: reward realised, discount paper gains.
  const unrealisedShare =
    Math.abs(h.realizedPnlUsd) + Math.abs(h.unrealizedPnlUsd) > 0
      ? Math.abs(h.unrealizedPnlUsd) / (Math.abs(h.realizedPnlUsd) + Math.abs(h.unrealizedPnlUsd))
      : 0;
  penalties.unrealisedHeavy = clamp01(1 - unrealisedShare * 0.5);

  // Inactivity: no activity in 14+ days is discounted; 30+ days heavily.
  const daysInactive = (now - h.lastActiveTs) / (24 * 3600 * 1000);
  penalties.inactivity =
    daysInactive <= 7 ? 1 : daysInactive >= 30 ? 0.4 : clamp01(1 - (daysInactive - 7) * 0.026);

  // Excessive market concentration (Herfindahl close to 1 = one market).
  penalties.concentration =
    h.marketConcentration <= 0.3 ? 1 : clamp01(1 - (h.marketConcentration - 0.3) * 1.0);

  // Contradictory trades (holding both sides / rapid flips).
  penalties.contradictory =
    h.contradictoryTrades <= 0 ? 1 : clamp01(1 - h.contradictoryTrades * 0.1);

  const penaltyMultiplier = Object.values(penalties).reduce((a, p) => a * p, 1);
  const score = Math.round(clamp01(base / 100) * penaltyMultiplier * 100);

  // A trader must clear a minimum bar to be considered "qualified" for
  // consensus at all, independent of the configurable consensus threshold.
  const qualified =
    score >= 50 &&
    h.resolvedMarkets >= 5 &&
    totalResolved > 0 &&
    daysInactive <= 30 &&
    profitFactorRaw >= 1.1;

  return {
    traderId: h.traderId,
    handle: h.handle,
    score,
    qualified,
    components,
    penalties,
    computedAt: now,
  };
}

export function scoreAll(histories: TraderHistory[], now = Date.now()): TraderScore[] {
  return histories.map((h) => scoreTrader(h, now)).sort((a, b) => b.score - a.score);
}
