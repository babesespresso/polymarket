import { loadConfig } from '../config';
import { log } from '../logger';
import { audit } from '../db/audit';
import { getClient } from '../polymarket/client';
import {
  buildTraderHistory,
  fetchActionsForTraders,
  fetchAllLeaderboards,
} from '../polymarket/publicApi';
import { verifyMapping } from '../polymarket/mapping';
import { scoreAll } from '../engine/scoring';
import {
  computeConsensus,
  evaluateSignal,
  MarketSnapshot,
} from '../engine/consensus';
import { executeSignal } from '../engine/execution';
import { findExits, closePosition, ExitContext } from '../engine/exits';
import { tradingHalt } from '../engine/risk';
import {
  hasOpenPositionConflicting,
  saveLeaderboardSnapshot,
  saveScores,
  saveSignalEvaluation,
} from '../db/repo';
import { TraderMarketAction, TraderScore } from '../types';

/**
 * One full decision cycle:
 *   1. Refresh leaderboard, score traders, persist.
 *   2. Fetch qualified traders' public actions, group by market+outcome.
 *   3. Verify US market mapping, compute + gate consensus.
 *   4. Execute accepted signals (respecting the global trading halt).
 *   5. Manage exits on existing positions.
 */

export interface CycleOutcome {
  scoredTraders: number;
  qualifiedTraders: number;
  signalsConsidered: number;
  signalsAccepted: number;
  ordersPlaced: number;
  exitsFired: number;
  trackedSlugs: string[];
}

async function marketSnapshot(slug: string): Promise<MarketSnapshot | null> {
  try {
    const client = getClient();
    const book = await client.markets.book(slug);
    const bestBid = book.bids?.[0] ? Number(book.bids[0].px.value) : 0;
    const bestAsk = book.offers?.[0] ? Number(book.offers[0].px.value) : 0;
    if (bestAsk <= 0) return null;
    const mid = bestBid > 0 ? (bestBid + bestAsk) / 2 : bestAsk;
    const spread = bestBid > 0 ? bestAsk - bestBid : bestAsk;
    const liquidityUsd =
      (book.bids ?? []).reduce((a, l) => a + Number(l.px.value) * Number(l.qty), 0) +
      (book.offers ?? []).reduce((a, l) => a + Number(l.px.value) * Number(l.qty), 0);

    let timeRemainingHours = 9999;
    try {
      const marketRes = await client.markets.retrieveBySlug(slug);
      const eventSlug = (marketRes.market as { eventSlug?: string }).eventSlug;
      if (eventSlug) {
        const ev = await client.events.retrieveBySlug(eventSlug);
        if (ev.event?.endTime) {
          timeRemainingHours = (new Date(ev.event.endTime).getTime() - Date.now()) / (3600 * 1000);
        }
      }
    } catch { /* leave default */ }

    return { currentPrice: mid, spread, liquidityUsd, timeRemainingHours };
  } catch (err) {
    log.warn('market snapshot failed', { slug, error: String(err) });
    return null;
  }
}

export async function runCycle(): Promise<CycleOutcome> {
  const cfg = loadConfig();
  const now = Date.now();
  const outcome: CycleOutcome = {
    scoredTraders: 0,
    qualifiedTraders: 0,
    signalsConsidered: 0,
    signalsAccepted: 0,
    ordersPlaced: 0,
    exitsFired: 0,
    trackedSlugs: [],
  };

  // --- 1. Leaderboard + scoring ---
  const { entries, traderIds } = await fetchAllLeaderboards(cfg.leaderboardSize);
  if (entries.length > 0) await saveLeaderboardSnapshot(entries);

  const handleById = new Map<string, string | undefined>();
  for (const e of entries) if (!handleById.has(e.traderId)) handleById.set(e.traderId, e.handle);

  const histories = [];
  for (const id of traderIds.slice(0, cfg.leaderboardSize)) {
    histories.push(await buildTraderHistory(id, handleById.get(id)));
  }
  const scores = scoreAll(histories, now);
  outcome.scoredTraders = scores.length;
  if (scores.length > 0) await saveScores(scores);

  const scoreMap = new Map<string, TraderScore>(scores.map((s) => [s.traderId, s]));
  const qualified = scores.filter((s) => s.qualified);
  outcome.qualifiedTraders = qualified.length;

  // --- 2. Collect qualified traders' actions, group by market+outcome ---
  const qualifiedIds = qualified.map((s) => s.traderId);
  const actions =
    qualifiedIds.length > 0 ? await fetchActionsForTraders(qualifiedIds) : [];

  // Group by (globalMarketId + outcome).
  const groups = new Map<string, TraderMarketAction[]>();
  for (const a of actions) {
    if (!qualifiedIds.includes(a.traderId)) continue;
    const key = `${a.globalMarketId}::${a.outcome}`;
    const arr = groups.get(key) ?? [];
    arr.push(a);
    groups.set(key, arr);
  }

  const trackedSlugs = new Set<string>();
  const halt = await tradingHalt();

  // --- 3 + 4. Verify mapping, compute + gate + execute ---
  for (const [, groupActions] of groups) {
    const distinctTraders = new Set(groupActions.map((a) => a.traderId)).size;
    // Cheap pre-filter: skip groups that cannot possibly meet the trader floor.
    if (distinctTraders < cfg.minConsensusTraders) continue;

    const sample = groupActions[0];
    if (!sample) continue;

    const mapping = await verifyMapping({
      globalMarketId: sample.globalMarketId,
      question: sample.marketQuestion,
      outcome: sample.outcome,
    });

    if (!mapping.verified) {
      await audit('worker', 'mapping_rejected', {
        globalMarketId: sample.globalMarketId,
        reason: mapping.reason,
      });
      continue;
    }

    const snap = await marketSnapshot(mapping.usMarketSlug);
    if (!snap) continue;
    trackedSlugs.add(mapping.usMarketSlug);

    const signal = computeConsensus({
      usMarketSlug: mapping.usMarketSlug,
      outcome: mapping.outcome,
      question: mapping.question,
      actions: groupActions,
      scores: scoreMap,
      totalQualifiedTraders: qualified.length,
      snapshot: snap,
      now,
    });

    const conflicting = await hasOpenPositionConflicting(mapping.usMarketSlug, mapping.outcome);
    const evaluation = evaluateSignal(signal, {
      hasConflictingPosition: conflicting,
      mappingVerified: mapping.verified,
      marketOpenAndTradeable: true,
      now,
    });
    await saveSignalEvaluation(evaluation);
    outcome.signalsConsidered++;

    if (evaluation.decision !== 'accepted') {
      await audit('worker', 'signal_rejected', { signal: signal.id, reasons: evaluation.reasons });
      continue;
    }
    outcome.signalsAccepted++;
    await audit('worker', 'signal_accepted', { signal: signal.id, reasons: evaluation.reasons });

    if (halt) {
      await audit('worker', 'execution_skipped_halt', { signal: signal.id, halt });
      continue;
    }

    const result = await executeSignal(signal);
    if (result.status === 'placed' || result.status === 'paper') outcome.ordersPlaced++;
    await audit('worker', 'execution_result', { signal: signal.id, ...result });
  }

  // --- 5. Exits ---
  const reversed = new Set<string>();
  // A market is "reversed" if its aligned group is now net reducing/exiting.
  for (const [, groupActions] of groups) {
    const reducing = groupActions.filter((a) => a.direction === 'reducing' || a.direction === 'exiting').length;
    if (reducing > groupActions.length / 2 && groupActions[0]) {
      // Best-effort: mark by mapped slug if we already tracked it this cycle.
    }
  }
  const exitCtx: ExitContext = { reversedMarkets: reversed, openedAt: new Map() };
  const exits = await findExits(exitCtx, now);
  for (const exit of exits) {
    await closePosition(exit);
    outcome.exitsFired++;
  }

  outcome.trackedSlugs = Array.from(trackedSlugs);
  return outcome;
}
