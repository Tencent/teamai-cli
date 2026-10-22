// -*- coding: utf-8 -*-
import { describe, it, expect } from 'vitest';

import { computeConfidence } from '../maintenance/confidence.js';

describe('computeConfidence', () => {
  it('returns 0 for brand new doc with no activity', () => {
    const score = computeConfidence({
      recalledCount: 0,
      upvotedCount: 0,
      lastRecalledAt: '',
    });
    expect(score).toBe(0);
  });

  it('returns moderate score for recently recalled doc', () => {
    const now = new Date().toISOString();
    const score = computeConfidence({
      recalledCount: 5,
      upvotedCount: 2,
      lastRecalledAt: now,
    });
    // base = min(1, 5*0.1 + 2*0.3) = min(1, 1.1) = 1.0
    // recency ≈ 1.0 (just now)
    // ratio = 2/5 = 0.4
    // confidence = 1.0*0.4 + 1.0*0.3 + 0.4*0.3 = 0.4 + 0.3 + 0.12 = 0.82
    expect(score).toBeGreaterThanOrEqual(0.8);
    expect(score).toBeLessThanOrEqual(0.85);
  });

  it('returns low score for old doc never upvoted', () => {
    const oldDate = new Date(Date.now() - 200 * 24 * 60 * 60 * 1000).toISOString();
    const score = computeConfidence({
      recalledCount: 1,
      upvotedCount: 0,
      lastRecalledAt: oldDate,
    });
    // base = min(1, 1*0.1) = 0.1
    // recency = max(0, 1 - 200/180) = 0
    // ratio = 0/1 = 0
    // confidence = 0.1*0.4 + 0*0.3 + 0*0.3 = 0.04
    expect(score).toBeLessThan(0.1);
  });

  it('caps at reasonable maximum for heavily used docs', () => {
    const now = new Date().toISOString();
    const score = computeConfidence({
      recalledCount: 100,
      upvotedCount: 50,
      lastRecalledAt: now,
    });
    // base = 1.0 (capped)
    // recency = 1.0
    // ratio = 50/100 = 0.5
    // confidence = 1.0*0.4 + 1.0*0.3 + 0.5*0.3 = 0.85
    expect(score).toBeGreaterThanOrEqual(0.8);
    expect(score).toBeLessThanOrEqual(1.0);
  });

  it('returns value between 0 and 1', () => {
    const cases = [
      { recalledCount: 0, upvotedCount: 0, lastRecalledAt: '' },
      { recalledCount: 1, upvotedCount: 0, lastRecalledAt: new Date().toISOString() },
      { recalledCount: 10, upvotedCount: 10, lastRecalledAt: new Date().toISOString() },
      { recalledCount: 3, upvotedCount: 1, lastRecalledAt: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString() },
    ];
    for (const factors of cases) {
      const score = computeConfidence(factors);
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(1);
    }
  });

  it('caps the ratio when manual feedback exceeds recall count', () => {
    const score = computeConfidence({
      recalledCount: 1,
      upvotedCount: 5,
      lastRecalledAt: new Date().toISOString(),
    });

    expect(score).toBe(1);
  });

  it('keeps feedback without any recalls within the base and ratio weights', () => {
    const score = computeConfidence({
      recalledCount: 0,
      upvotedCount: 5,
      lastRecalledAt: '',
    });

    expect(score).toBe(0.7);
  });

  it('does not let excess feedback replace the expired recency weight', () => {
    const score = computeConfidence({
      recalledCount: 1,
      upvotedCount: 5,
      lastRecalledAt: new Date(Date.now() - 200 * 24 * 60 * 60 * 1000).toISOString(),
    });

    expect(score).toBe(0.7);
  });

  // #1278: a recent upvote with no recall must not be treated as 180 days stale.
  it('uses lastUpvotedAt for recency when there is no recall (#1278)', () => {
    const now = new Date().toISOString();
    const score = computeConfidence({
      recalledCount: 0,
      upvotedCount: 1,
      lastRecalledAt: '',
      lastUpvotedAt: now,
    });
    // base = 0.3, recency = 1.0, ratio = 1.0
    // confidence = 0.3*0.4 + 1.0*0.3 + 1.0*0.3 = 0.72
    expect(score).toBe(0.72);
  });

  it('takes recency from the later of recall and upvote timestamps (#1278)', () => {
    const oldRecall = new Date(Date.now() - 200 * 24 * 60 * 60 * 1000).toISOString();
    const recentUpvote = new Date().toISOString();
    const score = computeConfidence({
      recalledCount: 1,
      upvotedCount: 1,
      lastRecalledAt: oldRecall,
      lastUpvotedAt: recentUpvote,
    });
    // base = 0.4, recency ≈ 1.0 (from upvote), ratio = 1.0
    // confidence = 0.4*0.4 + 1.0*0.3 + 1.0*0.3 = 0.76
    expect(score).toBe(0.76);
  });
});
