import fs from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline/promises';

import matter from 'gray-matter';

import { fetchGitHubPR } from './providers/github/mr-fetch.js';
import { fetchTGitMR } from './providers/tgit/mr-fetch.js';
import type { MRData, LearningDraft } from './types.js';
import { callClaude } from './utils/ai-client.js';
import { extractKeywords, findSupersededLearnings } from './utils/dedup.js';
import { log, spinner } from './utils/logger.js';

/** Default directory for storing learnings. */
const DEFAULT_LEARNINGS_DIR = path.join(process.env.HOME ?? '/tmp', '.teamai', 'learnings');

/** Dedup similarity threshold. */
const SUPERSEDE_THRESHOLD = 0.6;

/**
 * Auto-detects the provider from the URL and fetches MR data.
 *
 * @param url  Full URL of the MR / PR
 * @returns    Normalized MRData object
 * @throws     Error when the URL does not belong to a known provider
 */
async function fetchMR(url: string): Promise<MRData> {
  if (url.includes('github.com')) {
    return fetchGitHubPR(url);
  }
  if (url.includes('git.woa.com')) {
    return fetchTGitMR(url);
  }
  throw new Error(`Unsupported MR URL: ${url}. Only GitHub and TGit are supported`);
}

/**
 * Builds the learning extraction prompt.
 *
 * @param mr  MR data object
 * @returns   Full prompt string for callClaude
 */
function extractMRLearningPrompt(mr: MRData): string {
  const commitsFormatted = mr.commits
    .map((c) => `- ${c.hash.slice(0, 8)}: ${c.message}`)
    .join('\n');
  const diff3000 = mr.diff.slice(0, 3000);
  const author = mr.author ?? 'unknown';
  const date = mr.mergedAt ? mr.mergedAt.slice(0, 10) : new Date().toISOString().slice(0, 10);

  return `你是团队知识库管理员。从以下 MR 信息提炼一条有价值的团队 learning。
【必须】用中文撰写，输出完整 Markdown 文档（含 YAML frontmatter）。

frontmatter 字段（严格按此格式，不要加其他字段）：
---
title: "<简短标题，描述核心问题或发现，<60字符>"
author: ${author}
date: ${date}
tags: [tag1, tag2, tag3]
confidence: 0.85
source_mr: "${mr.url}"
---

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
${diff3000}`;
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
  // Cannot reliably extract; return empty string so caller skips incremental update
  return '';
}

/**
 * Extracts a learning draft from an MR URL and infers the repo URL.
 *
 * Implements P0.5: fetch MR data → AI extraction → dedup → interactive confirm → write file.
 *
 * @param opts.url          Full MR / PR URL (required)
 * @param opts.learningsDir Directory for dedup scanning, default ~/.teamai/learnings
 * @param opts.all          Skip interactive confirmation, accept all
 * @param opts.outputDir    Output mode: write to this directory (learning.md)
 * @param opts.repoPath     Team repo path (written to learnings/ when outputDir is not set)
 * @param opts.dryRun       Dry run, no disk writes
 * @returns                 Extraction result containing the learning draft and inferred repo URL
 */
export async function importFromMR(opts: {
  url: string;
  learningsDir?: string;
  all?: boolean;
  outputDir?: string;
  repoPath?: string;
  dryRun?: boolean;
}): Promise<{ learning?: LearningDraft; repoUrl: string }> {
  const learningsDir = opts.learningsDir ?? DEFAULT_LEARNINGS_DIR;

  // ── 步骤 1：获取 MR 数据 ────────────────────────────────
  const fetchSpinner = spinner('Fetching MR data...');
  fetchSpinner.start();

  let mr: MRData;
  try {
    mr = await fetchMR(opts.url);
    fetchSpinner.succeed('MR data fetched');
  } catch (err: unknown) {
    fetchSpinner.fail('MR data fetch failed');
    throw err;
  }

  // ── 步骤 2：AI 分析 ────────────────────────────────────
  const aiSpinner = spinner('AI analysis in progress...');
  aiSpinner.start();

  let learningContent: string;
  try {
    learningContent = await callClaude(extractMRLearningPrompt(mr));
    aiSpinner.succeed('AI analysis complete');
  } catch (err: unknown) {
    aiSpinner.fail('AI analysis failed');
    throw err;
  }

  // ── 步骤 3：解析 learning 草稿 + dedup ─────────────────
  // AI 可能用 markdown 代码块包裹输出，先剥离
  learningContent = learningContent
    .replace(/^```(?:markdown|md|yaml)?\s*\n/m, '')
    .replace(/\n```\s*$/, '');
  // AI 可能在 frontmatter 前输出对话性废话，截取从第一个 `---` 开始的内容
  const frontmatterStart = learningContent.indexOf('---');
  if (frontmatterStart > 0) {
    learningContent = learningContent.slice(frontmatterStart);
  }
  const parsed = matter(learningContent);
  const learningTitle = (parsed.data['title'] as string | undefined) ?? mr.title;

  const draftKeywords = extractKeywords(learningContent);
  const supersededEntries = await findSupersededLearnings(draftKeywords, learningsDir);
  const supersedes = supersededEntries
    .filter((entry) => entry.overlap >= SUPERSEDE_THRESHOLD)
    .map((entry) => entry.filename);

  const learning: LearningDraft = {
    title: learningTitle,
    content: learningContent,
    supersedes: supersedes.length > 0 ? supersedes : undefined,
  };

  // ── 步骤 4：打印摘要 ────────────────────────────────────
  log.info(`✅ Learning draft generated: ${learningTitle}`);

  const tags = parsed.data['tags'] as string[] | undefined;
  if (tags && tags.length > 0) {
    log.info(`   Tags: ${tags.join(', ')}`);
  }

  if (supersedes.length > 0) {
    log.warn(`⚠️  Found ${supersedes.length} overlapping session learnings, marking as superseded`);
  }

  // ── 步骤 5：交互确认 ───────────────────────────────────
  let acceptLearning = true;

  if (!opts.all) {
    acceptLearning = await promptConfirm('Accept learning? [Y/n]');
  }

  // ── 步骤 6：写文件 ─────────────────────────────────────
  if (!opts.dryRun && acceptLearning) {
    await writeLearning(learning, opts.outputDir, opts.repoPath);
  }

  // 推断仓库 URL
  const repoUrl = extractRepoUrlFromMrUrl(opts.url);

  return {
    learning: acceptLearning ? learning : undefined,
    repoUrl,
  };
}

/**
 * 将 learning 草稿写入磁盘。
 *
 * outputDir 优先；否则尝试写到 repoPath/learnings/；两者均未设则打印警告跳过。
 *
 * @param draft      LearningDraft 对象
 * @param outputDir  输出目录（可选）
 * @param repoPath   团队 repo 根路径（可选）
 */
async function writeLearning(
  draft: LearningDraft,
  outputDir?: string,
  repoPath?: string,
): Promise<void> {
  if (outputDir) {
    await fs.mkdir(outputDir, { recursive: true });
    const filePath = path.join(outputDir, 'learning.md');
    await fs.writeFile(filePath, draft.content, 'utf-8');
    log.info(`Learning written: ${filePath}`);
    return;
  }

  if (repoPath) {
    const learningsDir = path.join(repoPath, 'learnings');
    await fs.mkdir(learningsDir, { recursive: true });
    const datePrefix = new Date().toISOString().slice(0, 10);
    // 将标题转为合法文件名：取前 40 字符，替换非法字符为连字符
    const safeTitle = draft.title
      .slice(0, 40)
      .replace(/[^a-zA-Z0-9一-鿿_-]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '');
    const filename = `${datePrefix}-${safeTitle}.md`;
    const filePath = path.join(learningsDir, filename);
    await fs.writeFile(filePath, draft.content, 'utf-8');
    log.info(`Learning written: ${filePath}`);
    return;
  }

  log.warn('No outputDir or repoPath specified, learning draft not saved to disk');
}
