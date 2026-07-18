import './setupEnv';
import { describe, it, expect, vi } from 'vitest';

// Fail the market-data branch fast so offline exit tests do not hit the network.
vi.mock('../src/polymarket/client', () => ({
  getClient: () => {
    throw new Error('offline in tests');
  },
  getPublicClient: () => {
    throw new Error('offline in tests');
  },
}));

import { evaluatePositionExit, ExitContext } from '../src/engine/exits';
import { PositionRow } from '../src/db/repo';

/**
 * Exit rules that do not depend on live market data (take-profit, stop-loss,
 * consensus reversal, max hold time) are tested directly. Env sets DISABLE_
 * PUBLIC_API and there is no DB, so the market-data branch simply no-ops.
 */

const NOW = 1_700_000_000_000;

function pos(over: Partial<PositionRow> = {}): PositionRow {
  return {
    usMarketSlug: 'will-x-happen',
    outcome: 'Yes',
    netQuantity: 100,
    avgCost: 0.5,
    costUsd: 50,
    realizedPnlUsd: 0,
    unrealizedPnlUsd: 0,
    cashValueUsd: 50,
    ...over,
  };
}

function ctx(over: Partial<ExitContext> = {}): ExitContext {
  return { reversedMarkets: new Set(), openedAt: new Map(), ...over };
}

describe('exit rules', () => {
  it('fires take-profit when gains exceed the threshold', async () => {
    // Default TAKE_PROFIT_PCT is 25%. cost 50 -> value 70 is +40%.
    const exit = await evaluatePositionExit(pos({ cashValueUsd: 70 }), ctx(), NOW);
    expect(exit?.reason).toBe('take_profit');
  });

  it('fires stop-loss when losses exceed the threshold', async () => {
    // Default STOP_LOSS_PCT is 20%. cost 50 -> value 39 is -22%.
    const exit = await evaluatePositionExit(pos({ cashValueUsd: 39 }), ctx(), NOW);
    expect(exit?.reason).toBe('stop_loss');
  });

  it('fires consensus reversal when the market is flagged reversed', async () => {
    const exit = await evaluatePositionExit(
      pos({ cashValueUsd: 50 }),
      ctx({ reversedMarkets: new Set(['will-x-happen']) }),
      NOW,
    );
    expect(exit?.reason).toBe('consensus_reversal');
  });

  it('fires max-hold-time when a position is too old', async () => {
    const opened = new Map([['will-x-happen', NOW - 200 * 3600 * 1000]]); // 200h, default max 168h
    const exit = await evaluatePositionExit(pos({ cashValueUsd: 50 }), ctx({ openedAt: opened }), NOW);
    expect(exit?.reason).toBe('max_hold_time');
  });

  it('does not fire when the position is healthy and within policy', async () => {
    const exit = await evaluatePositionExit(pos({ cashValueUsd: 52 }), ctx(), NOW);
    // Small +4% gain, not reversed, not old, market-data branch no-ops offline.
    expect(exit).toBeNull();
  });
});
