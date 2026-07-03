// -*- coding: utf-8 -*-
import path from 'node:path';

import { listFiles, pathExists } from '../utils/fs.js';
import { loadUserVotes } from '../votes.js';
import { log } from '../utils/logger.js';

export interface StaleEntry {
  docId: string;
  path: string;
  recalledCount: number;
  upvotedCount: number;
  userCount: number;
  type: string;
}

export interface QualityUpdateOptions {
  minRecalled?: number;
  maxUpvoted?: number;
  minUsers?: number;
  dryRun?: boolean;
}

const DEFAULT_MIN_RECALLED = 5;
const DEFAULT_MAX_UPVOTED = 1;
const DEFAULT_MIN_USERS = 2;

/**
 * Find docs/rules/skills that are frequently recalled but rarely adopted.
 * These are candidates for quality improvement.
 */
export async function findStaleEntries(
  votesDir: string,
  knowledgeDirs: { docs?: string; rules?: string; skills?: string },
  options: QualityUpdateOptions = {},
): Promise<StaleEntry[]> {
  const minRecalled = options.minRecalled ?? DEFAULT_MIN_RECALLED;
  const maxUpvoted = options.maxUpvoted ?? DEFAULT_MAX_UPVOTED;
  const minUsers = options.minUsers ?? DEFAULT_MIN_USERS;

  const perDoc = new Map<string, { recalled: number; upvoted: number; users: Set<string> }>();

  const voteFiles = await listFiles(votesDir);
  for (const file of voteFiles) {
    if (!file.endsWith('.yaml') && !file.endsWith('.yml')) continue;
    const username = file.replace(/\.(yaml|yml)$/, '');
    const filePath = path.join(votesDir, file);

    try {
      const data = await loadUserVotes(filePath);
      for (const [docId, entry] of Object.entries(data.votes)) {
        const existing = perDoc.get(docId) ?? { recalled: 0, upvoted: 0, users: new Set<string>() };
        existing.recalled += entry.recalled_count ?? 0;
        existing.upvoted += entry.upvoted_count ?? 0;
        if ((entry.recalled_count ?? 0) > 0) existing.users.add(username);
        perDoc.set(docId, existing);
      }
    } catch {
      continue;
    }
  }

  const candidates: StaleEntry[] = [];

  for (const [docId, data] of perDoc) {
    if (data.recalled < minRecalled) continue;
    if (data.upvoted > maxUpvoted) continue;
    if (data.users.size < minUsers) continue;

    const entryPath = await resolveDocPath(docId, knowledgeDirs);
    if (!entryPath) continue;

    const type = entryPath.includes('/docs/') ? 'docs'
      : entryPath.includes('/rules/') ? 'rules'
        : entryPath.includes('/skills/') ? 'skills' : 'unknown';

    candidates.push({
      docId,
      path: entryPath,
      recalledCount: data.recalled,
      upvotedCount: data.upvoted,
      userCount: data.users.size,
      type,
    });
  }

  return candidates.sort((a, b) => b.recalledCount - a.recalledCount);
}

async function resolveDocPath(
  docId: string,
  dirs: { docs?: string; rules?: string; skills?: string },
): Promise<string | null> {
  const filename = docId.endsWith('.md') ? docId : `${docId}.md`;
  for (const dir of [dirs.docs, dirs.rules, dirs.skills]) {
    if (!dir) continue;
    const candidate = path.join(dir, filename);
    if (await pathExists(candidate)) return candidate;
  }
  return null;
}

/**
 * Log stale entry candidates for user review.
 */
export function reportStaleEntries(entries: StaleEntry[]): void {
  if (entries.length === 0) {
    log.info('No stale entries found that need quality updates.');
    return;
  }

  log.info(`Found ${entries.length} entry(ies) recalled often but rarely adopted:`);
  for (const entry of entries) {
    log.info(
      `  - [${entry.type}] ${entry.docId}: recalled ${entry.recalledCount}x by ${entry.userCount} users, adopted ${entry.upvotedCount}x`,
    );
  }
}
