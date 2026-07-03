// -*- coding: utf-8 -*-
import path from 'node:path';

import matter from 'gray-matter';

import { readFileSafe, writeFile, listFiles } from '../utils/fs.js';
import { log } from '../utils/logger.js';

export interface ConfidenceFactors {
  recalledCount: number;
  upvotedCount: number;
  lastRecalledAt: string;
  lastUpvotedAt?: string;
}

/**
 * Compute a confidence score (0.0–1.0) for a knowledge document.
 *
 * Formula:
 *   base = min(1.0, recalled * 0.1 + upvoted * 0.3)
 *   recency = max(0, 1.0 - daysSinceLastRecall / 180)
 *   ratio = upvoted / max(1, recalled)
 *   confidence = base * 0.4 + recency * 0.3 + ratio * 0.3
 */
export function computeConfidence(factors: ConfidenceFactors): number {
  const { recalledCount, upvotedCount, lastRecalledAt } = factors;

  const base = Math.min(1.0, recalledCount * 0.1 + upvotedCount * 0.3);

  let daysSinceRecall = 180;
  if (lastRecalledAt) {
    const elapsed = Date.now() - new Date(lastRecalledAt).getTime();
    daysSinceRecall = Math.max(0, elapsed / (1000 * 60 * 60 * 24));
  }
  const recency = Math.max(0, 1.0 - daysSinceRecall / 180);

  const ratio = upvotedCount / Math.max(1, recalledCount);

  const score = base * 0.4 + recency * 0.3 + ratio * 0.3;
  return Math.round(score * 100) / 100;
}

/**
 * Aggregate all vote files and compute per-doc confidence.
 */
export async function computeAllConfidence(votesDir: string): Promise<Map<string, number>> {
  const result = new Map<string, number>();
  const { loadUserVotes } = await import('../votes.js');
  const files = await listFiles(votesDir);

  const aggregated = new Map<string, { recalled: number; upvoted: number; lastRecalled: string; lastUpvoted?: string }>();

  for (const file of files) {
    if (!file.endsWith('.yaml') && !file.endsWith('.yml')) continue;
    try {
      const data = await loadUserVotes(path.join(votesDir, file));
      for (const [docId, entry] of Object.entries(data.votes)) {
        const existing = aggregated.get(docId) ?? { recalled: 0, upvoted: 0, lastRecalled: '' };
        existing.recalled += entry.recalled_count ?? 0;
        existing.upvoted += entry.upvoted_count ?? 0;
        if (entry.last_recalled_at > existing.lastRecalled) {
          existing.lastRecalled = entry.last_recalled_at;
        }
        if (entry.last_upvoted_at && (!existing.lastUpvoted || entry.last_upvoted_at > existing.lastUpvoted)) {
          existing.lastUpvoted = entry.last_upvoted_at;
        }
        aggregated.set(docId, existing);
      }
    } catch {
      log.debug(`confidence: failed to parse votes file: ${file}`);
    }
  }

  for (const [docId, data] of aggregated) {
    const factors: ConfidenceFactors = {
      recalledCount: data.recalled,
      upvotedCount: data.upvoted,
      lastRecalledAt: data.lastRecalled,
      lastUpvotedAt: data.lastUpvoted,
    };
    result.set(docId, computeConfidence(factors));
  }

  return result;
}

/**
 * Write confidence scores back into learning document frontmatter.
 * Only updates docs whose confidence changed by > 0.05.
 * Returns count of files updated.
 */
export async function writeBackConfidence(
  learningsDir: string,
  confidenceMap: Map<string, number>,
): Promise<number> {
  let updated = 0;
  const files = await listFiles(learningsDir);

  for (const file of files) {
    if (!file.endsWith('.md')) continue;
    const docId = file.replace(/\.md$/i, '');
    const newConf = confidenceMap.get(docId);
    if (newConf === undefined) continue;

    const absPath = path.join(learningsDir, file);
    const content = await readFileSafe(absPath);
    if (!content) continue;

    try {
      const { data, content: body } = matter(content);
      const existingConf = typeof data.confidence === 'number' ? data.confidence : undefined;

      if (existingConf !== undefined && Math.abs(existingConf - newConf) <= 0.05) continue;

      data.confidence = newConf;
      const newContent = matter.stringify(body, data);
      await writeFile(absPath, newContent);
      updated++;
    } catch {
      log.debug(`confidence: failed to update frontmatter for: ${file}`);
    }
  }

  if (updated > 0) {
    log.info(`Updated confidence scores for ${updated} learning(s)`);
  }
  return updated;
}
