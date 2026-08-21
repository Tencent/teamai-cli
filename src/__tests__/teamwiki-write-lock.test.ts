import { describe, it, expect } from 'vitest';

import { acquireTeamwikiWriteLock } from '../import-repo.js';

/**
 * The write-phase mutex serialises concurrent importFromRepo calls' team-repo
 * writes (batch --from-repo-list / --from-org run importFromRepo in parallel).
 * These tests assert its mutual-exclusion contract without touching git or fs.
 */
describe('acquireTeamwikiWriteLock (write-phase mutex)', () => {
  it('serialises concurrent critical sections (never overlaps)', async () => {
    let active = 0;
    let maxActive = 0;
    const order: number[] = [];

    async function worker(id: number): Promise<void> {
      const release = await acquireTeamwikiWriteLock();
      try {
        active++;
        maxActive = Math.max(maxActive, active);
        order.push(id);
        // Yield to the event loop; if the lock were broken, another worker
        // would enter here and push active to 2.
        await new Promise((r) => setImmediate(r));
        await new Promise((r) => setImmediate(r));
        active--;
      } finally {
        release();
      }
    }

    // Launch 8 workers concurrently.
    await Promise.all(Array.from({ length: 8 }, (_, i) => worker(i)));

    expect(maxActive).toBe(1); // never two critical sections at once
    expect(order).toHaveLength(8); // all ran
    expect(new Set(order).size).toBe(8); // each exactly once
  });

  it('grants the lock again after release (no deadlock across sequential acquires)', async () => {
    const release1 = await acquireTeamwikiWriteLock();
    release1();
    // Second acquire must resolve promptly now that the first was released.
    const release2 = await acquireTeamwikiWriteLock();
    expect(typeof release2).toBe('function');
    release2();
  });

  it('preserves FIFO order of waiters', async () => {
    const first = await acquireTeamwikiWriteLock();
    const seen: number[] = [];
    const w1 = acquireTeamwikiWriteLock().then((rel) => {
      seen.push(1);
      rel();
    });
    const w2 = acquireTeamwikiWriteLock().then((rel) => {
      seen.push(2);
      rel();
    });
    // Neither waiter can proceed while `first` holds the lock.
    await new Promise((r) => setImmediate(r));
    expect(seen).toEqual([]);
    first();
    await Promise.all([w1, w2]);
    expect(seen).toEqual([1, 2]);
  });
});
