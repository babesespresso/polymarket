import { query, withTransaction } from './index';
import {
  ConsensusSignal,
  LeaderboardEntry,
  MarketMapping,
  SignalEvaluation,
  TraderScore,
  WorkerHealth,
} from '../types';

/**
 * Data-access layer. All persistence goes through here so SQL stays in one
 * place and the engine deals only in domain types.
 */

// --- Worker lock / lease ----------------------------------------------------

export async function acquireLease(
  lockName: string,
  holderId: string,
  ttlSeconds: number,
): Promise<boolean> {
  const res = await query<{ acquire_worker_lease: boolean }>(
    'SELECT acquire_worker_lease($1, $2, $3) AS acquire_worker_lease',
    [lockName, holderId, ttlSeconds],
  );
  return res.rows[0]?.acquire_worker_lease === true;
}

export async function releaseLease(lockName: string, holderId: string): Promise<void> {
  await query('DELETE FROM worker_lock WHERE lock_name = $1 AND holder_id = $2', [
    lockName,
    holderId,
  ]);
}

// --- Worker health ----------------------------------------------------------

export async function upsertHealth(h: WorkerHealth): Promise<void> {
  await query(
    `INSERT INTO worker_health
       (worker_id, lease_holder, last_cycle_at, last_cycle_status,
        ws_markets_connected, ws_private_connected, error_state, started_at, updated_at)
     VALUES ($1,$2,to_timestamp($3/1000.0),$4,$5,$6,$7,to_timestamp($8/1000.0),now())
     ON CONFLICT (worker_id) DO UPDATE SET
       lease_holder = EXCLUDED.lease_holder,
       last_cycle_at = EXCLUDED.last_cycle_at,
       last_cycle_status = EXCLUDED.last_cycle_status,
       ws_markets_connected = EXCLUDED.ws_markets_connected,
       ws_private_connected = EXCLUDED.ws_private_connected,
       error_state = EXCLUDED.error_state,
       updated_at = now()`,
    [
      h.workerId,
      h.leaseHolder,
      h.lastCycleAt ?? Date.now(),
      h.lastCycleStatus,
      h.wsMarketsConnected,
      h.wsPrivateConnected,
      h.errorState,
      h.startedAt,
    ],
  );
}

export async function getHealth(): Promise<Record<string, unknown>[]> {
  const res = await query('SELECT * FROM worker_health ORDER BY updated_at DESC');
  return res.rows;
}

// --- Control state (kill switch / pause) ------------------------------------

export interface ControlState {
  tradingPaused: boolean;
  killSwitchActive: boolean;
}

export async function getControlState(): Promise<ControlState> {
  const res = await query<{ trading_paused: boolean; kill_switch_active: boolean }>(
    'SELECT trading_paused, kill_switch_active FROM control_state WHERE id = 1',
  );
  const row = res.rows[0];
  return {
    tradingPaused: row?.trading_paused ?? false,
    killSwitchActive: row?.kill_switch_active ?? false,
  };
}

export async function setControlState(
  patch: Partial<ControlState>,
  updatedBy: string,
): Promise<void> {
  await query(
    `UPDATE control_state SET
       trading_paused = COALESCE($1, trading_paused),
       kill_switch_active = COALESCE($2, kill_switch_active),
       updated_by = $3,
       updated_at = now()
     WHERE id = 1`,
    [patch.tradingPaused ?? null, patch.killSwitchActive ?? null, updatedBy],
  );
}

// --- Leaderboard + scores ---------------------------------------------------

export async function saveLeaderboardSnapshot(entries: LeaderboardEntry[]): Promise<void> {
  if (entries.length === 0) return;
  await withTransaction(async (client) => {
    for (const e of entries) {
      await client.query(
        `INSERT INTO leaderboard_snapshots (period, trader_id, handle, rank, pnl_usd, volume_usd)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [e.period, e.traderId, e.handle ?? null, e.rank, e.pnlUsd, e.volumeUsd ?? null],
      );
    }
  });
}

export async function saveScores(scores: TraderScore[]): Promise<void> {
  if (scores.length === 0) return;
  await withTransaction(async (client) => {
    for (const s of scores) {
      await client.query(
        `INSERT INTO trader_scores (trader_id, handle, score, qualified, components, penalties)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [
          s.traderId,
          s.handle ?? null,
          s.score,
          s.qualified,
          JSON.stringify(s.components),
          JSON.stringify(s.penalties),
        ],
      );
    }
  });
}

export async function latestScores(): Promise<TraderScore[]> {
  const res = await query<{
    trader_id: string;
    handle: string | null;
    score: string;
    qualified: boolean;
    components: Record<string, number>;
    penalties: Record<string, number>;
    computed_at: Date;
  }>(
    `SELECT DISTINCT ON (trader_id)
       trader_id, handle, score, qualified, components, penalties, computed_at
     FROM trader_scores
     ORDER BY trader_id, computed_at DESC`,
  );
  return res.rows.map((r) => ({
    traderId: r.trader_id,
    handle: r.handle ?? undefined,
    score: Number(r.score),
    qualified: r.qualified,
    components: r.components,
    penalties: r.penalties,
    computedAt: r.computed_at.getTime(),
  }));
}

// --- Market mappings --------------------------------------------------------

export async function saveMapping(m: MarketMapping): Promise<void> {
  await query(
    `INSERT INTO market_mappings
       (global_market_id, us_market_slug, outcome, question, close_time,
        resolution_source, verified, reason, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,now())
     ON CONFLICT (global_market_id, outcome) DO UPDATE SET
       us_market_slug = EXCLUDED.us_market_slug,
       question = EXCLUDED.question,
       close_time = EXCLUDED.close_time,
       resolution_source = EXCLUDED.resolution_source,
       verified = EXCLUDED.verified,
       reason = EXCLUDED.reason,
       updated_at = now()`,
    [
      m.globalMarketId,
      m.usMarketSlug || null,
      m.outcome,
      m.question || null,
      m.closeTimeIso || null,
      m.resolutionSource || null,
      m.verified,
      m.reason,
    ],
  );
}

// --- Signals ----------------------------------------------------------------

export async function saveSignalEvaluation(ev: SignalEvaluation): Promise<void> {
  const s = ev.signal;
  await query(
    `INSERT INTO signals
       (id, us_market_slug, outcome, question, aligned_traders, aligned_pct,
        quality_weighted_score, capital_weighted_usd, avg_entry_price, current_price,
        net_direction, spread, liquidity_usd, time_remaining_hours, available_upside_pct,
        newest_entry_ts, decision, reasons, raw)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,
             to_timestamp($16/1000.0),$17,$18,$19)
     ON CONFLICT (id) DO UPDATE SET
       decision = EXCLUDED.decision,
       reasons = EXCLUDED.reasons,
       raw = EXCLUDED.raw`,
    [
      s.id,
      s.usMarketSlug,
      s.outcome,
      s.question,
      s.alignedTraders,
      s.alignedPct,
      s.qualityWeightedScore,
      s.capitalWeightedConvictionUsd,
      s.avgTraderEntryPrice,
      s.currentMarketPrice,
      s.netDirection,
      s.spread,
      s.liquidityUsd,
      s.timeRemainingHours,
      s.availableUpsidePct,
      s.newestEntryTs,
      ev.decision,
      JSON.stringify(ev.reasons),
      JSON.stringify(s),
    ],
  );
}

export async function recentSignals(limit = 50): Promise<Record<string, unknown>[]> {
  const res = await query('SELECT * FROM signals ORDER BY created_at DESC LIMIT $1', [limit]);
  return res.rows;
}

// --- Orders -----------------------------------------------------------------

export interface OrderRecord {
  idempotencyKey: string;
  signalId: string;
  usMarketSlug: string;
  outcome: string;
  intent: string;
  orderType: string;
  price: number;
  quantity: number;
  notionalUsd: number;
  tif: string;
  mode: string;
  lifecycle: string;
  exchangeOrderId?: string | null;
  preview?: unknown;
  response?: unknown;
  error?: string | null;
}

/** Returns the new order id, or null if an order with this key already exists. */
export async function insertOrderIfNew(o: OrderRecord): Promise<number | null> {
  const res = await query<{ id: string }>(
    `INSERT INTO orders
       (idempotency_key, signal_id, us_market_slug, outcome, intent, order_type,
        price, quantity, notional_usd, tif, mode, lifecycle, exchange_order_id,
        preview, response, error)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
     ON CONFLICT (idempotency_key) DO NOTHING
     RETURNING id`,
    [
      o.idempotencyKey,
      o.signalId,
      o.usMarketSlug,
      o.outcome,
      o.intent,
      o.orderType,
      o.price,
      o.quantity,
      o.notionalUsd,
      o.tif,
      o.mode,
      o.lifecycle,
      o.exchangeOrderId ?? null,
      o.preview ? JSON.stringify(o.preview) : null,
      o.response ? JSON.stringify(o.response) : null,
      o.error ?? null,
    ],
  );
  return res.rows[0] ? Number(res.rows[0].id) : null;
}

export async function orderKeyExists(idempotencyKey: string): Promise<boolean> {
  const res = await query('SELECT 1 FROM orders WHERE idempotency_key = $1', [idempotencyKey]);
  return (res.rowCount ?? 0) > 0;
}

export async function updateOrder(
  id: number,
  patch: {
    lifecycle?: string;
    exchangeOrderId?: string | null;
    response?: unknown;
    error?: string | null;
  },
): Promise<void> {
  await query(
    `UPDATE orders SET
       lifecycle = COALESCE($2, lifecycle),
       exchange_order_id = COALESCE($3, exchange_order_id),
       response = COALESCE($4, response),
       error = COALESCE($5, error),
       updated_at = now()
     WHERE id = $1`,
    [
      id,
      patch.lifecycle ?? null,
      patch.exchangeOrderId ?? null,
      patch.response ? JSON.stringify(patch.response) : null,
      patch.error ?? null,
    ],
  );
}

export async function recentOrders(limit = 50): Promise<Record<string, unknown>[]> {
  const res = await query('SELECT * FROM orders ORDER BY created_at DESC LIMIT $1', [limit]);
  return res.rows;
}

export async function openOrderCount(): Promise<number> {
  const res = await query<{ count: string }>(
    `SELECT count(*)::text AS count FROM orders
     WHERE lifecycle IN ('submitted','partially_filled','pending_approval','previewed')`,
  );
  return Number(res.rows[0]?.count ?? 0);
}

// --- Positions --------------------------------------------------------------

export interface PositionRow {
  usMarketSlug: string;
  outcome: string | null;
  netQuantity: number;
  avgCost: number | null;
  costUsd: number | null;
  realizedPnlUsd: number | null;
  unrealizedPnlUsd: number | null;
  cashValueUsd: number | null;
}

export async function upsertPosition(p: PositionRow): Promise<void> {
  await query(
    `INSERT INTO positions
       (us_market_slug, outcome, net_quantity, avg_cost, cost_usd,
        realized_pnl_usd, unrealized_pnl_usd, cash_value_usd, opened_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,now(),now())
     ON CONFLICT (us_market_slug) DO UPDATE SET
       outcome = EXCLUDED.outcome,
       net_quantity = EXCLUDED.net_quantity,
       avg_cost = EXCLUDED.avg_cost,
       cost_usd = EXCLUDED.cost_usd,
       realized_pnl_usd = EXCLUDED.realized_pnl_usd,
       unrealized_pnl_usd = EXCLUDED.unrealized_pnl_usd,
       cash_value_usd = EXCLUDED.cash_value_usd,
       updated_at = now()`,
    [
      p.usMarketSlug,
      p.outcome,
      p.netQuantity,
      p.avgCost,
      p.costUsd,
      p.realizedPnlUsd,
      p.unrealizedPnlUsd,
      p.cashValueUsd,
    ],
  );
}

export async function listPositions(): Promise<PositionRow[]> {
  const res = await query<{
    us_market_slug: string;
    outcome: string | null;
    net_quantity: string;
    avg_cost: string | null;
    cost_usd: string | null;
    realized_pnl_usd: string | null;
    unrealized_pnl_usd: string | null;
    cash_value_usd: string | null;
  }>('SELECT * FROM positions WHERE net_quantity <> 0 ORDER BY updated_at DESC');
  return res.rows.map((r) => ({
    usMarketSlug: r.us_market_slug,
    outcome: r.outcome,
    netQuantity: Number(r.net_quantity),
    avgCost: r.avg_cost === null ? null : Number(r.avg_cost),
    costUsd: r.cost_usd === null ? null : Number(r.cost_usd),
    realizedPnlUsd: r.realized_pnl_usd === null ? null : Number(r.realized_pnl_usd),
    unrealizedPnlUsd: r.unrealized_pnl_usd === null ? null : Number(r.unrealized_pnl_usd),
    cashValueUsd: r.cash_value_usd === null ? null : Number(r.cash_value_usd),
  }));
}

export async function getPosition(slug: string): Promise<PositionRow | null> {
  const all = await listPositions();
  return all.find((p) => p.usMarketSlug === slug) ?? null;
}

/** Total absolute exposure across open positions, in USD. */
export async function totalExposureUsd(): Promise<number> {
  const res = await query<{ total: string | null }>(
    `SELECT COALESCE(SUM(ABS(COALESCE(cost_usd,0))),0)::text AS total
     FROM positions WHERE net_quantity <> 0`,
  );
  return Number(res.rows[0]?.total ?? 0);
}

export async function marketExposureUsd(slug: string): Promise<number> {
  const p = await getPosition(slug);
  return p ? Math.abs(p.costUsd ?? 0) : 0;
}

// --- Cooldowns --------------------------------------------------------------

export async function setCooldown(slug: string, minutes: number): Promise<void> {
  await query(
    `INSERT INTO market_cooldowns (us_market_slug, cooldown_until)
     VALUES ($1, now() + make_interval(mins => $2))
     ON CONFLICT (us_market_slug) DO UPDATE SET cooldown_until = EXCLUDED.cooldown_until`,
    [slug, minutes],
  );
}

export async function inCooldown(slug: string): Promise<boolean> {
  const res = await query(
    'SELECT 1 FROM market_cooldowns WHERE us_market_slug = $1 AND cooldown_until > now()',
    [slug],
  );
  return (res.rowCount ?? 0) > 0;
}

// --- Daily stats ------------------------------------------------------------

export interface DailyStats {
  tradesCount: number;
  realizedPnlUsd: number;
}

export async function getTodayStats(): Promise<DailyStats> {
  const res = await query<{ trades_count: number; realized_pnl_usd: string }>(
    `SELECT trades_count, realized_pnl_usd FROM daily_stats WHERE stat_date = (now() at time zone 'utc')::date`,
  );
  const row = res.rows[0];
  return {
    tradesCount: row?.trades_count ?? 0,
    realizedPnlUsd: row ? Number(row.realized_pnl_usd) : 0,
  };
}

export async function incrementTradeCount(): Promise<void> {
  await query(
    `INSERT INTO daily_stats (stat_date, trades_count)
     VALUES ((now() at time zone 'utc')::date, 1)
     ON CONFLICT (stat_date) DO UPDATE SET trades_count = daily_stats.trades_count + 1, updated_at = now()`,
  );
}

export async function addRealizedPnl(amountUsd: number): Promise<void> {
  await query(
    `INSERT INTO daily_stats (stat_date, realized_pnl_usd)
     VALUES ((now() at time zone 'utc')::date, $1)
     ON CONFLICT (stat_date) DO UPDATE SET
       realized_pnl_usd = daily_stats.realized_pnl_usd + $1, updated_at = now()`,
    [amountUsd],
  );
}

// --- Consensus signal helper -----------------------------------------------

export async function hasOpenPositionConflicting(
  slug: string,
  outcome: string,
): Promise<boolean> {
  const p = await getPosition(slug);
  if (!p || p.netQuantity === 0) return false;
  // Any existing open position in this market conflicts: a different outcome is
  // a genuine conflict, and the same outcome would mean averaging up — which is
  // disallowed. Either way, a new entry is blocked.
  void outcome;
  return true;
}

export type { ConsensusSignal };
