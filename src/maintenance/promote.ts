// -*- coding: utf-8 -*-
import path from 'node:path';
import { writeFile as writeNewFile } from 'node:fs/promises';

import matter from 'gray-matter';
import { z } from 'zod';
import { readFileSafe, writeFile, listFiles, ensureDir, pathExists } from '../utils/fs.js';
import { FrontmatterDateSchema } from '../utils/frontmatter.js';
import { assertSafePath } from '../utils/path-safety.js';
import { createGit, getDefaultBranch, PUSH_BRANCH_PREFIX } from '../utils/git.js';
import { isInWriteRoot, listLearningFiles } from '../utils/learnings-roots.js';
import { log } from '../utils/logger.js';
import { computeAllConfidence } from './confidence.js';

/** A frontmatter field that counts only when it is a string. */
const FrontmatterTextSchema = z.string().optional().catch(undefined);

export interface PromotionCandidate {
  docId: string;
  filename: string;
  path: string;
  confidence: number;
  upvotedCount: number;
  userCount: number;
  title: string;
  /** What its keywords suggest; the AI chooses when it is promoted. */
  suggestedCategory: PromotionCategory;
}

const MIN_CONFIDENCE = 0.90;
const MIN_UPVOTED = 5;
const MIN_USERS = 2;
const MIN_AGE_DAYS = 14;

/**
 * Find learnings eligible for promotion to formal knowledge. A learning marked
 * `promoted_to` stays out only while that target is in place in
 * `knowledgeCheckout`, the git checkout of the team's knowledge: the default
 * branch or an open review branch touched it. One whose review was closed
 * unmerged and its branch deleted is offered again. Without a checkout, the
 * marker alone keeps it out.
 */
export interface PromotionCandidatesOptions {
  namespaces?: readonly string[];
}

export async function findPromotionCandidates(
  learningsDirs: readonly string[],
  votesDir: string,
  knowledgeCheckout?: string | PromotionCandidatesOptions,
  options?: PromotionCandidatesOptions,
): Promise<PromotionCandidate[]> {
  const checkout = knowledgeCheckout instanceof Object ? undefined : knowledgeCheckout;

  const opts = knowledgeCheckout instanceof Object ? knowledgeCheckout : options;

  const namespaces = opts?.namespaces;
  const confidenceMap = await computeAllConfidence(votesDir);
  const eligible: Array<Omit<PromotionCandidate, 'suggestedCategory'> & { content: string; promotedTo?: string }> = [];

  const perDoc = await aggregatePerDocVotes(votesDir);
  const files = await listLearningFiles(learningsDirs, namespaces);
  const now = Date.now();

  for (const { file, absPath } of files) {
    const docId = file.replace(/\.md$/i, '');
    const confidence = confidenceMap.get(docId) ?? 0;

    if (confidence < MIN_CONFIDENCE) continue;

    const docVotes = perDoc.get(docId);

    if (!docVotes) continue;

    if (docVotes.upvoted < MIN_UPVOTED) continue;

    if (docVotes.users.size < MIN_USERS) continue;

    const content = await readFileSafe(absPath);

    if (!content) continue;

    let title = docId;
    let date = '';
    let promotedTo: string | undefined;

    try {
      const { data } = matter(content);
      title = FrontmatterTextSchema.parse(data.title) ?? docId;
      date = FrontmatterDateSchema.parse(data.date) ?? '';
      promotedTo = FrontmatterTextSchema.parse(data.promoted_to);
    } catch {
      continue;
    }

    if (date) {
      const ageInDays = (now - new Date(date).getTime()) / (1000 * 60 * 60 * 24);

      if (ageInDays < MIN_AGE_DAYS) continue;
    }

    eligible.push({
      docId,
      filename: file,
      path: absPath,
      confidence,
      upvotedCount: docVotes.upvoted,
      userCount: docVotes.users.size,
      title,
      content,
      promotedTo,
    });
  }

  const inPlace = await promotionTargetsInPlace(checkout, eligible.flatMap((entry) => entry.promotedTo ?? []));
  const candidates: PromotionCandidate[] = [];

  for (const { content, promotedTo, ...entry } of eligible) {
    if (promotedTo !== undefined && inPlace.has(promotedTo)) continue;
    candidates.push({ ...entry, suggestedCategory: inferCategoryByKeywords(content, entry.title) });
  }

  return candidates.sort((a, b) => b.confidence - a.confidence);
}

/**
 * Update origin's default branch and its review branches in `knowledgeCheckout`,
 * dropping the review branches origin no longer has, so
 * {@link findPromotionCandidates} sees the promotions as origin has them.
 */
export async function fetchPromotionRefs(knowledgeCheckout: string): Promise<void> {
  const branch = await getDefaultBranch(knowledgeCheckout);
  await createGit(knowledgeCheckout).fetch([
    '--prune',
    'origin',
    `+refs/heads/${branch}:refs/remotes/origin/${branch}`,
    `+refs/heads/${PUSH_BRANCH_PREFIX}*:refs/remotes/origin/${PUSH_BRANCH_PREFIX}*`,
  ]);
}

/**
 * The targets, relative to `knowledgeCheckout`, that a commit on origin's
 * default branch or on a review branch ever touched, as of the last fetch: an
 * entry the team later renamed or deleted still counts. Every target when
 * there is no checkout or git cannot tell.
 */
async function promotionTargetsInPlace(knowledgeCheckout: string | undefined, targets: readonly string[]): Promise<ReadonlySet<string>> {
  if (knowledgeCheckout === undefined || targets.length === 0) return new Set(targets);

  try {
    const base = `origin/${await getDefaultBranch(knowledgeCheckout)}`;

    const touched = await createGit(knowledgeCheckout).raw([
      '--literal-pathspecs', 'log', '-z', '--relative', '--name-only', '--format=',
      base, `--remotes=origin/${PUSH_BRANCH_PREFIX}*`, '--', ...targets,
    ]);

    return new Set(touched.split('\0').filter(Boolean));
  } catch (e) {
    log.debug(`Could not read promotion targets in ${knowledgeCheckout}; treating marked learnings as promoted: ${e instanceof Error ? e.message : String(e)}`);

    return new Set(targets);
  }
}

/** The categories a learning is promoted to. */
export const PromotionCategorySchema = z.enum(['skills', 'rules', 'docs']);

export type PromotionCategory = z.infer<typeof PromotionCategorySchema>;

/** The promoted entry's path in the knowledge checkout, in posix form: a skill is `<learning>/SKILL.md`. */
export function promotionTarget(filename: string, category: PromotionCategory): string {
  const normalizedFilename = filename.split(path.sep).join('/');

  return category === 'skills'
    ? path.posix.join(category, normalizedFilename.replace(/\.md$/i, ''), 'SKILL.md')
    : path.posix.join(category, normalizedFilename);
}

/**
 * Writes the promoted entry of `candidate` in `repoPath`: `content`, the learning rewritten for its category, or the
 * learning as written when there is none. A dry run only says where it would go. Nothing is overwritten.
 */
export async function writePromotion(
  candidate: Pick<PromotionCandidate, 'docId' | 'filename' | 'path'>,
  repoPath: string,
  options: { category: PromotionCategory; content?: string; dryRun?: boolean },
): Promise<{ targetPath: string; relativePath: string }> {
  const relativePath = promotionTarget(candidate.filename, options.category);
  const targetPath = path.join(repoPath, relativePath);
  assertSafePath(targetPath, [repoPath]);

  if (await pathExists(targetPath)) {
    throw new Error(`Promotion target already exists: ${relativePath}. Nothing was overwritten.`);
  }

  if (options.dryRun) {
    log.info(`[dry-run] Would promote ${candidate.docId} -> ${relativePath}`);

    return { targetPath, relativePath };
  }

  let promotedContent = options.content ?? await readFileSafe(candidate.path);

  if (!promotedContent) {
    throw new Error(`Cannot read source file: ${candidate.path}`);
  }

  if (options.category === 'skills') {
    const { withSkillFrontmatter } = await import('../resources/skills.js');
    const skillName = path.basename(candidate.filename).replace(/\.md$/i, '');
    promotedContent = withSkillFrontmatter(promotedContent, skillName);
  }

  await ensureDir(path.dirname(targetPath));
  await writeNewFile(targetPath, promotedContent, { flag: 'wx' });

  return { targetPath, relativePath };
}

/**
 * Marks `learning` as promoted to `relativePath`, and returns the file it marked. When the
 * learning lives in a root nothing pushes, the mark goes to the write root instead: written in place it would be
 * discarded by the next realign, and the same learning would be promoted again on the next run.
 */
export async function markPromoted(
  learning: { docId: string; filename: string; path: string },
  relativePath: string,
  learningsWriteDir?: string,
): Promise<string> {
  const originalContent = await readFileSafe(learning.path);

  if (!originalContent) {
    throw new Error(`Cannot read source file: ${learning.path}`);
  }

  const { data, content: body } = matter(originalContent);
  data.promoted_to = relativePath;
  const updated = matter.stringify(body, data);

  const markPath = learningsWriteDir
    && !isInWriteRoot(learning.path, learningsWriteDir)
    ? path.join(learningsWriteDir, learning.filename)
    : learning.path;

  await ensureDir(path.dirname(markPath));
  await writeFile(markPath, updated);

  log.success(`Promoted: ${learning.docId} -> ${relativePath}`);

  return markPath;
}

/**
 * The category a learning is promoted to, and why: the one the person gave, else the one the AI chose, else, when the
 * AI could not choose, the one its keywords suggest. Each is '' when there is none.
 */
export function chooseCategory(choice: { given: string; chosen: string; reason: string; suggested: PromotionCategory }) {
  if (choice.given !== '') return { category: categoryOf(choice.given), reason: 'Chosen with --category.' };

  if (choice.chosen !== '') return { category: categoryOf(choice.chosen), reason: choice.reason };

  return { category: choice.suggested, reason: 'Suggested by the learning\'s keywords, since the AI could not choose.' };
}

function categoryOf(text: string): PromotionCategory {
  const parsed = PromotionCategorySchema.safeParse(text);

  if (!parsed.success) throw new Error(`Invalid promotion category "${text}". Use skills, rules, or docs.`);

  return parsed.data;
}

function inferCategoryByKeywords(content: string, title: string): PromotionCategory {
  const lower = (content + ' ' + title).toLowerCase();

  const skillSignals = ['command', 'cli', 'workflow', 'step-by-step', 'procedure', 'how to', 'recipe'];
  const ruleSignals = ['must', 'never', 'always', 'constraint', 'convention', 'standard', 'rule'];
  const docSignals = ['architecture', 'design', 'overview', 'background', 'decision', 'context'];

  const skillScore = skillSignals.filter((s) => lower.includes(s)).length;
  const ruleScore = ruleSignals.filter((s) => lower.includes(s)).length;
  const docScore = docSignals.filter((s) => lower.includes(s)).length;

  if (ruleScore >= skillScore && ruleScore >= docScore) return 'rules';

  if (skillScore >= docScore) return 'skills';

  return 'docs';
}

async function aggregatePerDocVotes(
  votesDir: string,
): Promise<Map<string, { recalled: number; upvoted: number; users: Set<string> }>> {
  const perDoc = new Map<string, { recalled: number; upvoted: number; users: Set<string> }>();
  const { readUserVotes } = await import('../votes.js');
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

        if ((entry.upvoted_count ?? 0) > 0) existing.users.add(username);
        perDoc.set(docId, existing);
      }
    } catch {
      continue;
    }
  }

  return perDoc;
}
