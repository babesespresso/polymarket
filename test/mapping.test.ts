import { describe, it, expect } from 'vitest';
import { normalize, similarity, outcomeMatches } from '../src/polymarket/mapping';

describe('market mapping helpers', () => {
  it('normalizes punctuation and case', () => {
    expect(normalize('Will BTC hit $100K?!')).toBe('will btc hit 100k');
  });

  it('gives high similarity to near-identical questions', () => {
    expect(similarity('Will BTC hit 100k in 2025', 'Will BTC hit 100k in 2025?')).toBeGreaterThan(
      0.9,
    );
  });

  it('gives low similarity to unrelated questions', () => {
    expect(similarity('Will BTC hit 100k', 'Who wins the Super Bowl')).toBeLessThan(0.3);
  });

  it('matches equivalent yes/no outcomes', () => {
    expect(outcomeMatches('Yes', 'yes')).toBe(true);
    expect(outcomeMatches('YES', 'true')).toBe(true);
    expect(outcomeMatches('No', 'false')).toBe(true);
  });

  it('does not match opposing outcomes', () => {
    expect(outcomeMatches('Yes', 'No')).toBe(false);
    expect(outcomeMatches('Chiefs', 'Eagles')).toBe(false);
  });
});
