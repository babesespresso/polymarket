-- ===========================================================================
-- Smart Money Consensus Trader — schema
-- Idempotent: safe to run on every startup (CREATE ... IF NOT EXISTS).
-- ===========================================================================

-- Single-row-per-lock distributed worker lock. A worker "owns" execution only
-- while its lease is valid; expired leases can be stolen by another worker.
CREATE TABLE IF NOT EXISTS worker_lock (
  lock_name    TEXT PRIMARY KEY,
  holder_id    TEXT NOT NULL,
  acquired_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at   TIMESTAMPTZ NOT NULL
);

-- Worker health / heartbeat.
CREATE TABLE IF NOT EXISTS worker_health (
  worker_id            TEXT PRIMARY KEY,
  lease_holder         BOOLEAN NOT NULL DEFAULT false,
  last_cycle_at        TIMESTAMPTZ,
  last_cycle_status    TEXT,
  ws_markets_connected BOOLEAN NOT NULL DEFAULT false,
  ws_private_connected BOOLEAN NOT NULL DEFAULT false,
  error_state          TEXT,
  started_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Mutable control flags (single row, id = 1). Kill switch, pause, etc.
CREATE TABLE IF NOT EXISTS control_state (
  id                 INT PRIMARY KEY DEFAULT 1,
  trading_paused     BOOLEAN NOT NULL DEFAULT false,
  kill_switch_active BOOLEAN NOT NULL DEFAULT false,
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by         TEXT,
  CONSTRAINT control_state_singleton CHECK (id = 1)
);
INSERT INTO control_state (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- Raw leaderboard snapshots, one row per (trader, period, snapshot).
CREATE TABLE IF NOT EXISTS leaderboard_snapshots (
  id           BIGSERIAL PRIMARY KEY,
  captured_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  period       TEXT NOT NULL,
  trader_id    TEXT NOT NULL,
  handle       TEXT,
  rank         INT NOT NULL,
  pnl_usd      NUMERIC NOT NULL,
  volume_usd   NUMERIC
);
CREATE INDEX IF NOT EXISTS idx_lb_snap_captured ON leaderboard_snapshots (captured_at DESC);
CREATE INDEX IF NOT EXISTS idx_lb_snap_trader ON leaderboard_snapshots (trader_id);

-- Computed trader quality scores.
CREATE TABLE IF NOT EXISTS trader_scores (
  id           BIGSERIAL PRIMARY KEY,
  computed_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  trader_id    TEXT NOT NULL,
  handle       TEXT,
  score        NUMERIC NOT NULL,
  qualified    BOOLEAN NOT NULL,
  components   JSONB NOT NULL,
  penalties    JSONB NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_scores_trader ON trader_scores (trader_id, computed_at DESC);

-- Verified market mappings (global -> Polymarket US).
CREATE TABLE IF NOT EXISTS market_mappings (
  id                BIGSERIAL PRIMARY KEY,
  global_market_id  TEXT NOT NULL,
  us_market_slug    TEXT,
  outcome           TEXT NOT NULL,
  question          TEXT,
  close_time        TIMESTAMPTZ,
  resolution_source TEXT,
  verified          BOOLEAN NOT NULL,
  reason            TEXT NOT NULL,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (global_market_id, outcome)
);

-- Consensus signals (every signal, accepted or not).
CREATE TABLE IF NOT EXISTS signals (
  id                          TEXT PRIMARY KEY, -- deterministic idempotency key
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  us_market_slug              TEXT NOT NULL,
  outcome                     TEXT NOT NULL,
  question                    TEXT,
  aligned_traders             INT NOT NULL,
  aligned_pct                 NUMERIC,
  quality_weighted_score      NUMERIC,
  capital_weighted_usd        NUMERIC,
  avg_entry_price             NUMERIC,
  current_price               NUMERIC,
  net_direction               TEXT,
  spread                      NUMERIC,
  liquidity_usd               NUMERIC,
  time_remaining_hours        NUMERIC,
  available_upside_pct        NUMERIC,
  newest_entry_ts             TIMESTAMPTZ,
  decision                    TEXT NOT NULL,       -- accepted | rejected
  reasons                     JSONB NOT NULL,
  raw                         JSONB
);
CREATE INDEX IF NOT EXISTS idx_signals_created ON signals (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_signals_market ON signals (us_market_slug);

-- Orders: paper and live. One row per attempted order.
CREATE TABLE IF NOT EXISTS orders (
  id                 BIGSERIAL PRIMARY KEY,
  idempotency_key    TEXT NOT NULL UNIQUE,  -- prevents duplicate submissions
  signal_id          TEXT REFERENCES signals (id),
  us_market_slug     TEXT NOT NULL,
  outcome            TEXT NOT NULL,
  intent             TEXT NOT NULL,
  order_type         TEXT NOT NULL,
  price              NUMERIC NOT NULL,
  quantity           NUMERIC NOT NULL,
  notional_usd       NUMERIC NOT NULL,
  tif                TEXT NOT NULL,
  mode               TEXT NOT NULL,          -- paper | approval | live
  lifecycle          TEXT NOT NULL,          -- see OrderLifecycle
  exchange_order_id  TEXT,                   -- id returned by the exchange
  preview            JSONB,
  response           JSONB,
  error              TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_orders_market ON orders (us_market_slug);
CREATE INDEX IF NOT EXISTS idx_orders_lifecycle ON orders (lifecycle);
CREATE INDEX IF NOT EXISTS idx_orders_created ON orders (created_at DESC);

-- Fills / executions.
CREATE TABLE IF NOT EXISTS fills (
  id                 BIGSERIAL PRIMARY KEY,
  order_id           BIGINT REFERENCES orders (id),
  exchange_order_id  TEXT,
  us_market_slug     TEXT NOT NULL,
  price              NUMERIC NOT NULL,
  quantity           NUMERIC NOT NULL,
  notional_usd       NUMERIC NOT NULL,
  fill_type          TEXT,
  realized_pnl_usd   NUMERIC,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_fills_order ON fills (order_id);

-- Positions cache (mirrors exchange, reconciled regularly).
CREATE TABLE IF NOT EXISTS positions (
  us_market_slug     TEXT PRIMARY KEY,
  outcome            TEXT,
  net_quantity       NUMERIC NOT NULL,
  avg_cost           NUMERIC,
  cost_usd           NUMERIC,
  realized_pnl_usd   NUMERIC,
  unrealized_pnl_usd NUMERIC,
  cash_value_usd     NUMERIC,
  opened_at          TIMESTAMPTZ,
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Per-market cooldowns.
CREATE TABLE IF NOT EXISTS market_cooldowns (
  us_market_slug  TEXT PRIMARY KEY,
  cooldown_until  TIMESTAMPTZ NOT NULL
);

-- Daily accounting for loss/trade-count limits (keyed by UTC date).
CREATE TABLE IF NOT EXISTS daily_stats (
  stat_date        DATE PRIMARY KEY,
  trades_count     INT NOT NULL DEFAULT 0,
  realized_pnl_usd NUMERIC NOT NULL DEFAULT 0,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Immutable audit log. Append-only by convention; a trigger blocks UPDATE/DELETE.
CREATE TABLE IF NOT EXISTS audit_log (
  id          BIGSERIAL PRIMARY KEY,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  actor       TEXT NOT NULL,        -- worker | admin:<token-hash> | system
  action      TEXT NOT NULL,
  entity      TEXT,
  entity_id   TEXT,
  detail      JSONB
);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_log (action);

CREATE OR REPLACE FUNCTION audit_log_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only; % is not permitted', TG_OP;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_audit_immutable ON audit_log;
CREATE TRIGGER trg_audit_immutable
  BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_immutable();

-- Atomic lease acquire/renew. Returns TRUE if the caller holds the lease after
-- the call. A lease is grantable when it does not exist, is expired, or is
-- already held by the caller (renewal).
CREATE OR REPLACE FUNCTION acquire_worker_lease(
  p_lock_name TEXT,
  p_holder_id TEXT,
  p_ttl_seconds INT
) RETURNS BOOLEAN AS $$
DECLARE
  v_now TIMESTAMPTZ := now();
  v_expires TIMESTAMPTZ := now() + make_interval(secs => p_ttl_seconds);
  v_rows INT;
BEGIN
  INSERT INTO worker_lock (lock_name, holder_id, acquired_at, expires_at)
  VALUES (p_lock_name, p_holder_id, v_now, v_expires)
  ON CONFLICT (lock_name) DO UPDATE
    SET holder_id = EXCLUDED.holder_id,
        acquired_at = v_now,
        expires_at = v_expires
    WHERE worker_lock.expires_at < v_now
       OR worker_lock.holder_id = p_holder_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows > 0;
END;
$$ LANGUAGE plpgsql;
