// -*- coding: utf-8 -*-
import path from 'node:path';

import matter from 'gray-matter';
import { z } from 'zod';

import { ensureDir, readFileSafe, writeFile, listFiles } from '../utils/fs.js';
import { isInWriteRoot, listLearningFiles } from '../utils/learnings-roots.js';
import { log } from '../utils/logger.js';
import type { VoteEntryV2 } from '../types.js';

/** A frontmatter confidence that counts only when it is a finite number. */
const FrontmatterNumberSchema = z.number().optional().catch(undefined);

export interface ConfidenceFactors {
  recalledCount: number;
  /** Every upvote: tool credits, judge credits and manual feedback. */
  upvotedCount: number;
  lastRecalledAt: string;
  lastUpvotedAt?: string;
  /** The upvotes a judge gave from adoption labels (#1391). */
  judgeUpvotedCount?: number;
  /** Sessions in which a judge was asked whether the doc was adopted. */
  judgedCount?: number;
  /** Sessions that recalled the doc; absent for votes written before #1391, which count one per recall. */
  recalledSessionCount?: number;
}

/** A count as the estimator reads it: a finite number of at least 0. */
function count(value: number | undefined): number {
  return value !== undefined && Number.isFinite(value) ? Math.max(0, value) : 0;
}

/**
 * The share of the sessions that recalled a doc and adopted it (#1391). Tool credits (an upvote no judge gave) rate the
 * sessions that recalled it; a judge's verdicts rate the rest, as many as it was asked about:
 *
 *   tool  = upvoted − judge_upvoted
 *   r     = min(1, tool / max(1, recalled_sessions))
 *   ratio = r + (judged > 0 ? judge_upvoted / judged : 0) × (1 − r), within [0, 1]
 */
export function adoptionRatio(factors: ConfidenceFactors): number {
  const judge = count(factors.judgeUpvotedCount);
  const judged = count(factors.judgedCount);
  const sessions = count(factors.recalledSessionCount ?? factors.recalledCount);
  const tool = Math.max(0, count(factors.upvotedCount) - judge);
  const r = Math.min(1, tool / Math.max(1, sessions));
  const ratio = r + (judged > 0 ? Math.min(1, judge / judged) : 0) * (1 - r);

  return Math.min(1, Math.max(0, ratio));
}

/**
 * Compute a confidence score (0.0–1.0) for a knowledge document.
 *
 * Formula:
 *   base = min(1.0, recalled * 0.1 + upvoted * 0.3)
 *   recency = max(0, 1.0 - daysSinceLastActivity / 180)
 *     where last activity is the later of lastRecalledAt and lastUpvotedAt (#1278)
 *   ratio = adoptionRatio (#1391)
 *   confidence = base * 0.4 + recency * 0.3 + ratio * 0.3
 *
 * A count that is not a finite number reads as 0, so the score is always a number a threshold can compare (#1391).
 */
export function computeConfidence(factors: ConfidenceFactors): number {
  const { lastRecalledAt, lastUpvotedAt } = factors;
  const recalledCount = count(factors.recalledCount);
  const upvotedCount = count(factors.upvotedCount);

  const base = Math.min(1.0, recalledCount * 0.1 + upvotedCount * 0.3);

  // A vote with no recall still signals recent interest; use the later timestamp.
  const lastActivityAt =
    lastRecalledAt && lastUpvotedAt
      ? (lastRecalledAt > lastUpvotedAt ? lastRecalledAt : lastUpvotedAt)
      : (lastRecalledAt || lastUpvotedAt || '');

  let daysSinceActivity = 180;

  if (lastActivityAt) {
    const elapsed = Date.now() - new Date(lastActivityAt).getTime();

    if (Number.isFinite(elapsed)) daysSinceActivity = Math.max(0, elapsed / (1000 * 60 * 60 * 24));
  }

  const recency = Math.max(0, 1.0 - daysSinceActivity / 180);

  const ratio = adoptionRatio(factors);

  const score = base * 0.4 + recency * 0.3 + ratio * 0.3;

  return Math.round(score * 100) / 100;
}

/**
 * `factors` with one member's vote entry for the doc added: the sum `computeAllConfidence` and the search index both
 * rate. An entry with no session count (written before #1391) counts one session per recall.
 */
export function addVoteEntry(factors: ConfidenceFactors | undefined, entry: VoteEntryV2): ConfidenceFactors {
  const sum = factors ?? { recalledCount: 0, upvotedCount: 0, lastRecalledAt: '', judgeUpvotedCount: 0, judgedCount: 0, recalledSessionCount: 0 };
  const lastUpvotedAt = entry.last_upvoted_at && (!sum.lastUpvotedAt || entry.last_upvoted_at > sum.lastUpvotedAt) ? entry.last_upvoted_at : sum.lastUpvotedAt;

  const added: ConfidenceFactors = {
    recalledCount: sum.recalledCount + count(entry.recalled_count),
    upvotedCount: sum.upvotedCount + count(entry.upvoted_count),
    lastRecalledAt: entry.last_recalled_at > sum.lastRecalledAt ? entry.last_recalled_at : sum.lastRecalledAt,
    judgeUpvotedCount: count(sum.judgeUpvotedCount) + count(entry.judge_upvoted_count),
    judgedCount: count(sum.judgedCount) + count(entry.judged_count),
    recalledSessionCount: count(sum.recalledSessionCount) + count(entry.recalled_session_count ?? entry.recalled_count),
  };

  if (lastUpvotedAt) added.lastUpvotedAt = lastUpvotedAt;

  return added;
}

/** Each doc's factors, summed over every member's vote file in `votesDir`. */
export async function aggregateConfidenceFactors(votesDir: string): Promise<Map<string, ConfidenceFactors>> {
  const { readUserVotes } = await import('../votes.js');
  const files = await listFiles(votesDir);
  const aggregated = new Map<string, ConfidenceFactors>();

  for (const file of files) {
    if (!file.endsWith('.yaml') && !file.endsWith('.yml')) continue;

    try {
      const data = await readUserVotes(path.join(votesDir, file));

      for (const [docId, entry] of Object.entries(data.votes)) aggregated.set(docId, addVoteEntry(aggregated.get(docId), entry));
    } catch {
      log.debug(`confidence: failed to parse votes file: ${file}`);
    }
  }

  return aggregated;
}

/**
 * Aggregate all vote files and compute per-doc confidence.
 */
export async function computeAllConfidence(votesDir: string): Promise<Map<string, number>> {
  const result = new Map<string, number>();

  for (const [docId, factors] of await aggregateConfidenceFactors(votesDir)) result.set(docId, computeConfidence(factors));

  return result;
}

/**
 * Write confidence scores back into learning document frontmatter.
 * Only updates docs whose confidence changed by > 0.05.
 * Returns the files it wrote, which are what a publish may stage (#823).
 * Under `dryRun` it writes nothing and returns the files it would write (#900).
 */
export async function writeBackConfidence(
  learningsDirs: readonly string[],
  confidenceMap: Map<string, number>,
  writeRoot?: string,
  options: { dryRun?: boolean; namespaces?: readonly string[] } = {},
): Promise<string[]> {
  const written: string[] = [];
  const files = await listLearningFiles(learningsDirs, options.namespaces);

  for (const { file, absPath } of files) {
    const docId = file.replace(/\.md$/i, '');
    const newConf = confidenceMap.get(docId);

    if (newConf === undefined) continue;

    const content = await readFileSafe(absPath);

    if (!content) continue;

    try {
      const { data, content: body } = matter(content);
      const existingConf = FrontmatterNumberSchema.parse(data.confidence);

      if (existingConf !== undefined && Math.abs(existingConf - newConf) <= 0.05) continue;

      data.confidence = newConf;
      const newContent = matter.stringify(body, data);

      // An inherited learning lives in a root nothing pushes, so rewriting it
      // there would be discarded by the next realign and never reach the team.
      // The new version goes to the write root instead, where it takes
      // precedence over the copy it supersedes.
      const target = writeRoot && !isInWriteRoot(absPath, writeRoot)
        ? path.join(writeRoot, file)
        : absPath;

      if (!options.dryRun) {
        await ensureDir(path.dirname(target));
        await writeFile(target, newContent);
      }

      written.push(target);
    } catch {
      log.debug(`confidence: failed to update frontmatter for: ${file}`);
    }
  }

  if (written.length > 0) {
    log.info(`${options.dryRun ? '[dry-run] Would update' : 'Updated'} confidence scores for ${written.length} learning(s)`);
  }

  return written;
}
