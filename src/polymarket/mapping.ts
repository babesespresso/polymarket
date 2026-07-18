import { getPublicClient } from './client';
import { log } from '../logger';
import { MarketMapping, TraderMarketAction } from '../types';
import { saveMapping } from '../db/repo';

/**
 * Market-mapping layer: global Polymarket markets (from the public leaderboard
 * data) are NOT guaranteed to correspond to Polymarket US markets. Global IDs
 * and slugs must never be assumed to match. Before any trade we require an
 * exact, verified match on:
 *   - Market question
 *   - Selected outcome
 *   - Closing time
 *   - Resolution source / rules
 *
 * Anything uncertain or incomplete is rejected. Rejection is the safe default.
 */

const CLOSE_TIME_TOLERANCE_MS = 60 * 60 * 1000; // 1 hour

export function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Token Jaccard similarity of two strings, 0..1. */
export function similarity(a: string, b: string): number {
  const ta = new Set(normalize(a).split(' ').filter(Boolean));
  const tb = new Set(normalize(b).split(' ').filter(Boolean));
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  const union = ta.size + tb.size - inter;
  return union === 0 ? 0 : inter / union;
}

export function outcomeMatches(a: string, b: string): boolean {
  const na = normalize(a);
  const nb = normalize(b);
  if (na === nb) return true;
  // Common yes/no equivalences.
  const yes = new Set(['yes', 'y', 'true']);
  const no = new Set(['no', 'n', 'false']);
  if (yes.has(na) && yes.has(nb)) return true;
  if (no.has(na) && no.has(nb)) return true;
  return false;
}

export interface MappingInput {
  globalMarketId: string;
  question: string;
  outcome: string;
  /** Optional expected close time from the global source, epoch ms. */
  expectedCloseMs?: number;
  /** Optional expected resolution source text from the global source. */
  expectedResolutionSource?: string;
}

/**
 * Attempt to map a global market/outcome to a verified Polymarket US market.
 * Persists the mapping (verified or not) and returns it.
 */
export async function verifyMapping(input: MappingInput): Promise<MarketMapping> {
  const reject = (reason: string): MarketMapping => ({
    globalMarketId: input.globalMarketId,
    usMarketSlug: '',
    outcome: input.outcome,
    question: input.question,
    closeTimeIso: '',
    resolutionSource: '',
    verified: false,
    reason,
  });

  let mapping: MarketMapping;
  try {
    const client = getPublicClient();
    const search = await client.search.query({ query: input.question, status: 'active', limit: 10 });
    const events = search.events ?? [];

    // Flatten candidate (event, market) pairs and score by question similarity.
    type Candidate = {
      slug: string;
      title: string;
      outcome: string;
      eventEndTime?: string;
      eventDescription?: string;
      closed: boolean;
      active: boolean;
      score: number;
    };
    const candidates: Candidate[] = [];
    for (const ev of events) {
      for (const m of ev.markets ?? []) {
        candidates.push({
          slug: m.slug,
          title: m.title,
          outcome: m.outcome,
          eventEndTime: ev.endTime,
          eventDescription: ev.description,
          closed: m.closed,
          active: m.active,
          score: similarity(input.question, `${ev.title} ${m.title}`),
        });
      }
    }
    candidates.sort((a, b) => b.score - a.score);

    const best = candidates[0];
    const runnerUp = candidates[1];

    if (!best) {
      mapping = reject('no candidate US market found for question');
    } else if (best.score < 0.6) {
      mapping = reject(`best candidate similarity too low (${best.score.toFixed(2)})`);
    } else if (runnerUp && best.score - runnerUp.score < 0.1) {
      // Ambiguous: two candidates are too close to distinguish confidently.
      mapping = reject(
        `ambiguous match: top two candidates within 0.1 similarity (${best.score.toFixed(
          2,
        )} vs ${runnerUp.score.toFixed(2)})`,
      );
    } else if (best.closed || !best.active) {
      mapping = reject('matched US market is closed or inactive');
    } else if (!outcomeMatches(best.outcome, input.outcome)) {
      mapping = reject(
        `outcome mismatch: US="${best.outcome}" vs requested="${input.outcome}"`,
      );
    } else if (
      input.expectedCloseMs &&
      best.eventEndTime &&
      Math.abs(new Date(best.eventEndTime).getTime() - input.expectedCloseMs) >
        CLOSE_TIME_TOLERANCE_MS
    ) {
      mapping = reject('closing time mismatch beyond tolerance');
    } else if (
      input.expectedResolutionSource &&
      best.eventDescription &&
      similarity(input.expectedResolutionSource, best.eventDescription) < 0.2
    ) {
      mapping = reject('resolution source/rules do not match');
    } else {
      mapping = {
        globalMarketId: input.globalMarketId,
        usMarketSlug: best.slug,
        outcome: best.outcome,
        question: best.title,
        closeTimeIso: best.eventEndTime ?? '',
        resolutionSource: best.eventDescription ?? '',
        verified: true,
        reason: `verified: similarity=${best.score.toFixed(2)}, outcome matched, market open`,
      };
    }
  } catch (err) {
    mapping = reject(
      `mapping lookup error: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  await saveMapping(mapping).catch((e) =>
    log.warn('failed to persist mapping', { error: String(e) }),
  );
  return mapping;
}

/** Convenience: verify a mapping directly from a trader action. */
export async function verifyActionMapping(action: TraderMarketAction): Promise<MarketMapping> {
  return verifyMapping({
    globalMarketId: action.globalMarketId,
    question: action.marketQuestion,
    outcome: action.outcome,
  });
}
