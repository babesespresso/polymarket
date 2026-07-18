import { loadConfig } from '../config';
import { getClient } from '../polymarket/client';
import {
  getControlState,
  getTodayStats,
  inCooldown,
  marketExposureUsd,
  openOrderCount,
  totalExposureUsd,
} from '../db/repo';
import {
  violatesCashReserve,
  violatesDailyLoss,
  violatesDailyTrades,
  violatesMarketExposure,
  violatesOpenPositions,
  violatesPerTrade,
  violatesTotalExposure,
  ExposureState,
} from './limits';

/**
 * Risk gate. Every check here is evaluated BEFORE order preview and AGAIN
 * immediately before submission. All limits fail closed: any ambiguity, error,
 * or breached threshold blocks the trade.
 */

export interface RiskContext {
  usMarketSlug: string;
  notionalUsd: number;
}

export interface RiskDecision {
  allowed: boolean;
  reasons: string[];
}

/** Live cash available (buying power) from the exchange, USD. */
async function cashAvailableUsd(): Promise<number> {
  const res = await getClient().account.balances();
  const usd = res.balances?.find((b) => b.currency === 'USD') ?? res.balances?.[0];
  return usd?.buyingPower ?? usd?.currentBalance ?? 0;
}

export async function checkRisk(ctx: RiskContext): Promise<RiskDecision> {
  const cfg = loadConfig();
  const reasons: string[] = [];
  let allowed = true;

  const fail = (msg: string) => {
    reasons.push(`FAIL: ${msg}`);
    allowed = false;
  };
  const pass = (msg: string) => reasons.push(`PASS: ${msg}`);

  try {
    const control = await getControlState();
    if (control.killSwitchActive) fail('kill switch is active');
    else pass('kill switch inactive');
    if (control.tradingPaused) fail('trading is paused');
    else pass('trading not paused');

    // Gather live exposure state, then apply the pure limit predicates so the
    // safety math has a single, unit-tested source of truth.
    const [marketExp, totalExp, openOrders, today, cash] = await Promise.all([
      marketExposureUsd(ctx.usMarketSlug),
      totalExposureUsd(),
      openOrderCount(),
      getTodayStats(),
      cashAvailableUsd(),
    ]);

    const state: ExposureState = {
      notionalUsd: ctx.notionalUsd,
      marketExposureUsd: marketExp,
      totalExposureUsd: totalExp,
      openPositions: openOrders,
      tradesToday: today.tradesCount,
      realizedPnlTodayUsd: today.realizedPnlUsd,
      cashAvailableUsd: cash,
    };
    const l = cfg.risk;

    const perTrade = violatesPerTrade(state, l);
    perTrade ? fail(perTrade) : pass('trade size within per-trade cap');
    const mkt = violatesMarketExposure(state, l);
    mkt ? fail(mkt) : pass('market exposure within cap');
    const tot = violatesTotalExposure(state, l);
    tot ? fail(tot) : pass('total exposure within cap');
    const openV = violatesOpenPositions(state, l);
    openV ? fail(openV) : pass('open position count within cap');
    const dt = violatesDailyTrades(state, l);
    dt ? fail(dt) : pass('daily trade count within cap');
    const dl = violatesDailyLoss(state, l);
    dl ? fail(dl) : pass('daily loss limit not breached');
    const cashV = violatesCashReserve(state, l);
    cashV ? fail(cashV) : pass('cash reserve preserved');

    // Cooldown (time-based, not a pure exposure predicate).
    if (await inCooldown(ctx.usMarketSlug)) {
      fail(`market in cooldown (${cfg.tradeCooldownMinutes}m)`);
    } else pass('market not in cooldown');
  } catch (err) {
    fail(`risk check errored (failing closed): ${err instanceof Error ? err.message : String(err)}`);
  }

  return { allowed, reasons };
}

/**
 * Global trading halts, independent of a specific trade. Returns a reason if
 * new trading must stop entirely, or null if trading may proceed.
 */
export async function tradingHalt(): Promise<string | null> {
  const cfg = loadConfig();
  try {
    const control = await getControlState();
    if (control.killSwitchActive) return 'kill switch active';
    if (control.tradingPaused) return 'trading paused';
    const today = await getTodayStats();
    if (today.realizedPnlUsd <= -Math.abs(cfg.risk.maxDailyLossUsd)) {
      return `daily loss limit breached ($${today.realizedPnlUsd.toFixed(2)})`;
    }
    if (today.tradesCount >= cfg.risk.maxTradesPerDay) return 'daily trade count reached';
    return null;
  } catch (err) {
    return `halt check errored (failing closed): ${err instanceof Error ? err.message : String(err)}`;
  }
}
