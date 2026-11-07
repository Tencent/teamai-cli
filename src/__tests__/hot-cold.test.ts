import { describe, expect, it } from 'vitest';

import { computeConfidence } from '../maintenance/confidence.js';
import { annotateHotness, HOT_THRESHOLD, hotnessFor, ZERO_EVIDENCE_WEIGHT } from '../maintenance/hot-cold.js';
import { LEARNINGS_ABSOLUTE_FLOOR } from '../recall.js';
import { search, tokenize } from '../utils/search-index.js';
import type { SearchIndex, SearchIndexEntry } from '../types.js';

function entry(filename: string, title: string): SearchIndexEntry {
  return {
    filename,
    title,
    author: 'tester',
    date: '2026-10-21',
    tags: [],
    votes: 0,
    type: 'learnings',
    domain: 'technical',
    path: `/kb/learnings/${filename}`,
    tokens: [...new Set(tokenize(title).flatMap((t) => [`title:${t}`, t]))],
  };
}

function index(entries: SearchIndexEntry[]): SearchIndex {
  const dfByDomain: Record<string, Record<string, number>> = {};
  for (const e of entries) {
    const domain = e.domain ?? 'neutral';
    dfByDomain[domain] ??= {};
    for (const t of new Set(e.tokens)) dfByDomain[domain][t] = (dfByDomain[domain][t] ?? 0) + 1;
  }
  return { version: 7, builtAt: '2026-10-21T00:00:00Z', elapsedMs: 0, entries, dfByDomain };
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
    expect(hotnessFor(undefined)).toBe(ZERO_EVIDENCE_WEIGHT);
    expect(hotnessFor(Number.NaN)).toBe(ZERO_EVIDENCE_WEIGHT);
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
    const entries = [entry('unvoted.md', 'Unvoted'), entry('cold.md', 'Cold'), entry('hot.md', 'Hot')];

    annotateHotness(entries, new Map([['cold', 0.46], ['hot', 0.7]]));

    const [unvoted, cold, hot] = entries;

    expect(unvoted.confidence).toBeUndefined();
    expect(unvoted.hotness).toBe(ZERO_EVIDENCE_WEIGHT);
    expect(cold.confidence).toBe(0.46);
    expect(cold.hotness).toBeGreaterThan(ZERO_EVIDENCE_WEIGHT);
    expect(cold.hotness).toBeLessThan(1);
    expect(hot.hotness).toBe(1);
  });

  it('lets a document with no vote record win its own title against a hot document matching one term', () => {
    const now = new Date().toISOString();
    const entries = [
      entry('receipts.md', 'Ledger receipts'),
      entry('invoice-archive.md', 'Ledger invoice archive'),
      entry('refunds.md', 'Ledger refunds'),
      entry('postings.md', 'Ledger postings'),
    ];

    annotateHotness(entries, new Map([
      ['refunds', computeConfidence({ recalledCount: 4, upvotedCount: 0, lastRecalledAt: now })],
      ['postings', computeConfidence({ recalledCount: 10, upvotedCount: 3, lastRecalledAt: now, lastUpvotedAt: now })],
    ]));

    const idx = index(entries);
    const byTitle = search('Ledger receipts', idx, 5);

    expect(byTitle[0].entry.filename).toBe('receipts.md');
    expect(byTitle[0].score).toBeGreaterThanOrEqual(LEARNINGS_ABSOLUTE_FLOOR);

    // Only documents without a vote record match this query; it must still clear the relevance floor.
    const [onlyUnvoted] = search('invoice archive', idx, 5);

    expect(onlyUnvoted.entry.filename).toBe('invoice-archive.md');
    expect(onlyUnvoted.score).toBeGreaterThanOrEqual(LEARNINGS_ABSOLUTE_FLOOR);
  });
});
