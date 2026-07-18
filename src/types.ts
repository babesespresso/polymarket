/**
 * Domain types shared across the engine. These are deliberately independent of
 * the polymarket-us SDK response shapes so the rest of the code depends on our
 * own vocabulary, not the wire format.
 */

export type LeaderboardPeriod = 'DAY' | 'WEEK' | 'MONTH' | 'ALL';

export interface LeaderboardEntry {
  traderId: string; // proxy wallet / user id from the public leaderboard
  handle?: string;
  period: LeaderboardPeriod;
  rank: number;
  /** Raw dollar PnL reported by the leaderboard. Never used alone for ranking. */
  pnlUsd: number;
  volumeUsd?: number;
}

/** A public position or trade attributed to a ranked trader. */
export interface TraderMarketAction {
  traderId: string;
  /** Global Polymarket market identifier (condition id / slug). */
  globalMarketId: string;
  marketQuestion: string;
  outcome: string; // e.g. "Yes" / a team name
  /** Signed size: positive = long the outcome. */
  sizeUsd: number;
  entryPrice?: number; // 0..1
  /** Whether the trader is adding / holding / reducing / exiting. */
  direction: 'adding' | 'holding' | 'reducing' | 'exiting';
  timestamp: number; // epoch ms of the most recent supporting action
  resolved?: boolean;
  realizedPnlUsd?: number;
}

/** Aggregated, resolved-market history for a single trader (for scoring). */
export interface TraderHistory {
  traderId: string;
  handle?: string;
  realizedPnlUsd: number;
  deployedCapitalUsd: number;
  wins: number;
  losses: number;
  grossProfitUsd: number;
  grossLossUsd: number;
  resolvedMarkets: number;
  avgResolvedReturnPct: number;
  maxDrawdownPct: number;
  /** Fraction of realized PnL attributable to the single biggest win (0..1). */
  topWinConcentration: number;
  /** Herfindahl-style market concentration (0..1); higher = more concentrated. */
  marketConcentration: number;
  consistency7dPct: number;
  consistency30dPct: number;
  unrealizedPnlUsd: number;
  lastActiveTs: number;
  /** Count of contradictory positions (holding both sides / rapid flips). */
  contradictoryTrades: number;
}

export interface TraderScore {
  traderId: string;
  handle?: string;
  score: number; // 0..100
  qualified: boolean;
  components: Record<string, number>;
  penalties: Record<string, number>;
  computedAt: number;
}

/** A verified mapping from a global market/outcome to a Polymarket US market. */
export interface MarketMapping {
  globalMarketId: string;
  usMarketSlug: string;
  outcome: string;
  question: string;
  closeTimeIso: string;
  resolutionSource: string;
  verified: boolean;
  reason: string; // why accepted or rejected
}

export interface ConsensusSignal {
  id: string; // deterministic idempotency key
  usMarketSlug: string;
  outcome: string;
  question: string;
  alignedTraders: number;
  alignedPct: number;
  qualityWeightedScore: number; // 0..100
  capitalWeightedConvictionUsd: number;
  avgTraderEntryPrice: number;
  currentMarketPrice: number;
  entriesLast1h: number;
  entriesLast6h: number;
  entriesLast24h: number;
  entriesLast72h: number;
  netDirection: 'adding' | 'holding' | 'reducing' | 'exiting';
  spread: number;
  liquidityUsd: number;
  timeRemainingHours: number;
  availableUpsidePct: number;
  newestEntryTs: number;
  createdAt: number;
}

export type SignalDecision = 'accepted' | 'rejected';

export interface SignalEvaluation {
  signal: ConsensusSignal;
  decision: SignalDecision;
  reasons: string[]; // human-readable, one per check
}

export type OrderLifecycle =
  | 'paper_filled'
  | 'pending_approval'
  | 'previewed'
  | 'submitted'
  | 'filled'
  | 'partially_filled'
  | 'rejected'
  | 'canceled'
  | 'error';

export interface WorkerHealth {
  workerId: string;
  leaseHolder: boolean;
  lastCycleAt: number | null;
  lastCycleStatus: 'ok' | 'error' | 'starting';
  wsMarketsConnected: boolean;
  wsPrivateConnected: boolean;
  errorState: string | null;
  tradingPaused: boolean;
  killSwitchActive: boolean;
  startedAt: number;
}
