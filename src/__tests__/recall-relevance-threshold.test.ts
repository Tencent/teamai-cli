import { describe, it, expect } from 'vitest';
import { isRelevantScore, computeIdfBaseline } from '../recall.js';
import type { SearchIndex } from '../types.js';

// ─── Helpers ──────────────────────────────────────────────

function makeIndex(entryCount: number, withDf: boolean): SearchIndex {
  const entries = Array.from({ length: entryCount }, (_, i) => ({
    filename: `doc-${i}.md`,
    title: `Doc ${i}`,
    author: 'test',
    date: '2026-01-01',
    tags: [],
    tokens: ['token'],
    votes: 0,
    type: 'learnings' as const,
  }));
  return {
    builtAt: '2026-01-01T00:00:00Z',
    elapsedMs: 0,
    entries,
    df: withDf ? { token: entryCount } : undefined,
  };
}

// ─── computeIdfBaseline ───────────────────────────────────

describe('computeIdfBaseline', () => {
  it('returns 1 for a legacy index with no df field', () => {
    const idx = makeIndex(25, false);
    expect(computeIdfBaseline([idx])).toBe(1);
  });

  it('returns 1 when entries array is empty (no entries to compute baseline from)', () => {
    const idx: SearchIndex = {
      builtAt: '2026-01-01T00:00:00Z',
      elapsedMs: 0,
      entries: [],
      df: {},
    };
    expect(computeIdfBaseline([idx])).toBe(1);
  });

  it('returns log((N+1)/2)+1 for N=25 with df present', () => {
    const idx = makeIndex(25, true);
    expect(computeIdfBaseline([idx])).toBeCloseTo(Math.log(13) + 1, 5);
  });

  it('uses the index with the most entries when multiple indexes are given', () => {
    const small = makeIndex(5, true);
    const large = makeIndex(25, true);
    // should pick large (N=25), not small (N=5)
    const expected = Math.log((25 + 1) / 2) + 1;
    expect(computeIdfBaseline([small, large])).toBeCloseTo(expected, 5);
    expect(computeIdfBaseline([large, small])).toBeCloseTo(expected, 5);
  });

  it('ignores legacy (no-df) indexes when picking maxEntries', () => {
    // Legacy index is larger than the df-bearing one — its N must NOT be used.
    // Without the P2-6 fix, the legacy index's entry count would inflate the
    // baseline and silently raise the threshold against unrelated results.
    const legacy = makeIndex(100, false); // large but no df
    const modern = makeIndex(10, true);   // small but has df
    const expected = Math.log((10 + 1) / 2) + 1;
    expect(computeIdfBaseline([legacy, modern])).toBeCloseTo(expected, 5);
  });
});

// ─── isRelevantScore ─────────────────────────────────────

describe('isRelevantScore', () => {
  describe('codebase hits (bounded [0,10] scale)', () => {
    it('returns true when score is exactly at CODEBASE_RELEVANCE_THRESHOLD (4.0)', () => {
      expect(isRelevantScore(4.0, true, 1)).toBe(true);
    });

    it('returns false when score is just below threshold (3.9)', () => {
      expect(isRelevantScore(3.9, true, 1)).toBe(false);
    });

    it('is not affected by idfBaseline — a large baseline does not change the verdict', () => {
      // even with a baseline of 100 the codebase branch still uses the fixed threshold
      expect(isRelevantScore(4.0, true, 100)).toBe(true);
      expect(isRelevantScore(3.9, true, 100)).toBe(false);
    });
  });

  describe('learnings hits (TF-IDF unbounded, floor + ratio)', () => {
    // The effective threshold is max(baseline * 1.35, 4.0).
    //
    // Cross-over baseline: 4.0 / 1.35 ≈ 2.963 (corresponds to N ≈ 6–7).
    //   - baseline < 2.963 → floor (4.0) wins
    //   - baseline > 2.963 → relative threshold (baseline * 1.35) wins

    // --- Relative threshold governs (N=25, baseline > cross-over) ---
    // baseline for N=25: log(26/2)+1 ≈ 3.5649; threshold = 3.5649 * 1.35 ≈ 4.813
    // floor (4.0) is below the relative threshold, so relative wins.
    const baseline25 = computeIdfBaseline([makeIndex(25, true)]);

    it('N=25: relative threshold governs — score just above baseline*1.35 passes', () => {
      // Verify relative threshold is above the floor at this corpus size.
      expect(baseline25 * 1.35).toBeGreaterThan(4.0);
      expect(isRelevantScore(4.82, false, baseline25)).toBe(true);
    });

    it('N=25: relative threshold governs — score just below baseline*1.35 fails', () => {
      expect(isRelevantScore(4.80, false, baseline25)).toBe(false);
    });

    // --- Floor governs (idfBaseline = 1, cold-start / legacy fallback) ---
    // threshold = max(1 * 1.35, 4.0) = 4.0
    // Before the floor was added, threshold was 1.35 — a single tag match
    // (~1.7) would have passed on a 1-entry corpus, causing false positives.

    it('cold-start (baseline=1): floor governs — 4.0 passes', () => {
      // floor: 4.0; relative: 1.35 → floor wins
      expect(isRelevantScore(4.0, false, 1)).toBe(true);
    });

    it('cold-start (baseline=1): floor governs — 3.9 fails', () => {
      expect(isRelevantScore(3.9, false, 1)).toBe(false);
    });

    it('cold-start (baseline=1): old passing score (1.35) now correctly fails', () => {
      // Before the floor, isRelevantScore(1.35, false, 1) returned true.
      // With the floor at 4.0, it must return false to prevent cold-start false positives.
      expect(isRelevantScore(1.35, false, 1)).toBe(false);
    });

    // --- Cross-over boundary (baseline ≈ 2.963) ---
    // At baseline exactly equal to 4.0/1.35, both sides tie at 4.0.
    // Below this baseline the floor wins; above it the ratio wins.
    it('below cross-over (baseline=2.0): floor governs — threshold is 4.0', () => {
      // relative = 2.0 * 1.35 = 2.70 < 4.0 → floor wins
      expect(isRelevantScore(3.99, false, 2.0)).toBe(false);
      expect(isRelevantScore(4.0, false, 2.0)).toBe(true);
    });

    it('above cross-over (baseline=3.5): relative threshold governs', () => {
      // relative = 3.5 * 1.35 ≈ 4.725 > 4.0 → relative wins
      // Using computed threshold to avoid floating-point boundary issues.
      const relThreshold = 3.5 * 1.35; // ≈ 4.725
      expect(isRelevantScore(relThreshold - 0.001, false, 3.5)).toBe(false);
      expect(isRelevantScore(relThreshold + 0.001, false, 3.5)).toBe(true);
    });
  });

  describe('defensive: idfBaseline = 0', () => {
    it('treats idfBaseline=0 as 1 — floor (4.0) governs', () => {
      // baseline 0 is normalised to 1; threshold = max(1.35, 4.0) = 4.0
      expect(isRelevantScore(3.99, false, 0)).toBe(false);
      expect(isRelevantScore(4.0, false, 0)).toBe(true);
    });
  });
});
