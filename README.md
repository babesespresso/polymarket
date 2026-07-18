# Smart Money Consensus Trader (Polymarket US)

An always-on worker that ranks Polymarket traders by **repeatable, risk-adjusted
returns**, detects when several high-quality traders converge on the **same live
outcome**, and — once every safety gate passes — places **very small
proof-of-concept trades** on your Polymarket US account.

> ⚠️ **No guaranteed returns.** This is an experimental proof of concept.
> Position sizing is locked to environment variables and defaults to **paper
> trading**. Nothing here promises or assumes profit. Keep sizing tiny until you
> have manually reviewed the behaviour and chosen to raise the limits yourself.

---

## What it does

- **Trader ranking** — continuously analyses the top 20–25 leaderboard traders
  across DAY / WEEK / MONTH / ALL and computes a transparent **0–100 Trader
  Quality Score** from realized PnL, return on deployed capital, win rate, profit
  factor, average resolved-market return, 7- and 30-day consistency, max
  drawdown, sample size, recent activity, and market concentration. Tiny samples,
  one oversized win, unrealized-heavy PnL, inactivity, over-concentration, and
  contradictory trades are all penalised. **It never ranks on raw dollar PnL.**
- **Consensus engine** — groups qualified traders' positions/trades by *verified*
  market + outcome and computes aligned-trader count/percentage, quality-weighted
  consensus, capital-weighted conviction (with whale caps), average entry vs
  current price, entry recency (1h/6h/24h/72h), net direction (adding / holding /
  reducing / exiting), spread, liquidity, time remaining, and available upside.
- **Strict market mapping** — global Polymarket markets are **never assumed** to
  match Polymarket US markets. A trade only proceeds after an exact, verified
  match on question, outcome, closing time, and resolution source/rules. Anything
  uncertain is rejected.
- **Execution** — `paper` / `approval` / `live` modes (default `paper`). Live
  requires **both** `TRADING_MODE=live` **and** `POLYMARKET_LIVE_TRADING=true`.
  Every order refreshes balances/positions/book/status, sizes from
  `MAX_TRADE_USD`, runs `orders.preview()`, re-checks **all** limits, and submits
  a **LIMIT** order via `orders.create()`. Never market orders, never averages
  down, never chases a moved price, never duplicates (deterministic idempotency
  key persisted before submission).
- **Risk & exits** — all exposure/loss limits enforced before preview **and**
  before submission; 60-minute per-market cooldown; take-profit, stop-loss,
  consensus-reversal, max-hold-time, approaching-resolution, and
  liquidity-deterioration exits; cash reserve always preserved. New trading stops
  on daily-loss breach, stale data, DB failure, WebSocket desync, reconciliation
  failure, repeated API errors, or kill-switch.
- **24/7 worker** — a dedicated long-running process (separate from the admin
  UI), a distributed DB lease so only one execution worker acts, live market +
  private WebSockets with heartbeat/reconnect/backoff and polling fallback,
  startup + periodic reconciliation, health tracking, and restart recovery.
- **Admin dashboard & audit** — token-gated dashboard showing rankings, signals
  (with the exact accept/reject reason for each), balances, positions, orders,
  PnL, risk limits, and worker health; controls for Pause, Cancel Orders, Close
  Positions, and Emergency Kill Switch (each requires a typed confirmation);
  immutable append-only audit log of every consequential event.

## Architecture

```
polymarket-us SDK ─┐        ┌─ public Polymarket APIs (leaderboard, public positions/trades)
                   ▼        ▼
        ┌──────────────────────────────┐
        │  Worker (always-on process)  │   distributed lease → single active worker
        │  cycle: rank → consensus →   │
        │  map → gate → execute → exit │
        │  + reconcile + WebSockets    │
        └───────────────┬──────────────┘
                        │  Postgres (state, audit, idempotency)
        ┌───────────────┴──────────────┐
        │  Admin dashboard (separate)  │   token-gated controls + read-only views
        └──────────────────────────────┘
```

Source layout:

| Path | Responsibility |
|------|----------------|
| `src/config.ts` | Validated, fail-closed configuration |
| `src/db/` | Pool, schema, migrations, repo, immutable audit |
| `src/polymarket/` | Authenticated client, public API, strict market mapping |
| `src/engine/` | scoring, consensus, limits, risk, execution, exits, reconcile |
| `src/ws/` | WebSocket manager (heartbeat / reconnect / backoff) |
| `src/worker/` | main loop, cycle orchestration, lease, health |
| `src/admin/` | Express control API + static dashboard |
| `test/` | scoring, consensus, risk limits, idempotency, mapping, exits, config |

## Local development

```bash
npm install
cp .env.example .env      # fill in credentials + DATABASE_URL
npm run migrate:dev       # create the schema
npm run worker:dev        # run the worker (tsx watch)
npm run admin:dev         # run the admin dashboard (separate terminal)
npm test                  # run the test suite
npm run typecheck         # type-check without emitting
```

The admin dashboard is served at `http://localhost:$PORT/` (default 8080). Open
it, paste your `ADMIN_TOKEN`, and it polls `/api/admin/overview` every 15s.

## Deploying to Railway

This repo is set up for two Railway **services** sharing one Postgres plugin and
the same environment variables:

1. **Create the project & database**
   ```bash
   railway login
   railway init                       # or: railway link  (existing project)
   railway add --plugin postgresql    # provisions DATABASE_URL automatically
   ```

2. **Set the server-only environment variables** (never commit these):
   ```bash
   railway variables \
     --set POLYMARKET_KEY_ID=<your-key-id> \
     --set POLYMARKET_SECRET_KEY=<your-secret-key> \
     --set POLYMARKET_LIVE_TRADING=false \
     --set TRADING_MODE=paper \
     --set MAX_TRADE_USD=2 \
     --set MAX_MARKET_EXPOSURE_USD=4 \
     --set MAX_TOTAL_EXPOSURE_USD=20 \
     --set MAX_DAILY_LOSS_USD=5 \
     --set MAX_OPEN_POSITIONS=5 \
     --set MAX_TRADES_PER_DAY=10 \
     --set MIN_CASH_RESERVE_USD=20 \
     --set MIN_CONSENSUS_TRADERS=3 \
     --set MIN_CONSENSUS_SCORE=75 \
     --set ADMIN_TOKEN=<generate-a-long-random-string>
   ```
   `DATABASE_URL` and `PORT` are injected by Railway automatically.

3. **Worker service** — start command:
   ```
   npm run migrate && npm run worker
   ```
   Set it to always-on (no sleep). `railway.json` already sets a restart-on-
   failure policy.

4. **Admin service** — add a second service from the same repo with start
   command:
   ```
   npm run migrate && npm run admin
   ```
   Give it a public domain; the dashboard lives at `/`.

> Both services run `npm run migrate` first; the schema is idempotent so this is
> safe on every deploy.

### Going live (only when you're ready)

Live trading is intentionally hard to enable. Both must be true:

```bash
railway variables --set TRADING_MODE=live --set POLYMARKET_LIVE_TRADING=true
```

Leave sizing at the tiny defaults. Watch the dashboard's signal accept/reject
reasons and the audit log before raising any limit.

## Safety model (summary)

- Credentials are read from env, never logged, never returned by any API, never
  sent to the browser. The logger redacts secret-shaped values defensively.
- Authentication is verified at startup via `account.balances()`; the worker
  **fails closed** if it cannot.
- All risk limits are checked **twice** (before preview and before submission)
  and are backed by pure, unit-tested predicates (`src/engine/limits.ts`).
- Orders are idempotent: a deterministic key is persisted before submission and
  enforced by a `UNIQUE` DB constraint, so a crash/retry cannot double-submit.
- Live order creation is **never blindly retried** — an uncertain outcome is left
  for reconciliation to confirm.
- The audit log is append-only (a DB trigger blocks UPDATE/DELETE).

## Tests

`npm test` covers scoring (including "no ranking by raw PnL" and every penalty),
consensus gating (all rejection paths), risk-limit predicates, order idempotency
/ duplicate prevention, market-mapping helpers, exit rules, and config
fail-closed behaviour (paper default, live-requires-both, missing-credential
throw).
