import { createHash } from 'crypto';
import { loadConfig } from '../config';
import {
  ConsensusSignal,
  SignalEvaluation,
  TraderMarketAction,
  TraderScore,
} from '../types';

/**
 * Consensus engine. Groups qualified traders' active positions and recent
 * trades by market + outcome, computes a battery of consensus metrics, and then
 * gates each candidate signal against the hard requirements in the spec.
 */

const HOUR_MS = 3600 * 1000;

/** Deterministic idempotency key for a market+outcome+day window. */
export function signalKey(usMarketSlug: string, outcome: string, dayBucket: string): string {
  return createHash('sha256')
    .update(`${usMarketSlug}::${outcome}::${dayBucket}`)
    .digest('hex')
    .slice(0, 32);
}

/** Whale cap: no single trader contributes more than this fraction of conviction. */
const WHALE_CAP_FRACTION = 0.25;

export interface MarketSnapshot {
  currentPrice: number; // 0..1
  spread: number;
  liquidityUsd: number;
  timeRemainingHours: number;
}

export interface ConsensusInput {
  usMarketSlug: string;
  outcome: string;
  question: string;
  actions: TraderMarketAction[]; // actions from qualified traders on this market+outcome
  scores: Map<string, TraderScore>;
  totalQualifiedTraders: number;
  snapshot: MarketSnapshot;
  now?: number;
}

/** Compute the raw consensus metrics for a single market+outcome group. */
export function computeConsensus(input: ConsensusInput): ConsensusSignal {
  const now = input.now ?? Date.now();
  const { actions, scores } = input;

  // One action per trader (their most recent) to avoid double counting.
  const latestByTrader = new Map<string, TraderMarketAction>();
  for (const a of actions) {
    const prev = latestByTrader.get(a.traderId);
    if (!prev || a.timestamp > prev.timestamp) latestByTrader.set(a.traderId, a);
  }
  const traderActions = Array.from(latestByTrader.values());
  const alignedTraders = traderActions.length;

  const alignedPct =
    input.totalQualifiedTraders > 0
      ? (alignedTraders / input.totalQualifiedTraders) * 100
      : 0;

  // Quality-weighted consensus: average trader score of aligned traders,
  // scaled by breadth (how many aligned vs the minimum required).
  const scoreVals = traderActions.map((a) => scores.get(a.traderId)?.score ?? 0);
  const avgScore =
    scoreVals.length > 0 ? scoreVals.reduce((a, b) => a + b, 0) / scoreVals.length : 0;
  const breadthFactor = Math.min(1, alignedTraders / Math.max(1, loadConfig().minConsensusTraders));
  const qualityWeightedScore = Math.round(avgScore * (0.7 + 0.3 * breadthFactor));

  // Capital-weighted conviction with a per-trader whale cap.
  const rawCapitals = traderActions.map((a) => Math.max(0, a.sizeUsd));
  const totalRaw = rawCapitals.reduce((a, b) => a + b, 0);
  const cap = totalRaw * WHALE_CAP_FRACTION;
  const cappedConviction = rawCapitals.reduce((a, c) => a + Math.min(c, cap), 0);

  // Average trader entry price across those that reported one.
  const entryPrices = traderActions
    .map((a) => a.entryPrice)
    .filter((p): p is number => typeof p === 'number' && p > 0 && p < 1);
  const avgEntry =
    entryPrices.length > 0 ? entryPrices.reduce((a, b) => a + b, 0) / entryPrices.length : 0;

  // Entry recency windows.
  const within = (h: number) => traderActions.filter((a) => now - a.timestamp <= h * HOUR_MS).length;

  // Net direction: majority vote across aligned traders.
  const dirCounts = { adding: 0, holding: 0, reducing: 0, exiting: 0 };
  for (const a of traderActions) dirCounts[a.direction]++;
  const netDirection = (Object.entries(dirCounts).sort((x, y) => y[1] - x[1])[0]?.[0] ??
    'holding') as ConsensusSignal['netDirection'];

  // Available upside: distance from current price to 1.0 for a long.
  const availableUpsidePct =
    input.snapshot.currentPrice > 0
      ? ((1 - input.snapshot.currentPrice) / input.snapshot.currentPrice) * 100
      : 0;

  const newestEntryTs = traderActions.reduce((m, a) => Math.max(m, a.timestamp), 0);

  const dayBucket = new Date(now).toISOString().slice(0, 10);

  return {
    id: signalKey(input.usMarketSlug, input.outcome, dayBucket),
    usMarketSlug: input.usMarketSlug,
    outcome: input.outcome,
    question: input.question,
    alignedTraders,
    alignedPct,
    qualityWeightedScore,
    capitalWeightedConvictionUsd: cappedConviction,
    avgTraderEntryPrice: avgEntry,
    currentMarketPrice: input.snapshot.currentPrice,
    entriesLast1h: within(1),
    entriesLast6h: within(6),
    entriesLast24h: within(24),
    entriesLast72h: within(72),
    netDirection,
    spread: input.snapshot.spread,
    liquidityUsd: input.snapshot.liquidityUsd,
    timeRemainingHours: input.snapshot.timeRemainingHours,
    availableUpsidePct,
    newestEntryTs,
    createdAt: now,
  };
}

export interface GateContext {
  hasConflictingPosition: boolean;
  mappingVerified: boolean;
  marketOpenAndTradeable: boolean;
  now?: number;
}

/**
 * Evaluate a computed signal against the hard gating rules. Returns the
 * decision plus a human-readable reason for every check (pass or fail), which
 * is exactly what the audit log and admin dashboard need.
 */
export function evaluateSignal(signal: ConsensusSignal, ctx: GateContext): SignalEvaluation {
  const cfg = loadConfig();
  const now = ctx.now ?? Date.now();
  const reasons: string[] = [];
  let ok = true;

  const check = (pass: boolean, passMsg: string, failMsg: string) => {
    reasons.push(pass ? `PASS: ${passMsg}` : `FAIL: ${failMsg}`);
    if (!pass) ok = false;
  };

  check(
    signal.alignedTraders >= cfg.minConsensusTraders,
    `${signal.alignedTraders} aligned traders (>= ${cfg.minConsensusTraders})`,
    `only ${signal.alignedTraders} aligned traders (< ${cfg.minConsensusTraders})`,
  );

  check(
    signal.qualityWeightedScore >= cfg.minConsensusScore,
    `consensus score ${signal.qualityWeightedScore} (>= ${cfg.minConsensusScore})`,
    `consensus score ${signal.qualityWeightedScore} (< ${cfg.minConsensusScore})`,
  );

  const ageHours = (now - signal.newestEntryTs) / HOUR_MS;
  check(
    signal.newestEntryTs > 0 && ageHours <= cfg.consensusMaxAgeHours,
    `newest supporting entry ${ageHours.toFixed(1)}h old`,
    `consensus is stale (newest entry ${ageHours.toFixed(1)}h old > ${cfg.consensusMaxAgeHours}h)`,
  );

  check(
    signal.entriesLast72h > 0,
    `${signal.entriesLast72h} recent entries in last 72h`,
    'no recent supporting entries in last 72h',
  );

  check(
    signal.netDirection === 'adding' || signal.netDirection === 'holding',
    `net direction is ${signal.netDirection}`,
    `net direction is ${signal.netDirection} (traders reducing/exiting)`,
  );

  check(
    ctx.marketOpenAndTradeable,
    'market is open and tradeable',
    'market is not open/tradeable',
  );

  check(
    signal.liquidityUsd >= cfg.exits.minExitLiquidityUsd,
    `liquidity $${signal.liquidityUsd.toFixed(0)} acceptable`,
    `insufficient liquidity ($${signal.liquidityUsd.toFixed(0)})`,
  );

  check(
    signal.spread >= 0 && signal.spread <= 0.1,
    `spread ${signal.spread.toFixed(3)} acceptable`,
    `spread too wide (${signal.spread.toFixed(3)})`,
  );

  check(
    signal.currentMarketPrice > 0.02 && signal.currentMarketPrice < 0.98,
    `price ${signal.currentMarketPrice.toFixed(3)} leaves room`,
    `price ${signal.currentMarketPrice.toFixed(3)} too extreme to trade`,
  );

  check(ctx.mappingVerified, 'US market mapping verified', 'US market mapping not verified');

  check(
    !ctx.hasConflictingPosition,
    'no conflicting existing position',
    'conflicting existing position present',
  );

  check(
    signal.timeRemainingHours > cfg.exits.approachingResolutionHours,
    `${signal.timeRemainingHours.toFixed(1)}h until resolution`,
    `too close to resolution (${signal.timeRemainingHours.toFixed(1)}h)`,
  );

  return { signal, decision: ok ? 'accepted' : 'rejected', reasons };
}
