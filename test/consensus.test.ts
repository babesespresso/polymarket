import './setupEnv';
import { describe, it, expect } from 'vitest';
import {
  computeConsensus,
  evaluateSignal,
  signalKey,
  ConsensusInput,
} from '../src/engine/consensus';
import { TraderMarketAction, TraderScore } from '../src/types';

const NOW = 1_700_000_000_000;

function score(id: string, s: number): TraderScore {
  return { traderId: id, score: s, qualified: true, components: {}, penalties: {}, computedAt: NOW };
}

function action(id: string, over: Partial<TraderMarketAction> = {}): TraderMarketAction {
  return {
    traderId: id,
    globalMarketId: 'gm1',
    marketQuestion: 'Will X happen?',
    outcome: 'Yes',
    sizeUsd: 1000,
    entryPrice: 0.45,
    direction: 'adding',
    timestamp: NOW - 3600 * 1000,
    ...over,
  };
}

function input(over: Partial<ConsensusInput> = {}): ConsensusInput {
  const scores = new Map<string, TraderScore>([
    ['a', score('a', 85)],
    ['b', score('b', 82)],
    ['c', score('c', 90)],
  ]);
  return {
    usMarketSlug: 'will-x-happen',
    outcome: 'Yes',
    question: 'Will X happen?',
    actions: [action('a'), action('b'), action('c')],
    scores,
    totalQualifiedTraders: 4,
    snapshot: { currentPrice: 0.5, spread: 0.02, liquidityUsd: 500, timeRemainingHours: 48 },
    now: NOW,
    ...over,
  };
}

describe('signalKey', () => {
  it('is deterministic for the same market/outcome/day', () => {
    expect(signalKey('m', 'Yes', '2026-07-18')).toBe(signalKey('m', 'Yes', '2026-07-18'));
  });
  it('differs across markets/outcomes/days', () => {
    expect(signalKey('m', 'Yes', '2026-07-18')).not.toBe(signalKey('m', 'No', '2026-07-18'));
    expect(signalKey('m', 'Yes', '2026-07-18')).not.toBe(signalKey('m', 'Yes', '2026-07-19'));
  });
});

describe('computeConsensus', () => {
  it('counts distinct aligned traders (dedup by latest action)', () => {
    const c = computeConsensus(
      input({ actions: [action('a'), action('a', { timestamp: NOW }), action('b'), action('c')] }),
    );
    expect(c.alignedTraders).toBe(3);
  });

  it('caps whale conviction so one trader cannot dominate', () => {
    const withWhale = computeConsensus(
      input({
        actions: [
          action('a', { sizeUsd: 1_000_000 }),
          action('b', { sizeUsd: 1000 }),
          action('c', { sizeUsd: 1000 }),
        ],
      }),
    );
    // The whale is capped at 25% of the raw total, not its full size.
    expect(withWhale.capitalWeightedConvictionUsd).toBeLessThan(1_000_000);
  });

  it('computes recency windows', () => {
    const c = computeConsensus(
      input({
        actions: [
          action('a', { timestamp: NOW - 30 * 60 * 1000 }), // 0.5h
          action('b', { timestamp: NOW - 5 * 3600 * 1000 }), // 5h
          action('c', { timestamp: NOW - 40 * 3600 * 1000 }), // 40h
        ],
      }),
    );
    expect(c.entriesLast1h).toBe(1);
    expect(c.entriesLast6h).toBe(2);
    expect(c.entriesLast24h).toBe(2);
    expect(c.entriesLast72h).toBe(3);
  });
});

describe('evaluateSignal gating', () => {
  const passingCtx = {
    hasConflictingPosition: false,
    mappingVerified: true,
    marketOpenAndTradeable: true,
    now: NOW,
  };

  it('accepts a fully-qualifying signal', () => {
    const c = computeConsensus(input());
    const ev = evaluateSignal(c, passingCtx);
    expect(ev.decision).toBe('accepted');
  });

  it('rejects when too few aligned traders', () => {
    const c = computeConsensus(input({ actions: [action('a'), action('b')] }));
    const ev = evaluateSignal(c, passingCtx);
    expect(ev.decision).toBe('rejected');
    expect(ev.reasons.some((r) => r.includes('aligned traders'))).toBe(true);
  });

  it('rejects stale consensus (no recent entries)', () => {
    const old = NOW - 100 * 3600 * 1000;
    const c = computeConsensus(
      input({ actions: [action('a', { timestamp: old }), action('b', { timestamp: old }), action('c', { timestamp: old })] }),
    );
    const ev = evaluateSignal(c, passingCtx);
    expect(ev.decision).toBe('rejected');
    expect(ev.reasons.some((r) => r.toLowerCase().includes('stale'))).toBe(true);
  });

  it('rejects when mapping is not verified', () => {
    const c = computeConsensus(input());
    const ev = evaluateSignal(c, { ...passingCtx, mappingVerified: false });
    expect(ev.decision).toBe('rejected');
  });

  it('rejects when a conflicting position exists', () => {
    const c = computeConsensus(input());
    const ev = evaluateSignal(c, { ...passingCtx, hasConflictingPosition: true });
    expect(ev.decision).toBe('rejected');
  });

  it('rejects when traders are net exiting', () => {
    const c = computeConsensus(
      input({
        actions: [
          action('a', { direction: 'exiting' }),
          action('b', { direction: 'exiting' }),
          action('c', { direction: 'reducing' }),
        ],
      }),
    );
    const ev = evaluateSignal(c, passingCtx);
    expect(ev.decision).toBe('rejected');
  });

  it('rejects when too close to resolution', () => {
    const c = computeConsensus(input({ snapshot: { currentPrice: 0.5, spread: 0.02, liquidityUsd: 500, timeRemainingHours: 1 } }));
    const ev = evaluateSignal(c, passingCtx);
    expect(ev.decision).toBe('rejected');
  });

  it('records a reason for every check (audit transparency)', () => {
    const c = computeConsensus(input());
    const ev = evaluateSignal(c, passingCtx);
    expect(ev.reasons.length).toBeGreaterThanOrEqual(10);
    expect(ev.reasons.every((r) => r.startsWith('PASS') || r.startsWith('FAIL'))).toBe(true);
  });
});
