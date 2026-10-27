// -*- coding: utf-8 -*-
import path from 'node:path';
import { writeFile as writeNewFile } from 'node:fs/promises';

import matter from 'gray-matter';
import { readFileSafe, writeFile, listFiles, ensureDir, pathExists } from '../utils/fs.js';
import { assertSafePath } from '../utils/path-safety.js';
import { createGit, getDefaultBranch, PUSH_BRANCH_PREFIX } from '../utils/git.js';
import { isInWriteRoot, listLearningFiles } from '../utils/learnings-roots.js';
import { log } from '../utils/logger.js';
import { computeAllConfidence } from './confidence.js';

export interface PromotionCandidate {
  docId: string;
  filename: string;
  path: string;
  confidence: number;
  upvotedCount: number;
  userCount: number;
  title: string;
  suggestedCategory: 'skills' | 'rules' | 'docs';
}

export interface PromoteOptions {
  category?: 'skills' | 'rules' | 'docs';
  dryRun?: boolean;
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
  const checkout = typeof knowledgeCheckout === 'string' ? knowledgeCheckout : undefined;
  const opts = typeof knowledgeCheckout === 'object' && knowledgeCheckout !== null
    ? knowledgeCheckout
    : options;
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
      title = typeof data.title === 'string' ? data.title : docId;
      date = typeof data.date === 'string' ? data.date : '';
      promotedTo = typeof data.promoted_to === 'string' ? data.promoted_to : undefined;
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
    candidates.push({ ...entry, suggestedCategory: await inferCategory(content, entry.title) });
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

/**
 * Execute promotion: copy learning to target category, mark original.
 */
/**
 * Use AI to transform a learning (individual experience) into a generalized
 * knowledge entry suitable for the target category.
 *
 * - skills: rewrite as a step-by-step procedure / SOP with clear triggers
 * - rules: rewrite as a concise constraint with rationale
 * - docs: rewrite as reference documentation with context
 *
 * Falls back to the original content if AI is unavailable.
 */
async function generatePromotedContent(
  originalContent: string,
  category: 'skills' | 'rules' | 'docs',
  title: string,
): Promise<string> {
  const categoryGuide: Record<string, string> = {
    skills: `a reusable skill/SOP. Format it with:
- A clear "when to use" trigger description
- Step-by-step numbered procedure
- Expected outcome
- Common pitfalls to avoid
Remove any references to specific dates, people, or one-off incidents. Make it timeless and reusable.`,
    rules: `a team rule/constraint. Format it with:
- A one-line rule statement (imperative: "Always X" / "Never Y")
- Rationale: why this matters (1-2 sentences)
- Examples of correct and incorrect usage
Remove anecdotal context. State the constraint as an absolute standard.`,
    docs: `a reference document. Format it with:
- Context: what system/component this describes
- Key concepts and their relationships
- Architecture decisions and their rationale
- Current state (as of promotion date)
Remove personal narrative. Write as objective technical documentation.`,
  };

  const { callTool, isOverrideInvalid } = await import('../tool-launch/call.js');
  try {
    const prompt = `You are a technical knowledge engineer promoting a team learning into formal knowledge.

The following "learning" has been repeatedly validated by the team (high confidence, adopted by multiple members). Transform it into ${categoryGuide[category]}

Original learning (title: "${title}"):
---
${originalContent}
---

Output ONLY the transformed markdown content (including YAML frontmatter with title, tags, date set to today). Do NOT include the original learning's confidence or vote-related fields in the frontmatter.`;

    const { text } = await callTool(prompt, { launchedBy: 'recall-promote', timeout: 60_000 });
    return text.trim();
  } catch (e) {
    if (isOverrideInvalid(e)) throw e;
    log.warn(`AI content generation failed, using original content: ${(e as Error).message}`);
    return originalContent;
  }
}

/**
 * The promoted entry's path, and the learning file it marked as promoted (null
 * when it marked none), which is what a publish may stage (#823).
 */
export async function executePromotion(
  candidate: PromotionCandidate,
  repoPath: string,
  options: PromoteOptions & {
    learningsWriteDir?: string;
    /** Publish the artifact before recording the learning as promoted. A failure leaves it eligible. */
    publish?: (targetPath: string) => Promise<void>;
  } = {},
): Promise<{ targetPath: string; marked: string | null }> {
  const category = options.category ?? candidate.suggestedCategory;
  if (!['skills', 'rules', 'docs'].includes(category)) {
    throw new Error(`Invalid promotion category "${category}". Use skills, rules, or docs.`);
  }
  const normalizedFilename = candidate.filename.split(path.sep).join('/');
  const relativePath = category === 'skills'
    ? path.posix.join(category, normalizedFilename.replace(/\.md$/i, ''), 'SKILL.md')
    : path.posix.join(category, normalizedFilename);
  const targetPath = path.join(repoPath, relativePath);
  assertSafePath(targetPath, [repoPath]);
  if (await pathExists(targetPath)) {
    throw new Error(`Promotion target already exists: ${relativePath}. Nothing was overwritten.`);
  }

  if (options.dryRun) {
    log.info(`[dry-run] Would promote ${candidate.docId} -> ${relativePath}`);
    return { targetPath, marked: null };
  }

  const originalContent = await readFileSafe(candidate.path);
  if (!originalContent) {
    throw new Error(`Cannot read source file: ${candidate.path}`);
  }

  // AI transforms the learning into a generalized format for the target category
  let promotedContent = await generatePromotedContent(originalContent, category, candidate.title);
  if (category === 'skills') {
    const { withSkillFrontmatter } = await import('../resources/skills.js');
    const skillName = path.posix.basename(normalizedFilename).replace(/\.md$/i, '');
    promotedContent = withSkillFrontmatter(promotedContent, skillName);
  }
  await ensureDir(path.dirname(targetPath));
  await writeNewFile(targetPath, promotedContent, { flag: 'wx' });
  await options.publish?.(targetPath);

  // Mark the learning as promoted. When it lives in a root nothing pushes, the
  // mark goes to the write root instead: written in place it would be discarded
  // by the next realign, and the same learning would be promoted again on the
  // next run, paying for another model call.
  const { data, content: body } = matter(originalContent);
  data.promoted_to = relativePath;
  const updated = matter.stringify(body, data);
  const markPath = options.learningsWriteDir
    && !isInWriteRoot(candidate.path, options.learningsWriteDir)
    ? path.join(options.learningsWriteDir, candidate.filename)
    : candidate.path;
  await ensureDir(path.dirname(markPath));
  await writeFile(markPath, updated);

  log.success(`Promoted: ${candidate.docId} -> ${relativePath}`);
  return { targetPath, marked: markPath };
}

function inferCategoryByKeywords(content: string, title: string): 'skills' | 'rules' | 'docs' {
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

/**
 * Use AI to determine the best promotion category for a learning.
 * Falls back to keyword-based inference if AI is unavailable.
 */
async function inferCategory(content: string, title: string): Promise<'skills' | 'rules' | 'docs'> {
  const { callTool, isOverrideInvalid } = await import('../tool-launch/call.js');
  try {
    const prompt = `Classify the following team knowledge entry into exactly ONE category. Reply with ONLY the category name (no explanation):

- "skills" — reusable workflows, SOPs, step-by-step procedures, CLI recipes, operational playbooks
- "rules" — mandatory constraints, coding standards, conventions, best practices that MUST be followed
- "docs" — architecture decisions, system design, background context, reference documentation

Title: ${title}

Content:
${content.slice(0, 2000)}

Category:`;

    const { text } = await callTool(prompt, { launchedBy: 'recall-promote', timeout: 30_000 });
    const category = text.trim().toLowerCase().replace(/[^a-z]/g, '');

    if (category === 'skills' || category === 'rules' || category === 'docs') {
      return category;
    }
  } catch (e) {
    if (isOverrideInvalid(e)) throw e;
    // AI unavailable — fall back to keywords
  }

  return inferCategoryByKeywords(content, title);
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
