// -*- coding: utf-8 -*-
import path from 'node:path';

import { z } from 'zod';

import { listDirs, listFiles, pathExists, readFileSafe } from '../utils/fs.js';
import { listLearningFiles } from '../utils/learnings-roots.js';
import { parseFrontmatter } from '../utils/frontmatter.js';
import { tokenize } from '../utils/tokenizer.js';
import { readUserVotes } from '../votes.js';
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
      const data = await readUserVotes(filePath);

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
  const unresolved: string[] = [];

  for (const [docId, data] of perDoc) {
    if (data.recalled < minRecalled) continue;

    if (data.upvoted > maxUpvoted) continue;

    if (data.users.size < minUsers) continue;

    const found = await resolveEntry(docId, knowledgeDirs);

    if (!found) {
      // The entry cleared every threshold, so it is exactly what this command is
      // looking for; dropping it silently is what hid #1735 for so long, where
      // every skill vote id resolved to nothing and the report simply never
      // listed one. Collected instead of logged one by one: a votes file also
      // holds learnings, which are not in `knowledgeDirs` by design, so on a
      // real team this list is mostly expected rather than alarming.
      unresolved.push(docId);
      continue;
    }

    candidates.push({
      docId,
      path: found.path,
      recalledCount: data.recalled,
      upvotedCount: data.upvoted,
      userCount: data.users.size,
      type: found.type,
    });
  }

  if (unresolved.length > 0) {
    const shown = unresolved.slice(0, 5).join(', ');
    const rest = unresolved.length > 5 ? ` and ${unresolved.length - 5} more` : '';

    log.warn(
      `${unresolved.length} entry(ies) reached the threshold but no file matched under docs/, rules/ or skills/: ${shown}${rest}`,
    );
    log.debug(`Unresolved vote ids: ${unresolved.join(', ')}`);
  }

  return candidates.sort((a, b) => b.recalledCount - a.recalledCount);
}

interface ResolvedEntry {
  path: string;
  type: 'docs' | 'rules' | 'skills';
}

/**
 * Where a vote id lives on disk.
 *
 * The type comes from the directory that matched rather than from a substring of
 * the path: the old `includes('/docs/')` test was false for every entry on
 * Windows, where `path.join` yields backslashes, so every entry there was typed
 * `unknown`.
 */
async function resolveEntry(
  docId: string,
  dirs: { docs?: string; rules?: string; skills?: string },
): Promise<ResolvedEntry | null> {
  const filename = docId.endsWith('.md') ? docId : `${docId}.md`;

  for (const [type, dir] of [['docs', dirs.docs], ['rules', dirs.rules]] as const) {
    if (!dir) continue;
    const candidate = path.join(dir, filename);

    if (await pathExists(candidate)) return { path: candidate, type };
  }

  if (!dirs.skills) return null;

  const skillPath = await findSkillFile(dirs.skills, docId.replace(/\.md$/i, ''));

  return skillPath ? { path: skillPath, type: 'skills' } : null;
}

/** A skill name is one path segment: a vote id is never a path. */
function isSingleSegment(value: string): boolean {
  return value.length > 0
    && value !== '.'
    && value !== '..'
    && !value.includes('/')
    && !value.includes('\\')
    && !value.includes('\0');
}

/**
 * The `SKILL.md` a skill vote id names, or null.
 *
 * A skill is a directory holding `SKILL.md`, not a markdown file: the search
 * index records its vote id as the bare skill name (`collectSkillEntries`), so
 * joining that name onto `skills/` as `<name>.md` never matches anything and
 * every skill was silently skipped (#1735). Both layouts have to be tried —
 * `skills/<name>/SKILL.md` and `skills/<namespace>/<name>/SKILL.md` — because a
 * team repo adds the namespace level while a personal one does not.
 */
async function findSkillFile(skillsDir: string, skillName: string): Promise<string | null> {
  if (!isSingleSegment(skillName)) return null;

  const skillMdIn = async (dir: string): Promise<string | null> => {
    const candidate = path.join(dir, 'SKILL.md');

    return await pathExists(candidate) ? candidate : null;
  };

  const flat = await skillMdIn(path.join(skillsDir, skillName));

  if (flat) return flat;

  // `listDirs` reads only names directly under `skills/`, so a namespaced
  // layout costs one directory listing and one `pathExists` per namespace.
  for (const ns of await listDirs(skillsDir)) {
    if (!isSingleSegment(ns)) continue;

    const namespaced = await skillMdIn(path.join(skillsDir, ns, skillName));

    if (namespaced) return namespaced;
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
export interface RelatedAdoptedLearningsOptions {
  limit?: number;
  namespaces?: readonly string[];
}

export async function findRelatedAdoptedLearnings(
  staleEntry: StaleEntry,
  votesDir: string,
  learningsDirs: readonly string[],
  options?: RelatedAdoptedLearningsOptions,
): Promise<string[]> {
  const limit = options?.limit ?? 5;
  const namespaces = options?.namespaces;
  const perDoc = new Map<string, number>();
  const voteFiles = await listFiles(votesDir);

  for (const file of voteFiles) {
    if (!file.endsWith('.yaml') && !file.endsWith('.yml')) continue;

    try {
      const data = await readUserVotes(path.join(votesDir, file));

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

  const byName = new Map(
    (await listLearningFiles(learningsDirs, namespaces))
      .map((learning) => [toPosix(learning.file), learning.absPath] as const),
  );

  // Filtered before the limit is applied. Slicing first spent every slot on the
  // team's most-opened entries whatever they were, so five popular docs left
  // nothing for a learning that belonged in the draft (#1735).
  const candidates = [...perDoc.entries()].flatMap(([docId, upvotes]) => {
    const file = learningFileFor(docId, byName);

    return file === null ? [] : [{ docId, upvotes, file }];
  });

  if (candidates.length === 0) return [];

  // Ranked by what the entry is about, not by popularity: the prompt asks the
  // model to incorporate these, so an unrelated learning is worse than none.
  const entryTokens = await entryTopicTokens(staleEntry);

  const ranked = candidates.flatMap((candidate) => {
    const relevance = overlapCount(entryTokens, nameTokensOf(candidate.docId));

    return relevance > 0 ? [{ ...candidate, relevance }] : [];
  }).sort((a, b) => b.relevance - a.relevance || b.upvotes - a.upvotes).slice(0, limit);

  const contents: string[] = [];

  for (const candidate of ranked) {
    const content = await readFileSafe(candidate.file);

    if (content) contents.push(content);
  }

  return contents;
}

/**
 * The learning a vote id names, or null when the id is a doc, a rule or a skill.
 *
 * `listLearningFiles` keys a namespaced learning by its path inside the root, so
 * the id a vote carries and the key a listing carries agree only when the
 * namespace is part of the id — which it is, since the index records the same
 * relative path. Both sides are compared with `/`: the listing joins with
 * `path.sep`, while a vote id keeps the `/` the index wrote, so on Windows a
 * namespaced learning never matched at all.
 */
function learningFileFor(docId: string, byName: ReadonlyMap<string, string>): string | null {
  const filename = docId.endsWith('.md') ? docId : `${docId}.md`;

  return byName.get(toPosix(filename)) ?? null;
}

function toPosix(value: string): string {
  return value.replaceAll('\\', '/');
}

/** The name part of a vote id: no namespace directory, no extension. */
function nameOf(docId: string): string {
  const stem = docId.replace(/\.md$/i, '');
  const cut = Math.max(stem.lastIndexOf('/'), stem.lastIndexOf('\\'));

  return cut >= 0 ? stem.slice(cut + 1) : stem;
}

function nameTokensOf(docId: string): Set<string> {
  return new Set(tokenize(nameOf(docId).replace(/[-_.]+/g, ' ')));
}

/**
 * The frontmatter fields that say what an entry is about. A field of the wrong
 * type reads as absent, as it does in the index: these are hand-written files, so
 * one malformed tag must not fail the whole scan.
 */
const TopicSchema = z.looseObject({
  title: z.string().optional().catch(undefined),
  tags: z.array(z.string().catch('')).optional().catch(undefined),
});

/**
 * What an entry is about, from what it says about itself: its title and tags when
 * it has frontmatter, and its name either way. Deliberately not its body — the
 * body of every entry in a repository shares that repository's vocabulary, which
 * would make everything look related to everything.
 */
async function entryTopicTokens(staleEntry: StaleEntry): Promise<Set<string>> {
  const tokens = nameTokensOf(staleEntry.docId);
  const content = await readFileSafe(staleEntry.path);

  if (!content) return tokens;

  const { title, tags } = TopicSchema.parse(parseFrontmatter(content).data);

  if (title) {
    for (const token of tokenize(title)) tokens.add(token);
  }

  for (const tag of tags ?? []) {
    for (const token of tokenize(tag)) tokens.add(token);
  }

  return tokens;
}

function overlapCount(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  let shared = 0;

  for (const token of b) {
    if (a.has(token)) shared++;
  }

  return shared;
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

  const { callTool } = await import('../tool-launch/call.js');
  const { isOverrideInvalid } = await import('../tool-launch/member-tools.js');

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
    const draft = (await callTool(prompt, { launchedBy: 'quality-update' })).text;

    return draft.trim();
  } catch (e) {
    if (isOverrideInvalid(e)) throw e;
    log.error(`AI update generation failed: ${e instanceof Error ? e.message : String(e)}`);

    return null;
  }
}
