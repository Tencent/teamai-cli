import fs from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline/promises';

import matter from 'gray-matter';

import { fetchGitHubPR } from './providers/github/mr-fetch.js';
import { fetchGitLabMR } from './providers/gitlab/mr-fetch.js';
import { fetchTGitMR } from './providers/tgit/mr-fetch.js';
import type { MRData, MRFetchOptions, MRThread, LearningDraft } from './types.js';
import { callClaude } from './utils/ai-client.js';
import { extractKeywords, findOverlappingLearnings } from './utils/dedup.js';
import { log, spinner } from './utils/logger.js';
import { getUserHome } from './utils/home.js';

/** Default directory for storing learnings. */
const DEFAULT_LEARNINGS_DIR = path.join(getUserHome(), '.teamai', 'learnings');

/**
 * Auto-detects the provider from the URL and fetches MR data.
 *
 * @param url   Full URL of the MR / PR
 * @param opts  What to read besides the MR, its commits and its diff
 * @returns     Normalized MRData object
 * @throws      Error when the URL does not belong to a known provider
 */
async function fetchMR(url: string, opts: MRFetchOptions): Promise<MRData> {
  if (url.includes('github.com')) {
    return fetchGitHubPR(url, opts);
  }
  if (url.includes('git.woa.com')) {
    return fetchTGitMR(url, opts);
  }
  // GitLab (incl. self-hosted): the `/-/merge_requests/` route is unique to
  // GitLab, so it identifies the platform on any host.
  if (/\/-\/merge_requests\/\d+/.test(url)) {
    return fetchGitLabMR(url, opts);
  }
  throw new Error(`Unsupported MR URL: ${url}. Only GitHub, TGit and GitLab are supported`);
}

/** Characters of the prompt the review threads may take (#1187). */
const THREADS_BUDGET = 6000;
/** Characters one thread may take before it is shortened to its first and last notes. */
const THREAD_MAX = 1500;
/** Characters one note may take. */
const NOTE_MAX = 500;

function clip(text: string, max: number): string {
  const trimmed = text.trim();
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max - 1)}…`;
}

/**
 * Renders the review threads for the extraction prompt (#1187).
 *
 * Threads with a reply come first and single unanswered remarks last, so a
 * budget cut drops the remarks. Each thread names the file and line it is
 * anchored to and whether it is resolved, then its notes in order, each marked
 * as the MR author's or a reviewer's. A thread over {@link THREAD_MAX} keeps
 * its first and last notes; once the budget is reached the rest of the
 * threads are counted, not cut off mid-thread.
 *
 * @param threads   The MR's review threads
 * @param mrAuthor  The MR author's username, to mark their notes
 * @param budget    Characters the section may take
 */
export function formatMrThreads(threads: MRThread[], mrAuthor: string | undefined, budget = THREADS_BUDGET): string {
  const ordered = [...threads.filter((t) => t.notes.length > 1), ...threads.filter((t) => t.notes.length <= 1)];
  const sections: string[] = [];
  let used = 0;
  for (const [index, thread] of ordered.entries()) {
    const anchor = thread.file ? ` — ${thread.file}${thread.line !== undefined ? `:${thread.line}` : ''}` : '';
    const state = thread.resolved === undefined ? '' : thread.resolved ? ' (resolved)' : ' (unresolved)';
    const header = `### Thread ${index + 1}${anchor}${state}`;
    const line = (note: MRThread['notes'][number]): string => {
      const role = note.author !== undefined && note.author === mrAuthor ? 'author' : 'reviewer';
      const who = note.author ? `${role} ${note.author}` : role;
      return `- [${who}] ${clip(note.body, NOTE_MAX).replace(/\n+/g, '\n  ')}`;
    };
    let lines = thread.notes.map(line);
    if (lines.join('\n').length > THREAD_MAX && thread.notes.length > 2) {
      lines = [lines[0], `- (${thread.notes.length - 2} notes omitted)`, lines[lines.length - 1]];
    }
    const section = `${header}\n${lines.join('\n')}`;
    if (used + section.length + 2 > budget) {
      const left = ordered.length - index;
      sections.push(`(${left} more thread${left === 1 ? '' : 's'} omitted)`);
      break;
    }
    sections.push(section);
    used += section.length + 2;
  }
  return sections.join('\n\n');
}

/**
 * Builds the learning extraction prompt.
 *
 * The MR's review threads, when the fetch read any, get a section of their
 * own after the diff, and the model is told that a decision reached in a
 * resolved thread outweighs a restatement of the diff (#1187). `language`
 * `en` asks for an English learning with English headings; `zh` or unset
 * keeps the Chinese one.
 *
 * @param mr        MR data object
 * @param language  The team's `language` from teamai.yaml
 * @returns         Full prompt string for callClaude
 */
export function extractMRLearningPrompt(mr: MRData, language?: 'en' | 'zh'): string {
  const commitsFormatted = mr.commits
    .map((c) => `- ${c.hash.slice(0, 8)}: ${c.message}`)
    .join('\n');
  const diff3000 = mr.diff.slice(0, 3000);
  const author = mr.author ?? 'unknown';
  const date = mr.mergedAt ? mr.mergedAt.slice(0, 10) : new Date().toISOString().slice(0, 10);
  const threads = mr.discussions && mr.discussions.length > 0 ? formatMrThreads(mr.discussions, mr.author) : '';
  const frontmatter = (titleHint: string): string => `---
title: "${titleHint}"
author: ${author}
date: ${date}
tags: [tag1, tag2, tag3]
confidence: 0.85
source_mr: "${mr.url}"
---`;

  if (language === 'en') {
    return `You are the team's knowledge base curator. Distill one valuable team learning from the MR below.
Write in English. Output a complete Markdown document with YAML frontmatter.
${threads ? '\nThe review threads carry the decisions: a decision reached in a resolved thread outweighs a restatement of the diff. Lead with what the review decided and why.\n' : ''}
Frontmatter fields (exactly this format, no other fields):
${frontmatter('<short title naming the core problem or finding, under 60 characters>')}

Body structure (every section is required):
## Background
What was being done? What problem came up?

## Solution
How was it solved? What were the key steps?

## Lessons
- lesson 1
- lesson 2

## Related Skills
- skill-name (or "none")

Pick 2-5 tags from these groups:
stack: python, typescript, go, k8s, docker, sglang, cuda
problem: troubleshooting, performance, deployment, config, api
pattern: workflow, pattern, tool-usage, best-practice
scene: debugging, testing, monitoring, security

---
MR title: ${mr.title}
MR description:
${mr.description}

Commits:
${commitsFormatted}

Key diff (first 3000 characters):
${diff3000}${threads ? `\n\nReview threads (${mr.discussions!.length}):\n${threads}` : ''}`;
  }

  return `你是团队知识库管理员。从以下 MR 信息提炼一条有价值的团队 learning。
【必须】用中文撰写，输出完整 Markdown 文档（含 YAML frontmatter）。
${threads ? '\nReview threads 一节记录了评审达成的决定：已 resolved 的 thread 里的决定比复述 diff 更重要，优先写评审决定了什么、为什么。\n' : ''}
frontmatter 字段（严格按此格式，不要加其他字段）：
${frontmatter('<简短标题，描述核心问题或发现，<60字符>')}

body 结构（以下各节必须包含）：
## 背景
在做什么？遇到了什么问题？

## 解决方案
怎么解决的？关键步骤是什么？

## 经验总结
- 经验 1
- 经验 2

## 相关 Skills
- skill-name（如无则写"暂无"）

tags 从以下类别选 2-5 个：
技术栈: python, typescript, go, k8s, docker, sglang, cuda
问题类型: troubleshooting, performance, deployment, config, api
模式: workflow, pattern, tool-usage, best-practice
场景: debugging, testing, monitoring, security

---
MR 标题：${mr.title}
MR 描述：
${mr.description}

提交信息：
${commitsFormatted}

关键 diff（前 3000 字）：
${diff3000}${threads ? `\n\nReview threads（${mr.discussions!.length}）：\n${threads}` : ''}`;
}

/**
 * Parses the AI-generated learning draft, tolerating malformed frontmatter.
 *
 * The LLM output may wrap content in markdown code fences, prepend
 * conversational text, or contain markdown (e.g. '*italic*' lines) that
 * gray-matter/js-yaml would misread as YAML. This normalizes the content and
 * parses it defensively so a parse failure never crashes the caller.
 *
 * @param raw  Raw string returned by the AI
 * @returns    Normalized content plus parsed frontmatter data (empty object on parse failure)
 */
export function parseLearningDraft(raw: string): { content: string; data: Record<string, unknown> } {
  let content = raw
    .replace(/^```(?:markdown|md|yaml)?\s*\n/m, '')
    .replace(/\n```\s*$/, '');
  // AI may emit conversational text before the frontmatter; start at the first `---`
  const frontmatterStart = content.indexOf('---');
  if (frontmatterStart > 0) {
    content = content.slice(frontmatterStart);
  }
  try {
    const parsed = matter(content);
    return { content, data: parsed.data };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn(`⚠️  Failed to parse learning frontmatter, using fallback: ${message}`);
    return { content, data: {} };
  }
}

/**
 * Interactively asks the user to confirm an action.
 *
 * @param question  Prompt text (no trailing space needed)
 * @returns         false if the user enters 'n'/'N', true for anything else (including Enter)
 */
async function promptConfirm(question: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(`${question} `);
    return answer.trim().toLowerCase() !== 'n';
  } finally {
    rl.close();
  }
}

/**
 * Infers the repo URL from an MR URL.
 *
 * @param mrUrl  Full MR / PR URL
 * @returns      Inferred repo .git URL
 */
function extractRepoUrlFromMrUrl(mrUrl: string): string {
  // GitHub: https://github.com/owner/repo/pull/123 → https://github.com/owner/repo.git
  const ghMatch = mrUrl.match(/^(https:\/\/github\.com\/[^/]+\/[^/]+)\/pull\//);
  if (ghMatch) return `${ghMatch[1]}.git`;
  // TGit: https://git.woa.com/group[/subgroup]/repo/merge_requests/123
  const tgitMatch = mrUrl.match(/^(https:\/\/git\.woa\.com\/.+\/[^/]+)\/merge_requests\//);
  if (tgitMatch) return `${tgitMatch[1]}.git`;
  // GitLab: https://<host>/group[/subgroup]/repo/-/merge_requests/123
  const gitlabMatch = mrUrl.match(/^(https?:\/\/.+?\/.+\/[^/]+)\/-\/merge_requests\//);
  if (gitlabMatch) return `${gitlabMatch[1]}.git`;
  // Cannot reliably extract; return empty string so caller skips incremental update
  return '';
}

/**
 * Extracts a learning draft from an MR URL and infers the repo URL.
 *
 * Implements P0.5: fetch MR data → AI extraction → dedup → interactive confirm → write file.
 *
 * @param opts.url          Full MR / PR URL (required)
 * @param opts.learningsDirs Learnings roots compared with the draft for a possible duplicate
 * @param opts.learningsNamespaces The active project namespaces compared under each root
 * @param opts.all          Skip interactive confirmation, accept all
 * @param opts.outputDir    Output mode: write to this directory (learning.md)
 * @param opts.outputFileName The file name to write under outputDir, when several MRs would share learning.md (#1104)
 * @param opts.queueLearning  Queues a new learning (its file name, its content) when outputDir is not set, returning the file written
 * @param opts.dryRun       Dry run, no disk writes
 * @returns                 Extraction result containing the learning draft and inferred repo URL
 */
export async function importFromMR(opts: {
  url: string;
  /** Learnings roots compared with the draft, highest precedence first. */
  learningsDirs?: readonly string[];
  /** The active project namespaces: recall finds their learnings here, and no others. */
  learningsNamespaces?: readonly string[];
  all?: boolean;
  outputDir?: string;
  /** Written instead of `learning.md`, so several MRs of one run do not overwrite each other. */
  outputFileName?: string;
  queueLearning?: (filename: string, content: string) => Promise<string>;
  dryRun?: boolean;
  /** Read the MR's review threads into the extraction (default true; `--no-discussions` turns it off). */
  discussions?: boolean;
  /** The marker `ci extract-mr --comment-marker` posts with, so its own comments stay out of the threads. */
  commentMarker?: string;
  /** The team's `language` from teamai.yaml: `en` writes the learning in English. */
  language?: 'en' | 'zh';
}): Promise<{ learning?: LearningDraft; repoUrl: string; learningFile?: string }> {
  const learningsDirs = opts.learningsDirs ?? [DEFAULT_LEARNINGS_DIR];

  // ── 步骤 1：获取 MR 数据 ────────────────────────────────
  const fetchSpinner = await spinner('Fetching MR data...');
  fetchSpinner.start();

  let mr: MRData;
  try {
    mr = await fetchMR(opts.url, { discussions: opts.discussions ?? true, commentMarker: opts.commentMarker });
    fetchSpinner.succeed(mr.discussions?.length
      ? `MR data fetched (${mr.discussions.length} review thread${mr.discussions.length === 1 ? '' : 's'})`
      : 'MR data fetched');
  } catch (err: unknown) {
    fetchSpinner.fail('MR data fetch failed');
    throw err;
  }

  // ── 步骤 2：AI 分析 ────────────────────────────────────
  const aiSpinner = await spinner('AI analysis in progress...');
  aiSpinner.start();

  let learningContent: string;
  try {
    learningContent = await callClaude(extractMRLearningPrompt(mr, opts.language));
    aiSpinner.succeed('AI analysis complete');
  } catch (err: unknown) {
    aiSpinner.fail('AI analysis failed');
    throw err;
  }

  // ── 步骤 3：解析 learning 草稿 + dedup ─────────────────
  const { content: normalizedContent, data: frontmatter } = parseLearningDraft(learningContent);
  learningContent = normalizedContent;
  const learningTitle = typeof frontmatter['title'] === 'string' ? frontmatter['title'] : mr.title;

  const draftKeywords = extractKeywords(learningContent);
  const possibleDuplicates = (await findOverlappingLearnings(draftKeywords, learningsDirs, { namespaces: opts.learningsNamespaces }))
    .map((entry) => entry.filename);

  const learning: LearningDraft = {
    title: learningTitle,
    content: learningContent,
  };

  // ── 步骤 4：打印摘要 ────────────────────────────────────
  log.info(`✅ Learning draft generated: ${learningTitle}`);

  const tags = Array.isArray(frontmatter['tags'])
    ? frontmatter['tags'].filter((tag): tag is string => typeof tag === 'string')
    : [];
  if (tags.length > 0) {
    log.info(`   Tags: ${tags.join(', ')}`);
  }

  if (possibleDuplicates.length > 0) {
    // Names the existing learnings; accepting the draft changes none of them.
    log.warn(`Possible duplicate: this learning overlaps ${possibleDuplicates.length} existing learning(s): ${possibleDuplicates.join(', ')}.`);
  }

  // ── 步骤 5：交互确认 ───────────────────────────────────
  let acceptLearning = true;

  if (!opts.all) {
    acceptLearning = await promptConfirm('Accept learning? [Y/n]');
  }

  // ── 步骤 6：写文件 ─────────────────────────────────────
  let learningFile: string | undefined;
  if (!opts.dryRun && acceptLearning) {
    learningFile = await writeLearning(learning, opts.outputDir, opts.queueLearning, opts.outputFileName);
  }

  // 推断仓库 URL
  const repoUrl = extractRepoUrlFromMrUrl(opts.url);

  return {
    learning: acceptLearning ? learning : undefined,
    repoUrl,
    learningFile,
  };
}

/**
 * 将 learning 草稿写入磁盘。
 *
 * Writes to outputDir when given, else into the queue, and returns the file written.
 * With neither, it warns and skips.
 *
 * @param draft         The learning draft
 * @param outputDir     Output directory (optional)
 * @param learningsDir  Where new learnings are written (the write root, optional)
 * @param outputFileName File name under outputDir, default `learning.md`
 */
async function writeLearning(
  draft: LearningDraft,
  outputDir?: string,
  queueLearning?: (filename: string, content: string) => Promise<string>,
  outputFileName?: string,
): Promise<string | undefined> {
  if (outputDir) {
    await fs.mkdir(outputDir, { recursive: true });
    const filePath = path.join(outputDir, outputFileName ?? 'learning.md');
    await fs.writeFile(filePath, draft.content, 'utf-8');
    log.info(`Learning written: ${filePath}`);
    return filePath;
  }

  if (queueLearning) {
    // contribute's naming: the random suffix keeps two members' learnings with
    // the same title and day apart once both are published (#823).
    const { generateFilename } = await import('./contribute.js');
    const filePath = await queueLearning(generateFilename(draft.title), draft.content);
    log.info(`Learning written: ${filePath}`);
    return filePath;
  }

  log.warn('No outputDir or learnings directory specified, learning draft not saved to disk');
  return undefined;
}
