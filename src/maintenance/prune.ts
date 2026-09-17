// -*- coding: utf-8 -*-
import path from 'node:path';

import matter from 'gray-matter';

import { readFileSafe, ensureDir, remove, copyFile } from '../utils/fs.js';
import { isInWriteRoot, listLearningFiles } from '../utils/learnings-roots.js';
import { log } from '../utils/logger.js';
import { computeAllConfidence } from './confidence.js';

export interface PruneCandidate {
  filename: string;
  path: string;
  confidence: number;
  lastActivity: string;
  reason: string;
}

export interface PruneOptions {
  threshold?: number;
  dryRun?: boolean;
  archive?: boolean;
}

const DEFAULT_THRESHOLD = 0.15;
const STALE_DAYS = 180;

/**
 * Identify learning documents below the confidence threshold
 * or inactive for more than STALE_DAYS.
 */
export async function findPruneCandidates(
  learningsDirs: readonly string[],
  votesDir: string,
  options: PruneOptions = {},
): Promise<PruneCandidate[]> {
  const threshold = options.threshold ?? DEFAULT_THRESHOLD;
  const confidenceMap = await computeAllConfidence(votesDir);
  const candidates: PruneCandidate[] = [];
  const files = await listLearningFiles(learningsDirs);
  const now = Date.now();

  for (const { file, absPath } of files) {
    const docId = file.replace(/\.md$/i, '');
    const content = await readFileSafe(absPath);
    if (!content) continue;

    let date = '';
    try {
      const { data } = matter(content);
      date = typeof data.date === 'string' ? data.date : '';
    } catch {
      continue;
    }

    const confidence = confidenceMap.get(docId);
    // Skip docs with no vote data — they haven't been recalled yet (new or just migrated)
    if (confidence === undefined) continue;
    const daysSinceCreate = date ? (now - new Date(date).getTime()) / (1000 * 60 * 60 * 24) : Infinity;

    if (confidence < threshold) {
      candidates.push({
        filename: file,
        path: absPath,
        confidence,
        lastActivity: date,
        reason: `confidence ${confidence.toFixed(2)} < ${threshold}`,
      });
    } else if (daysSinceCreate > STALE_DAYS && confidence < 0.3) {
      candidates.push({
        filename: file,
        path: absPath,
        confidence,
        lastActivity: date,
        reason: `inactive ${isFinite(daysSinceCreate) ? Math.round(daysSinceCreate) + 'd' : 'no-date'}, confidence ${confidence.toFixed(2)}`,
      });
    }
  }

  return candidates.sort((a, b) => a.confidence - b.confidence);
}

/**
 * Execute prune: archive or remove low-confidence documents.
 */
export async function executePrune(
  learningsWriteDir: string,
  candidates: PruneCandidate[],
  options: PruneOptions = {},
): Promise<{ archived: number; removed: number }> {
  let archived = 0;
  let removed = 0;

  if (options.dryRun) {
    log.info(`[dry-run] Would ${options.archive ? 'archive' : 'remove'} ${candidates.length} file(s)`);
    return { archived: 0, removed: 0 };
  }

  const inherited: string[] = [];

  for (const candidate of candidates) {
    // A learning outside the write root lives where nothing is pushed: deleting
    // it here would look like it worked, reach no teammate, and come back on the
    // next realign. Say so instead of pretending.
    if (!isInWriteRoot(candidate.path, learningsWriteDir)) {
      inherited.push(candidate.filename);
      continue;
    }
    if (options.archive) {
      const archiveDir = path.join(learningsWriteDir, '_archive');
      await ensureDir(archiveDir);
      await copyFile(candidate.path, path.join(archiveDir, candidate.filename));
      await remove(candidate.path);
      archived++;
    } else {
      await remove(candidate.path);
      removed++;
    }
  }

  if (archived > 0) log.success(`Archived ${archived} learning(s)`);
  if (removed > 0) log.success(`Removed ${removed} learning(s)`);
  if (inherited.length > 0) {
    log.warn(
      `${inherited.length} learning(s) are on the default branch and cannot be pruned from here: `
      + `${inherited.join(', ')}. Remove them with a pull request against the team repo.`,
    );
  }
  return { archived, removed };
}
