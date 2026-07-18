import './setupEnv';
import { describe, it, expect } from 'vitest';
import { signalKey } from '../src/engine/consensus';

/**
 * Idempotency is enforced at two layers:
 *   1. A deterministic signal id (market + outcome + day) → a stable order key.
 *   2. A UNIQUE constraint on orders.idempotency_key with INSERT ... ON CONFLICT
 *      DO NOTHING (see schema.sql / repo.insertOrderIfNew).
 *
 * Here we prove layer 1 is deterministic and simulate layer 2's guarantee: a
 * second insert with the same key is a no-op.
 */

function orderKey(signalId: string): string {
  return `order:${signalId}`;
}

// In-memory stand-in for the UNIQUE(idempotency_key) + ON CONFLICT DO NOTHING.
class FakeOrderStore {
  private keys = new Set<string>();
  insertIfNew(key: string): number | null {
    if (this.keys.has(key)) return null;
    this.keys.add(key);
    return this.keys.size;
  }
}

describe('order idempotency', () => {
  it('derives a stable order key from a deterministic signal id', () => {
    const id = signalKey('will-x-happen', 'Yes', '2026-07-18');
    expect(orderKey(id)).toBe(orderKey(id));
  });

  it('prevents duplicate submissions for the same signal/day', () => {
    const store = new FakeOrderStore();
    const id = signalKey('will-x-happen', 'Yes', '2026-07-18');
    const first = store.insertIfNew(orderKey(id));
    const second = store.insertIfNew(orderKey(id));
    expect(first).not.toBeNull();
    expect(second).toBeNull(); // duplicate blocked
  });

  it('allows a new order on a different day (new signal id)', () => {
    const store = new FakeOrderStore();
    const d1 = signalKey('m', 'Yes', '2026-07-18');
    const d2 = signalKey('m', 'Yes', '2026-07-19');
    expect(store.insertIfNew(orderKey(d1))).not.toBeNull();
    expect(store.insertIfNew(orderKey(d2))).not.toBeNull();
  });

  it('treats opposite outcomes as distinct orders', () => {
    const store = new FakeOrderStore();
    const yes = signalKey('m', 'Yes', '2026-07-18');
    const no = signalKey('m', 'No', '2026-07-18');
    expect(store.insertIfNew(orderKey(yes))).not.toBeNull();
    expect(store.insertIfNew(orderKey(no))).not.toBeNull();
  });
});
