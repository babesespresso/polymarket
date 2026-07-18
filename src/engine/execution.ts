import { getClient } from '../polymarket/client';
import { loadConfig } from '../config';
import { log } from '../logger';
import { audit } from '../db/audit';
import { checkRisk } from './risk';
import {
  ConsensusSignal,
  OrderLifecycle,
} from '../types';
import {
  insertOrderIfNew,
  orderKeyExists,
  updateOrder,
  incrementTradeCount,
  setCooldown,
  hasOpenPositionConflicting,
} from '../db/repo';
import type { Amount, CreateOrderParams, Market, MarketBook } from 'polymarket-us';

/**
 * Order execution across paper | approval | live modes. The submission path is
 * deliberately conservative:
 *   - LIMIT orders only, never market orders.
 *   - Never average down and never chase a moved price.
 *   - Idempotency key persisted BEFORE any submission, so a crash/retry can
 *     never double-submit.
 *   - Every exposure and loss limit checked before preview AND before submit.
 *   - Live orders are never blindly retried.
 */

const PRICE_TICK = 0.01; // Polymarket US prices move in cents.
const MIN_QUANTITY = 1;

function roundToTick(price: number): number {
  return Math.round(price / PRICE_TICK) * PRICE_TICK;
}

function usd(value: number): Amount {
  return { value: value.toFixed(2), currency: 'USD' };
}

export interface ExecutionResult {
  status: 'placed' | 'paper' | 'awaiting_approval' | 'skipped' | 'rejected' | 'error';
  reason: string;
  orderId?: number;
  exchangeOrderId?: string;
}

/**
 * Freshly read market status + order book, and derive a safe limit price and
 * quantity for a BUY_LONG on the signalled outcome. Returns null if the market
 * data is stale/inconsistent or the price has moved beyond the consensus entry.
 */
async function planOrder(
  signal: ConsensusSignal,
): Promise<
  | { ok: true; price: number; quantity: number; notional: number; book: MarketBook; market: Market }
  | { ok: false; reason: string }
> {
  const cfg = loadConfig();
  const client = getClient();

  let market: Market;
  try {
    const res = await client.markets.retrieveBySlug(signal.usMarketSlug);
    market = res.market as unknown as Market;
  } catch (err) {
    return { ok: false, reason: `could not load market: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (market.closed || !market.active) return { ok: false, reason: 'market closed/inactive at execution time' };

  let book: MarketBook;
  try {
    book = await client.markets.book(signal.usMarketSlug);
  } catch (err) {
    return { ok: false, reason: `could not load order book: ${err instanceof Error ? err.message : String(err)}` };
  }

  const bestAsk = book.offers?.[0];
  if (!bestAsk) return { ok: false, reason: 'no ask liquidity in order book' };
  const askPrice = Number(bestAsk.px.value);
  const askQty = Number(bestAsk.qty);
  if (!Number.isFinite(askPrice) || askPrice <= 0 || askPrice >= 1) {
    return { ok: false, reason: `invalid ask price ${askPrice}` };
  }

  // Do not chase: if the market has moved materially above the average trader
  // entry price (and above the price we saw when the signal formed), skip.
  const referencePrice = signal.avgTraderEntryPrice > 0 ? signal.avgTraderEntryPrice : signal.currentMarketPrice;
  const maxAcceptable = Math.min(0.98, roundToTick(referencePrice * 1.03 + PRICE_TICK));
  if (askPrice > maxAcceptable) {
    return { ok: false, reason: `price moved: ask ${askPrice.toFixed(3)} > max acceptable ${maxAcceptable.toFixed(3)}` };
  }

  // Post a limit at the best ask (marketable limit, but never a market order).
  const price = roundToTick(askPrice);
  const quantity = Math.floor(cfg.risk.maxTradeUsd / price);
  if (quantity < MIN_QUANTITY) {
    return { ok: false, reason: `computed quantity ${quantity} below minimum ${MIN_QUANTITY}` };
  }
  if (quantity > askQty) {
    // Only take what the top level offers to avoid walking the book / slippage.
    const capped = Math.floor(askQty);
    if (capped < MIN_QUANTITY) return { ok: false, reason: 'top-of-book depth below minimum quantity' };
    return { ok: true, price, quantity: capped, notional: capped * price, book, market };
  }

  return { ok: true, price, quantity, notional: quantity * price, book, market };
}

/**
 * Execute a trade for an accepted signal. Safe to call repeatedly for the same
 * signal — the idempotency key guarantees at most one order per signal/day.
 */
export async function executeSignal(signal: ConsensusSignal): Promise<ExecutionResult> {
  const cfg = loadConfig();
  const idempotencyKey = `order:${signal.id}`;

  // 0. Duplicate guard.
  if (await orderKeyExists(idempotencyKey)) {
    return { status: 'skipped', reason: 'order for this signal already exists (idempotent)' };
  }

  // 0b. Never average down / never trade into a conflicting position.
  if (await hasOpenPositionConflicting(signal.usMarketSlug, signal.outcome)) {
    return { status: 'skipped', reason: 'existing/conflicting position — will not average down' };
  }

  // 1. Plan from fresh market data.
  const plan = await planOrder(signal);
  if (!plan.ok) {
    await audit('worker', 'order_skipped', { signal: signal.id, reason: plan.reason });
    return { status: 'skipped', reason: plan.reason };
  }

  // 2. Risk check #1 (pre-preview).
  const pre = await checkRisk({ usMarketSlug: signal.usMarketSlug, notionalUsd: plan.notional });
  if (!pre.allowed) {
    await audit('worker', 'order_rejected_risk_pre', { signal: signal.id, reasons: pre.reasons });
    return { status: 'rejected', reason: `risk (pre): ${pre.reasons.filter((r) => r.startsWith('FAIL')).join('; ')}` };
  }

  const orderParams: CreateOrderParams = {
    marketSlug: signal.usMarketSlug,
    intent: 'ORDER_INTENT_BUY_LONG',
    type: 'ORDER_TYPE_LIMIT',
    price: usd(plan.price),
    quantity: plan.quantity,
    tif: 'TIME_IN_FORCE_GOOD_TILL_CANCEL',
  };

  // 3. Preview (skip real preview in pure paper mode to avoid needless calls;
  //    still record a synthetic preview for parity).
  let preview: unknown = null;
  if (cfg.tradingMode !== 'paper') {
    try {
      const res = await getClient().orders.preview({ request: orderParams });
      preview = res;
    } catch (err) {
      await audit('worker', 'order_preview_failed', {
        signal: signal.id,
        error: err instanceof Error ? err.message : String(err),
      });
      return { status: 'error', reason: `preview failed: ${err instanceof Error ? err.message : String(err)}` };
    }
  } else {
    preview = { paper: true, order: orderParams };
  }

  // 4. Risk check #2 (post-preview, immediately before submission).
  const post = await checkRisk({ usMarketSlug: signal.usMarketSlug, notionalUsd: plan.notional });
  if (!post.allowed) {
    await audit('worker', 'order_rejected_risk_post', { signal: signal.id, reasons: post.reasons });
    return { status: 'rejected', reason: `risk (post): ${post.reasons.filter((r) => r.startsWith('FAIL')).join('; ')}` };
  }

  // 5. Persist the order row with its idempotency key BEFORE submitting.
  const initialLifecycle: OrderLifecycle =
    cfg.tradingMode === 'paper'
      ? 'paper_filled'
      : cfg.tradingMode === 'approval'
        ? 'pending_approval'
        : 'previewed';

  const orderId = await insertOrderIfNew({
    idempotencyKey,
    signalId: signal.id,
    usMarketSlug: signal.usMarketSlug,
    outcome: signal.outcome,
    intent: orderParams.intent,
    orderType: orderParams.type ?? 'ORDER_TYPE_LIMIT',
    price: plan.price,
    quantity: plan.quantity,
    notionalUsd: plan.notional,
    tif: orderParams.tif ?? 'TIME_IN_FORCE_GOOD_TILL_CANCEL',
    mode: cfg.tradingMode,
    lifecycle: initialLifecycle,
    preview,
  });

  if (orderId === null) {
    return { status: 'skipped', reason: 'idempotency race — order already inserted' };
  }

  await setCooldown(signal.usMarketSlug, cfg.tradeCooldownMinutes);

  // 6. Mode-specific handling.
  if (cfg.tradingMode === 'paper') {
    await incrementTradeCount();
    await audit('worker', 'paper_order_recorded', {
      signal: signal.id,
      price: plan.price,
      quantity: plan.quantity,
      notional: plan.notional,
    }, 'order', String(orderId));
    return { status: 'paper', reason: 'paper order recorded', orderId };
  }

  if (cfg.tradingMode === 'approval') {
    await audit('worker', 'order_awaiting_approval', {
      signal: signal.id,
      price: plan.price,
      quantity: plan.quantity,
    }, 'order', String(orderId));
    return { status: 'awaiting_approval', reason: 'order queued for manual approval', orderId };
  }

  // live
  if (!cfg.liveExecutionEnabled) {
    await updateOrder(orderId, { lifecycle: 'rejected', error: 'live execution not fully enabled' });
    return { status: 'rejected', reason: 'live execution requires TRADING_MODE=live AND POLYMARKET_LIVE_TRADING=true' };
  }

  return submitLiveOrder(orderId, orderParams, plan.notional, signal);
}

/**
 * Submit a previously-persisted order to the exchange. A live order is NEVER
 * blindly retried: on a timeout/connection error we mark it needs_confirmation
 * so reconciliation can determine whether it actually landed.
 */
async function submitLiveOrder(
  orderId: number,
  params: CreateOrderParams,
  notional: number,
  signal: ConsensusSignal,
): Promise<ExecutionResult> {
  const cfg = loadConfig();
  await updateOrder(orderId, { lifecycle: 'submitted' });
  try {
    const res = await getClient().orders.create(params);
    await incrementTradeCount();
    await updateOrder(orderId, {
      lifecycle: 'filled',
      exchangeOrderId: res.id,
      response: res,
    });
    await audit('worker', 'live_order_submitted', {
      signal: signal.id,
      exchangeOrderId: res.id,
      notional,
    }, 'order', String(orderId));
    return { status: 'placed', reason: 'live order submitted', orderId, exchangeOrderId: res.id };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const name = err instanceof Error ? err.name : 'Error';
    // Do not retry order creation blindly. If the failure is a timeout or a
    // connection error, the order MAY have been accepted — mark for
    // confirmation by reconciliation rather than resubmitting.
    const uncertain = /timeout|timedout|connection|econnreset|socket/i.test(`${name} ${message}`);
    await updateOrder(orderId, {
      lifecycle: uncertain ? 'submitted' : 'error',
      error: `${name}: ${message}${uncertain ? ' [uncertain — awaiting reconciliation]' : ''}`,
    });
    await audit('worker', uncertain ? 'live_order_uncertain' : 'live_order_error', {
      signal: signal.id,
      error: message,
      uncertain,
    }, 'order', String(orderId));
    void cfg;
    return {
      status: 'error',
      reason: uncertain
        ? 'submission outcome uncertain — reconciliation will confirm; NOT retrying'
        : `submission failed: ${message}`,
      orderId,
    };
  }
}
