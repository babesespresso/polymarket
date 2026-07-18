import { getClient } from '../polymarket/client';
import { loadConfig } from '../config';
import { log } from '../logger';
import { audit } from '../db/audit';
import { addRealizedPnl, listPositions, PositionRow, setCooldown } from '../db/repo';
import type { Amount, ClosePositionParams, MarketBook } from 'polymarket-us';

/**
 * Position exit manager. Configurable exits are evaluated continuously against
 * live market data:
 *   - take-profit / stop-loss (percentage of cost basis)
 *   - consensus reversal (aligned traders now reducing/exiting)
 *   - maximum hold time
 *   - approaching resolution
 *   - liquidity deterioration
 *
 * Exits use orders.closePosition(); we never sell more than the owned position.
 */

export type ExitReason =
  | 'take_profit'
  | 'stop_loss'
  | 'consensus_reversal'
  | 'max_hold_time'
  | 'approaching_resolution'
  | 'liquidity_deterioration';

export interface ExitSignal {
  usMarketSlug: string;
  reason: ExitReason;
  detail: string;
}

/** Reversed markets: outcome slugs where aligned traders are now exiting. */
export interface ExitContext {
  reversedMarkets: Set<string>;
  openedAt: Map<string, number>; // slug -> epoch ms
}

function pnlPct(p: PositionRow): number | null {
  const cost = p.costUsd ?? (p.avgCost != null ? p.avgCost * Math.abs(p.netQuantity) : null);
  if (cost == null || cost === 0) return null;
  const value = p.cashValueUsd ?? 0;
  return ((value - cost) / Math.abs(cost)) * 100;
}

/** Evaluate all configured exit rules for a single position. */
export async function evaluatePositionExit(
  p: PositionRow,
  ctx: ExitContext,
  now = Date.now(),
): Promise<ExitSignal | null> {
  const cfg = loadConfig();

  const pct = pnlPct(p);
  if (pct != null) {
    if (pct >= cfg.exits.takeProfitPct) {
      return { usMarketSlug: p.usMarketSlug, reason: 'take_profit', detail: `pnl ${pct.toFixed(1)}% >= ${cfg.exits.takeProfitPct}%` };
    }
    if (pct <= -Math.abs(cfg.exits.stopLossPct)) {
      return { usMarketSlug: p.usMarketSlug, reason: 'stop_loss', detail: `pnl ${pct.toFixed(1)}% <= -${cfg.exits.stopLossPct}%` };
    }
  }

  if (ctx.reversedMarkets.has(p.usMarketSlug)) {
    return { usMarketSlug: p.usMarketSlug, reason: 'consensus_reversal', detail: 'aligned traders now reducing/exiting' };
  }

  const openedAt = ctx.openedAt.get(p.usMarketSlug);
  if (openedAt && (now - openedAt) / (3600 * 1000) >= cfg.exits.maxHoldHours) {
    return { usMarketSlug: p.usMarketSlug, reason: 'max_hold_time', detail: `held > ${cfg.exits.maxHoldHours}h` };
  }

  // Approaching resolution + liquidity deterioration need live market data.
  try {
    const client = getClient();
    const marketRes = await client.markets.retrieveBySlug(p.usMarketSlug);
    const eventSlug = (marketRes.market as { eventSlug?: string }).eventSlug;
    if (eventSlug) {
      const ev = await client.events.retrieveBySlug(eventSlug);
      const end = ev.event?.endTime ? new Date(ev.event.endTime).getTime() : null;
      if (end) {
        const hoursLeft = (end - now) / (3600 * 1000);
        if (hoursLeft <= cfg.exits.approachingResolutionHours) {
          return { usMarketSlug: p.usMarketSlug, reason: 'approaching_resolution', detail: `${hoursLeft.toFixed(1)}h to resolution` };
        }
      }
    }

    const book: MarketBook = await client.markets.book(p.usMarketSlug);
    const bidDepthUsd = (book.bids ?? []).reduce((a, l) => a + Number(l.px.value) * Number(l.qty), 0);
    if (bidDepthUsd < cfg.exits.minExitLiquidityUsd) {
      return { usMarketSlug: p.usMarketSlug, reason: 'liquidity_deterioration', detail: `bid depth $${bidDepthUsd.toFixed(0)} < $${cfg.exits.minExitLiquidityUsd}` };
    }
  } catch (err) {
    log.warn('exit market-data check failed', { slug: p.usMarketSlug, error: String(err) });
  }

  return null;
}

/** Scan all open positions and return the exits that should fire. */
export async function findExits(ctx: ExitContext, now = Date.now()): Promise<ExitSignal[]> {
  const positions = await listPositions();
  const out: ExitSignal[] = [];
  for (const p of positions) {
    const exit = await evaluatePositionExit(p, ctx, now);
    if (exit) out.push(exit);
  }
  return out;
}

function usd(value: number): Amount {
  return { value: value.toFixed(2), currency: 'USD' };
}

/**
 * Close a position. In paper/approval mode this only records intent; in live
 * mode it calls closePosition. Never sells more than the owned position (the
 * SDK's closePosition closes exactly the current holding).
 */
export async function closePosition(exit: ExitSignal): Promise<void> {
  const cfg = loadConfig();
  await audit('worker', 'exit_triggered', { ...exit });

  if (cfg.tradingMode !== 'live' || !cfg.liveExecutionEnabled) {
    await audit('worker', 'exit_recorded_non_live', { slug: exit.usMarketSlug, reason: exit.reason });
    await setCooldown(exit.usMarketSlug, cfg.tradeCooldownMinutes);
    return;
  }

  try {
    const params: ClosePositionParams = {
      marketSlug: exit.usMarketSlug,
      slippageTolerance: { currentPrice: usd(0.5), bips: 200 },
    };
    const res = await getClient().orders.closePosition(params);
    await audit('worker', 'exit_closed_live', { slug: exit.usMarketSlug, reason: exit.reason, response: res });
    await setCooldown(exit.usMarketSlug, cfg.tradeCooldownMinutes);
  } catch (err) {
    await audit('worker', 'exit_close_failed', {
      slug: exit.usMarketSlug,
      error: err instanceof Error ? err.message : String(err),
    });
    log.error('failed to close position', { slug: exit.usMarketSlug, error: String(err) });
  }
}

/** Recognise realised PnL into the daily accounting after an exit fills. */
export async function recordRealizedPnl(amountUsd: number): Promise<void> {
  await addRealizedPnl(amountUsd);
}
