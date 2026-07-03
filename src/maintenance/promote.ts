// -*- coding: utf-8 -*-
import path from 'node:path';

import matter from 'gray-matter';
import { readFileSafe, writeFile, listFiles, ensureDir, copyFile } from '../utils/fs.js';
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
 * Find learnings eligible for promotion to formal knowledge.
 */
export async function findPromotionCandidates(
  learningsDir: string,
  votesDir: string,
): Promise<PromotionCandidate[]> {
  const confidenceMap = await computeAllConfidence(votesDir);
  const candidates: PromotionCandidate[] = [];

  const perDoc = await aggregatePerDocVotes(votesDir);
  const files = await listFiles(learningsDir);
  const now = Date.now();

  for (const file of files) {
    if (!file.endsWith('.md')) continue;
    const docId = file.replace(/\.md$/i, '');
    const confidence = confidenceMap.get(docId) ?? 0;
    if (confidence < MIN_CONFIDENCE) continue;

    const docVotes = perDoc.get(docId);
    if (!docVotes) continue;
    if (docVotes.upvoted < MIN_UPVOTED) continue;
    if (docVotes.users.size < MIN_USERS) continue;

    const absPath = path.join(learningsDir, file);
    const content = await readFileSafe(absPath);
    if (!content) continue;

    let title = docId;
    let date = '';
    try {
      const { data } = matter(content);
      title = typeof data.title === 'string' ? data.title : docId;
      date = typeof data.date === 'string' ? data.date : '';
      if (data.promoted_to) continue;
    } catch {
      continue;
    }

    if (date) {
      const ageInDays = (now - new Date(date).getTime()) / (1000 * 60 * 60 * 24);
      if (ageInDays < MIN_AGE_DAYS) continue;
    }

    const suggestedCategory = await inferCategory(content, title);

    candidates.push({
      docId,
      filename: file,
      path: absPath,
      confidence,
      upvotedCount: docVotes.upvoted,
      userCount: docVotes.users.size,
      title,
      suggestedCategory,
    });
  }

  return candidates.sort((a, b) => b.confidence - a.confidence);
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

  try {
    const { callClaude } = await import('../utils/ai-client.js');

    const prompt = `You are a technical knowledge engineer promoting a team learning into formal knowledge.

The following "learning" has been repeatedly validated by the team (high confidence, adopted by multiple members). Transform it into ${categoryGuide[category]}

Original learning (title: "${title}"):
---
${originalContent}
---

Output ONLY the transformed markdown content (including YAML frontmatter with title, tags, date set to today). Do NOT include the original learning's confidence or vote-related fields in the frontmatter.`;

    const result = await callClaude(prompt, { timeout: 60_000 });
    return result.trim();
  } catch (e) {
    log.warn(`AI content generation failed, using original content: ${(e as Error).message}`);
    return originalContent;
  }
}

export async function executePromotion(
  candidate: PromotionCandidate,
  repoPath: string,
  options: PromoteOptions = {},
): Promise<string> {
  const category = options.category ?? candidate.suggestedCategory;
  const targetDir = path.join(repoPath, category);
  await ensureDir(targetDir);

  const targetPath = path.join(targetDir, candidate.filename);

  if (options.dryRun) {
    log.info(`[dry-run] Would promote ${candidate.docId} -> ${category}/${candidate.filename}`);
    return targetPath;
  }

  const originalContent = await readFileSafe(candidate.path);
  if (!originalContent) {
    log.error(`Cannot read source file: ${candidate.path}`);
    return targetPath;
  }

  // AI transforms the learning into a generalized format for the target category
  const promotedContent = await generatePromotedContent(originalContent, category, candidate.title);
  await writeFile(targetPath, promotedContent);

  // Mark original learning as promoted
  const { data, content: body } = matter(originalContent);
  data.promoted_to = `${category}/${candidate.filename}`;
  const updated = matter.stringify(body, data);
  await writeFile(candidate.path, updated);

  log.success(`Promoted: ${candidate.docId} -> ${category}/${candidate.filename}`);
  return targetPath;
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
  try {
    const { callClaude } = await import('../utils/ai-client.js');

    const prompt = `Classify the following team knowledge entry into exactly ONE category. Reply with ONLY the category name (no explanation):

- "skills" — reusable workflows, SOPs, step-by-step procedures, CLI recipes, operational playbooks
- "rules" — mandatory constraints, coding standards, conventions, best practices that MUST be followed
- "docs" — architecture decisions, system design, background context, reference documentation

Title: ${title}

Content:
${content.slice(0, 2000)}

Category:`;

    const result = await callClaude(prompt, { timeout: 30_000 });
    const category = result.trim().toLowerCase().replace(/[^a-z]/g, '');

    if (category === 'skills' || category === 'rules' || category === 'docs') {
      return category;
    }
  } catch {
    // AI unavailable — fall back to keywords
  }

  return inferCategoryByKeywords(content, title);
}

async function aggregatePerDocVotes(
  votesDir: string,
): Promise<Map<string, { recalled: number; upvoted: number; users: Set<string> }>> {
  const perDoc = new Map<string, { recalled: number; upvoted: number; users: Set<string> }>();
  const { loadUserVotes } = await import('../votes.js');
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
        if ((entry.upvoted_count ?? 0) > 0) existing.users.add(username);
        perDoc.set(docId, existing);
      }
    } catch {
      continue;
    }
  }

  return perDoc;
}
