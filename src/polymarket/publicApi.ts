import { loadConfig } from '../config';
import { log } from '../logger';
import {
  LeaderboardEntry,
  LeaderboardPeriod,
  TraderHistory,
  TraderMarketAction,
} from '../types';

/**
 * Best-effort access to *public* Polymarket data that the authenticated US SDK
 * does not expose: leaderboard rankings and public trader positions/trades.
 *
 * IMPORTANT: These are public, community-documented endpoints and their shapes
 * can change. Everything returned here is treated as untrusted input and is
 * strictly re-verified by the market-mapping layer before any trade. If the
 * endpoints are unreachable or return unexpected shapes, we degrade gracefully
 * to empty results rather than fabricating data — the worker then simply finds
 * no new consensus and keeps managing existing positions.
 */

const PERIOD_PARAM: Record<LeaderboardPeriod, string> = {
  DAY: '1d',
  WEEK: '1w',
  MONTH: '1m',
  ALL: 'all',
};

async function fetchJson(url: string): Promise<unknown | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { accept: 'application/json' },
    });
    clearTimeout(timer);
    if (!res.ok) {
      log.warn('public api non-ok response', { url, status: res.status });
      return null;
    }
    return await res.json();
  } catch (err) {
    log.warn('public api fetch failed', {
      url,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

function asArray(v: unknown): unknown[] {
  if (Array.isArray(v)) return v;
  if (v && typeof v === 'object') {
    const obj = v as Record<string, unknown>;
    for (const key of ['data', 'results', 'leaderboard', 'entries']) {
      if (Array.isArray(obj[key])) return obj[key] as unknown[];
    }
  }
  return [];
}

function numOr(v: unknown, d = 0): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

/**
 * Fetch the top-N leaderboard for a single period. Tolerant of several common
 * field namings so a minor API rename does not silently break ranking.
 */
export async function fetchLeaderboard(
  period: LeaderboardPeriod,
  size: number,
): Promise<LeaderboardEntry[]> {
  const cfg = loadConfig();
  if (cfg.disablePublicApi) return [];

  const base = cfg.publicLeaderboardApiBase.replace(/\/$/, '');
  const url = `${base}/leaderboard?window=${PERIOD_PARAM[period]}&limit=${size}&orderBy=pnl`;
  const raw = await fetchJson(url);
  if (raw == null) return [];

  const rows = asArray(raw);
  const entries: LeaderboardEntry[] = [];
  rows.slice(0, size).forEach((r, i) => {
    if (!r || typeof r !== 'object') return;
    const o = r as Record<string, unknown>;
    const traderId =
      str(o.proxyWallet) ?? str(o.wallet) ?? str(o.address) ?? str(o.userId) ?? str(o.id);
    if (!traderId) return;
    entries.push({
      traderId,
      handle: str(o.name) ?? str(o.username) ?? str(o.pseudonym),
      period,
      rank: numOr(o.rank, i + 1),
      pnlUsd: numOr(o.pnl ?? o.profit ?? o.amount),
      volumeUsd: o.volume !== undefined ? numOr(o.volume) : undefined,
    });
  });
  return entries;
}

/** Fetch leaderboards for all periods and de-duplicate the trader universe. */
export async function fetchAllLeaderboards(size: number): Promise<{
  entries: LeaderboardEntry[];
  traderIds: string[];
}> {
  const periods: LeaderboardPeriod[] = ['DAY', 'WEEK', 'MONTH', 'ALL'];
  const all: LeaderboardEntry[] = [];
  for (const p of periods) {
    const rows = await fetchLeaderboard(p, size);
    all.push(...rows);
  }
  const traderIds = Array.from(new Set(all.map((e) => e.traderId)));
  return { entries: all, traderIds };
}

/**
 * Public positions currently held by a trader. Maps to our TraderMarketAction
 * vocabulary. Returns [] on any failure.
 */
export async function fetchTraderPositions(traderId: string): Promise<TraderMarketAction[]> {
  const cfg = loadConfig();
  if (cfg.disablePublicApi) return [];
  const base = cfg.publicDataApiBase.replace(/\/$/, '');
  const url = `${base}/positions?user=${encodeURIComponent(traderId)}&sizeThreshold=1`;
  const raw = await fetchJson(url);
  if (raw == null) return [];

  const rows = asArray(raw);
  const out: TraderMarketAction[] = [];
  for (const r of rows) {
    if (!r || typeof r !== 'object') continue;
    const o = r as Record<string, unknown>;
    const globalMarketId =
      str(o.conditionId) ?? str(o.market) ?? str(o.marketId) ?? str(o.slug);
    const outcome = str(o.outcome) ?? str(o.outcomeName);
    if (!globalMarketId || !outcome) continue;
    const size = numOr(o.size ?? o.shares);
    const value = numOr(o.currentValue ?? o.value ?? o.initialValue);
    out.push({
      traderId,
      globalMarketId,
      marketQuestion: str(o.title) ?? str(o.question) ?? globalMarketId,
      outcome,
      sizeUsd: value || size,
      entryPrice: o.avgPrice !== undefined ? numOr(o.avgPrice) : undefined,
      direction: 'holding',
      timestamp: numOr(o.lastUpdate ?? o.timestamp ?? Date.now()) || Date.now(),
      resolved: Boolean(o.redeemable) || Boolean(o.resolved),
    });
  }
  return out;
}

/** Recent public trades (activity) for a trader, most-recent first. */
export async function fetchTraderTrades(
  traderId: string,
  limit = 100,
): Promise<TraderMarketAction[]> {
  const cfg = loadConfig();
  if (cfg.disablePublicApi) return [];
  const base = cfg.publicDataApiBase.replace(/\/$/, '');
  const url = `${base}/activity?user=${encodeURIComponent(traderId)}&limit=${limit}&type=TRADE`;
  const raw = await fetchJson(url);
  if (raw == null) return [];

  const rows = asArray(raw);
  const out: TraderMarketAction[] = [];
  for (const r of rows) {
    if (!r || typeof r !== 'object') continue;
    const o = r as Record<string, unknown>;
    const globalMarketId =
      str(o.conditionId) ?? str(o.market) ?? str(o.marketId) ?? str(o.slug);
    const outcome = str(o.outcome) ?? str(o.outcomeName);
    if (!globalMarketId || !outcome) continue;
    const sideRaw = (str(o.side) ?? '').toUpperCase();
    const usdcSize = numOr(o.usdcSize ?? o.size);
    // Convert epoch seconds to ms when the value looks like seconds.
    let ts = numOr(o.timestamp ?? o.createdAt ?? Date.now());
    if (ts > 0 && ts < 1e12) ts *= 1000;
    out.push({
      traderId,
      globalMarketId,
      marketQuestion: str(o.title) ?? str(o.question) ?? globalMarketId,
      outcome,
      sizeUsd: sideRaw === 'SELL' ? -usdcSize : usdcSize,
      entryPrice: o.price !== undefined ? numOr(o.price) : undefined,
      direction: sideRaw === 'SELL' ? 'reducing' : 'adding',
      timestamp: ts || Date.now(),
    });
  }
  return out;
}

/**
 * Build a resolved-market history for scoring from a trader's public
 * positions + trades. This is intentionally conservative: fields we cannot
 * derive from public data are set to neutral/penalising defaults so an unknown
 * trader never scores artificially high.
 */
export async function buildTraderHistory(
  traderId: string,
  handle: string | undefined,
): Promise<TraderHistory> {
  const [positions, trades] = await Promise.all([
    fetchTraderPositions(traderId),
    fetchTraderTrades(traderId, 200),
  ]);

  const resolved = positions.filter((p) => p.resolved);
  const resolvedPnls = resolved
    .map((p) => p.realizedPnlUsd ?? 0)
    .filter((n) => Number.isFinite(n));

  const wins = resolvedPnls.filter((p) => p > 0).length;
  const losses = resolvedPnls.filter((p) => p < 0).length;
  const grossProfit = resolvedPnls.filter((p) => p > 0).reduce((a, b) => a + b, 0);
  const grossLoss = Math.abs(resolvedPnls.filter((p) => p < 0).reduce((a, b) => a + b, 0));
  const realized = resolvedPnls.reduce((a, b) => a + b, 0);
  const deployed = trades.reduce((a, t) => a + Math.abs(t.sizeUsd), 0);
  const unrealized = positions
    .filter((p) => !p.resolved)
    .reduce((a, p) => a + (p.realizedPnlUsd ?? 0), 0);

  const topWin = resolvedPnls.filter((p) => p > 0).sort((a, b) => b - a)[0] ?? 0;
  const topWinConcentration = grossProfit > 0 ? topWin / grossProfit : 0;

  // Market concentration: Herfindahl index over absolute exposure per market.
  const perMarket = new Map<string, number>();
  for (const t of [...positions, ...trades]) {
    perMarket.set(t.globalMarketId, (perMarket.get(t.globalMarketId) ?? 0) + Math.abs(t.sizeUsd));
  }
  const totalExp = Array.from(perMarket.values()).reduce((a, b) => a + b, 0);
  const marketConcentration =
    totalExp > 0
      ? Array.from(perMarket.values()).reduce((a, v) => a + (v / totalExp) ** 2, 0)
      : 1;

  // Contradictory trades: same market appearing with both buy and sell within
  // a short window, or holding a position while also trading the opposite side.
  const bySideMarket = new Map<string, Set<string>>();
  for (const t of trades) {
    const set = bySideMarket.get(t.globalMarketId) ?? new Set<string>();
    set.add(t.sizeUsd >= 0 ? 'buy' : 'sell');
    bySideMarket.set(t.globalMarketId, set);
  }
  const contradictory = Array.from(bySideMarket.values()).filter((s) => s.size > 1).length;

  const lastActive = Math.max(
    0,
    ...trades.map((t) => t.timestamp),
    ...positions.map((p) => p.timestamp),
  );

  const avgResolvedReturn =
    resolved.length > 0
      ? (resolvedPnls.reduce((a, b) => a + b, 0) / Math.max(deployed, 1)) * 100
      : 0;

  return {
    traderId,
    handle,
    realizedPnlUsd: realized,
    deployedCapitalUsd: deployed,
    wins,
    losses,
    grossProfitUsd: grossProfit,
    grossLossUsd: grossLoss,
    resolvedMarkets: resolved.length,
    avgResolvedReturnPct: avgResolvedReturn,
    // Drawdown is not derivable from a single public snapshot; use a neutral,
    // mildly penalising default so it cannot inflate the score.
    maxDrawdownPct: 25,
    topWinConcentration,
    marketConcentration,
    consistency7dPct: 0,
    consistency30dPct: 0,
    unrealizedPnlUsd: unrealized,
    lastActiveTs: lastActive || Date.now(),
    contradictoryTrades: contradictory,
  };
}

/** All current public positions/trades for a set of traders (for consensus). */
export async function fetchActionsForTraders(
  traderIds: string[],
): Promise<TraderMarketAction[]> {
  const out: TraderMarketAction[] = [];
  for (const id of traderIds) {
    const [positions, trades] = await Promise.all([
      fetchTraderPositions(id),
      fetchTraderTrades(id, 50),
    ]);
    out.push(...positions, ...trades);
  }
  return out;
}
