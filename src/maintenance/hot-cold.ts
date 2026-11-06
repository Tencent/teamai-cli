// -*- coding: utf-8 -*-
import type { SearchIndexEntry } from '../types.js';

export const HOT_THRESHOLD = 0.5;

/**
 * The search weight of a document with zero evidence, and the floor of the ramp below. Close to neutral on
 * purpose: in a team with any vote data every document without a record takes this weight, and a new learning
 * must still win a query for its own title against a hot document that matches one term, and clear the
 * relevance floor of `recall --check` when only unvoted documents match (#1757).
 */
export const ZERO_EVIDENCE_WEIGHT = 0.8;

/**
 * The search weight a confidence score earns (#1757).
 *
 * A ramp, not a step: the weight rises from ZERO_EVIDENCE_WEIGHT at zero evidence to 1.0 at HOT_THRESHOLD and
 * stays there, so more evidence never ranks a document lower than less. An entry with no vote data has zero
 * evidence and gets the same weight as a confidence of 0; the old 1.0 made "never surfaced" outrank
 * "surfaced a few times without an upvote" by 3.3x.
 */
export function hotnessFor(confidence: number | undefined): number {
  const evidence = confidence !== undefined && Number.isFinite(confidence) ? Math.max(0, confidence) : 0;
  const ramp = Math.min(1, evidence / HOT_THRESHOLD);

  return ZERO_EVIDENCE_WEIGHT + (1 - ZERO_EVIDENCE_WEIGHT) * ramp;
}

/**
 * Annotate search index entries with hotness based on confidence scores.
 * Entries at or above HOT_THRESHOLD are "hot" (weight 1.0); below it the weight ramps down to ZERO_EVIDENCE_WEIGHT.
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
