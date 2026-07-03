// -*- coding: utf-8 -*-
import type { SearchIndexEntry } from '../types.js';

export const HOT_THRESHOLD = 0.5;
export const COLD_PENALTY = 0.3;

/**
 * Annotate search index entries with hotness based on confidence scores.
 * Entries below HOT_THRESHOLD get a low hotness score; entries above are "hot".
 */
export function annotateHotness(
  entries: SearchIndexEntry[],
  confidenceMap: Map<string, number>,
): void {
  for (const entry of entries) {
    const docId = entry.filename.replace(/\.md$/i, '');
    const confidence = confidenceMap.get(docId);
    entry.confidence = confidence;
    // No data = new doc (neutral); low confidence = cold; high confidence = hot
    if (confidence === undefined) {
      entry.hotness = 1.0;
    } else {
      entry.hotness = confidence >= HOT_THRESHOLD ? 1.0 : COLD_PENALTY;
    }
  }
}

