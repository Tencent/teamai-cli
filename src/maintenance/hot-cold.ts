// -*- coding: utf-8 -*-
import type { SearchIndexEntry } from '../types.js';

export const HOT_THRESHOLD = 0.5;
export const COLD_PENALTY = 0.3;

/**
 * The search weight a confidence score earns (#1757).
 *
 * A ramp, not a step: the weight rises from COLD_PENALTY at zero evidence to 1.0 at HOT_THRESHOLD and stays
 * there, so more evidence never ranks a document lower than less. An entry with no vote data has zero evidence
 * and gets the same weight as a confidence of 0; the old 1.0 made "never surfaced" outrank "surfaced a few
 * times without an upvote" by 1 / COLD_PENALTY.
 */
export function hotnessFor(confidence: number | undefined): number {
  const evidence = confidence !== undefined && Number.isFinite(confidence) ? Math.max(0, confidence) : 0;
  const ramp = Math.min(1, evidence / HOT_THRESHOLD);

  return COLD_PENALTY + (1 - COLD_PENALTY) * ramp;
}

/**
 * Annotate search index entries with hotness based on confidence scores.
 * Entries at or above HOT_THRESHOLD are "hot" (weight 1.0); below it the weight ramps down to COLD_PENALTY.
 */
export function annotateHotness(
  entries: SearchIndexEntry[],
  confidenceMap: Map<string, number>,
): void {
  for (const entry of entries) {
    const docId = entry.filename.replace(/\.md$/i, '');
    const confidence = confidenceMap.get(docId);
    entry.confidence = confidence;
    entry.hotness = hotnessFor(confidence);
  }
}
