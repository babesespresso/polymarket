import { PolymarketUS, AuthenticationError } from 'polymarket-us';
import { readCredentials } from '../config';
import { log } from '../logger';

/**
 * Authenticated Polymarket US client. Credentials are read from the
 * environment at construction time and never logged or exposed elsewhere.
 */

let client: PolymarketUS | null = null;

export function getClient(): PolymarketUS {
  if (client) return client;
  const { keyId, secretKey } = readCredentials();
  client = new PolymarketUS({ keyId, secretKey });
  return client;
}

/** Public (unauthenticated) client for market data that needs no auth. */
let publicClient: PolymarketUS | null = null;
export function getPublicClient(): PolymarketUS {
  if (publicClient) return publicClient;
  publicClient = new PolymarketUS();
  return publicClient;
}

/**
 * Validate authentication at startup by calling account.balances(). Fails
 * closed: throws if credentials are rejected or unreachable, so the worker
 * refuses to run without a verified authenticated session.
 */
export async function validateAuthentication(): Promise<void> {
  try {
    const res = await getClient().account.balances();
    const count = res.balances?.length ?? 0;
    log.info('authentication verified', { balanceEntries: count });
  } catch (err) {
    if (err instanceof AuthenticationError) {
      throw new Error('Authentication failed: Polymarket US rejected the API credentials.');
    }
    throw new Error(
      `Could not verify authentication with Polymarket US: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}
