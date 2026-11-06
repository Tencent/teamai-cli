import { describe, expect, it } from 'vitest';

import { computeConfidence } from '../maintenance/confidence.js';
import { annotateHotness, COLD_PENALTY, HOT_THRESHOLD, hotnessFor } from '../maintenance/hot-cold.js';
import type { SearchIndexEntry } from '../types.js';

function entry(filename: string): SearchIndexEntry {
  return { filename } as SearchIndexEntry;
}

describe('hotnessFor (#1757)', () => {
  it('never gives more evidence a lower weight than less evidence', () => {
    let previous = hotnessFor(0);

    for (let confidence = 0; confidence <= 1; confidence += 0.01) {
      const weight = hotnessFor(Math.round(confidence * 100) / 100);

      expect(weight).toBeGreaterThanOrEqual(previous);
      previous = weight;
    }
  });

  it('treats no vote data as zero evidence, not as the best possible state', () => {
    expect(hotnessFor(undefined)).toBe(hotnessFor(0));
    expect(hotnessFor(undefined)).toBe(COLD_PENALTY);
    expect(hotnessFor(Number.NaN)).toBe(COLD_PENALTY);
  });

  it('keeps hot documents at full weight', () => {
    expect(hotnessFor(HOT_THRESHOLD)).toBe(1);
    expect(hotnessFor(0.76)).toBe(1);
    expect(hotnessFor(1)).toBe(1);
  });

  it('ranks a document recalled a few times above one nobody has surfaced', () => {
    const now = new Date().toISOString();
    const recalledFourTimes = computeConfidence({ recalledCount: 4, upvotedCount: 0, lastRecalledAt: now });
    const recalledFiveTimes = computeConfidence({ recalledCount: 5, upvotedCount: 0, lastRecalledAt: now });

    expect(recalledFourTimes).toBe(0.46);
    expect(recalledFiveTimes).toBe(0.5);

    const fourRecalls = hotnessFor(recalledFourTimes);

    expect(fourRecalls).toBeGreaterThan(hotnessFor(undefined));
    expect(fourRecalls).toBeLessThan(1);
    // One more recall is no longer a 3.3x cliff.
    expect(hotnessFor(recalledFiveTimes) / fourRecalls).toBeLessThan(1.1);
  });
});

describe('annotateHotness (#1757)', () => {
  it('weights entries by their confidence and gives unvoted entries the zero-evidence weight', () => {
    const entries = [entry('unvoted.md'), entry('cold.md'), entry('hot.md')];

    annotateHotness(entries, new Map([['cold.md'.replace(/\.md$/, ''), 0.46], ['hot', 0.7]]));

    const [unvoted, cold, hot] = entries;

    expect(unvoted.confidence).toBeUndefined();
    expect(unvoted.hotness).toBe(COLD_PENALTY);
    expect(cold.confidence).toBe(0.46);
    expect(cold.hotness).toBeGreaterThan(COLD_PENALTY);
    expect(cold.hotness).toBeLessThan(1);
    expect(hot.hotness).toBe(1);
  });
});
