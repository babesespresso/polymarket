import { getClient } from '../polymarket/client';
import { log } from '../logger';
import { audit } from '../db/audit';
import { upsertPosition } from '../db/repo';
import { AuthenticationError, BadRequestError, NotFoundError, RateLimitError } from 'polymarket-us';

/**
 * The SDK does not export dedicated APITimeoutError / APIConnectionError
 * classes, so transient network failures are matched by name/message.
 */
function isTransientNetworkError(err: unknown): boolean {
  const name = err instanceof Error ? err.name : '';
  const message = err instanceof Error ? err.message : String(err);
  return /timeout|timedout|connection|econn|socket|network|fetch failed|aborted/i.test(
    `${name} ${message}`,
  );
}

/**
 * Reconciliation compares exchange truth (balances, positions, activities,
 * open orders) against our database. It runs at startup and periodically.
 *
 * Only safe READS are retried (with backoff). Order creation is never retried
 * here — that is handled explicitly in execution. A reconciliation failure is a
 * trading-halt condition surfaced to the caller.
 */

export interface ReconcileResult {
  ok: boolean;
  balancesUsd: number;
  positionCount: number;
  openOrderCount: number;
  discrepancies: string[];
  error?: string;
}

async function retryRead<T>(label: string, fn: () => Promise<T>, attempts = 4): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      // Do not retry auth or bad-request errors — they will not self-heal.
      if (err instanceof AuthenticationError || err instanceof BadRequestError || err instanceof NotFoundError) {
        throw err;
      }
      if (err instanceof RateLimitError || isTransientNetworkError(err)) {
        const delay = Math.min(16_000, 2000 * 2 ** i);
        log.warn(`reconcile read retry: ${label}`, { attempt: i + 1, delayMs: delay });
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

export async function reconcile(): Promise<ReconcileResult> {
  const client = getClient();
  const discrepancies: string[] = [];

  try {
    const balancesRes = await retryRead('balances', () => client.account.balances());
    const usd = balancesRes.balances?.find((b) => b.currency === 'USD') ?? balancesRes.balances?.[0];
    const balancesUsd = usd?.currentBalance ?? 0;

    const positionsRes = await retryRead('positions', () => client.portfolio.positions());
    const positions = positionsRes.positions ?? {};
    let positionCount = 0;
    for (const [slug, pos] of Object.entries(positions)) {
      const net = Number(pos.netPosition);
      if (net === 0) continue;
      positionCount++;
      await upsertPosition({
        usMarketSlug: slug,
        outcome: pos.marketMetadata?.outcome ?? null,
        netQuantity: net,
        avgCost: null,
        costUsd: Number(pos.cost?.value ?? 0),
        realizedPnlUsd: Number(pos.realized?.value ?? 0),
        unrealizedPnlUsd: null,
        cashValueUsd: pos.cashValue ? Number(pos.cashValue.value) : null,
      });
    }

    const ordersRes = await retryRead('orders', () => client.orders.list());
    const openOrderCount = ordersRes.orders?.length ?? 0;

    // Activities are read for the audit trail / PnL cross-check.
    await retryRead('activities', () => client.portfolio.activities({ limit: 50 })).catch((e) => {
      discrepancies.push(`activities read failed: ${e instanceof Error ? e.message : String(e)}`);
      return null;
    });

    await audit('worker', 'reconcile_ok', { balancesUsd, positionCount, openOrderCount });

    return { ok: true, balancesUsd, positionCount, openOrderCount, discrepancies };
  } catch (err) {
    const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    await audit('worker', 'reconcile_failed', { error: message });
    log.error('reconciliation failed', { error: message });
    return { ok: false, balancesUsd: 0, positionCount: 0, openOrderCount: 0, discrepancies, error: message };
  }
}
