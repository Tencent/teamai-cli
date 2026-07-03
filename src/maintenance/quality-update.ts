// -*- coding: utf-8 -*-
import path from 'node:path';

import { listFiles, pathExists, readFileSafe } from '../utils/fs.js';
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

/**
 * Find learnings that users actually adopted (high upvoted_count) during the
 * same period a stale entry was being ignored. These serve as context for the
 * AI to understand what the team actually preferred.
 */
export async function findRelatedAdoptedLearnings(
  staleEntry: StaleEntry,
  votesDir: string,
  learningsDir: string,
  limit: number = 5,
): Promise<string[]> {
  const perDoc = new Map<string, number>();
  const voteFiles = await listFiles(votesDir);

  for (const file of voteFiles) {
    if (!file.endsWith('.yaml') && !file.endsWith('.yml')) continue;
    try {
      const data = await loadUserVotes(path.join(votesDir, file));
      for (const [docId, entry] of Object.entries(data.votes)) {
        if (docId === staleEntry.docId) continue;
        if ((entry.upvoted_count ?? 0) > 0) {
          perDoc.set(docId, (perDoc.get(docId) ?? 0) + (entry.upvoted_count ?? 0));
        }
      }
    } catch {
      continue;
    }
  }

  const sorted = [...perDoc.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit);

  const contents: string[] = [];
  for (const [docId] of sorted) {
    const filename = docId.endsWith('.md') ? docId : `${docId}.md`;
    const filePath = path.join(learningsDir, filename);
    const content = await readFileSafe(filePath);
    if (content) contents.push(content);
  }

  return contents;
}

/**
 * Generate an AI-powered update draft for a stale entry, incorporating
 * insights from learnings that users actually adopted.
 */
export async function generateUpdateDraft(
  staleEntry: StaleEntry,
  relatedLearnings: string[],
): Promise<string | null> {
  const currentContent = await readFileSafe(staleEntry.path);
  if (!currentContent) return null;

  const { callClaude } = await import('../utils/ai-client.js');

  const learningContext = relatedLearnings.length > 0
    ? `\n\nThe following learnings were actually adopted by team members (these represent what the team found more useful):\n\n${relatedLearnings.map((l, i) => `--- Learning ${i + 1} ---\n${l}`).join('\n\n')}`
    : '';

  const prompt = `You are a technical writer updating a team knowledge base entry.

The following ${staleEntry.type} entry has been recalled ${staleEntry.recalledCount} times by ${staleEntry.userCount} team members but was adopted only ${staleEntry.upvotedCount} time(s). This indicates the content is relevant to common queries but not actionable enough to be directly useful.

Current content:
---
${currentContent}
---
${learningContext}

Please rewrite this entry to be more actionable and directly useful. Keep the same topic but:
1. Add concrete examples or commands where applicable
2. Remove outdated or vague information
3. Incorporate relevant insights from the adopted learnings above
4. Keep the same YAML frontmatter format (update the date field to today)
5. Be concise — aim for the same or shorter length

Output ONLY the updated markdown file content (including frontmatter).`;

  try {
    const draft = await callClaude(prompt);
    return draft.trim();
  } catch (e) {
    log.error(`AI update generation failed: ${(e as Error).message}`);
    return null;
  }
}
