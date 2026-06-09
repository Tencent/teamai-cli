import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { callClaude } from './utils/ai-client.js';
import { createGit } from './utils/git.js';
import { log } from './utils/logger.js';
import type { CodebaseSuggestion } from './types.js';

/** 文件扫描截断上限（字符数）。 */
const FILE_TREE_MAX_CHARS = 3000;

/** 架构文档读取上限（字符数）。 */
const DOC_MAX_CHARS = 1000;

/** docs/ 目录下最多读取的 .md 文件数量。 */
const DOCS_MAX_FILES = 3;

/** git log 读取条数。 */
const GIT_LOG_MAX_COUNT = 20;

/**
 * 收集 git 仓库上下文信息。
 *
 * 包含：最近 commit 记录、文件树结构、README/ARCHITECTURE/docs 下架构文档摘要。
 *
 * @param repoPath  仓库根目录绝对路径
 * @returns         拼接好的上下文字符串
 */
async function gatherRepoContext(repoPath: string): Promise<string> {
  const parts: string[] = [];

  // ── 最近 commit 记录 ────────────────────────────────────
  try {
    const git = createGit(repoPath);
    const logResult = await git.log({ maxCount: GIT_LOG_MAX_COUNT });
    const commitMessages = logResult.all
      .map((c) => `- ${c.date.slice(0, 10)} ${c.message}`)
      .join('\n');
    parts.push(`## 最近 ${GIT_LOG_MAX_COUNT} 条 Commit\n${commitMessages}`);
  } catch (err) {
    log.debug(`gatherRepoContext: git log 失败 — ${String(err)}`);
  }

  // ── 文件树结构 ──────────────────────────────────────────
  try {
    const rawTree = execSync(
      'find . -maxdepth 3' +
        ' -not -path "*/.git/*"' +
        ' -not -path "*/node_modules/*"' +
        ' -not -path "*/__pycache__/*"',
      { cwd: repoPath, encoding: 'utf-8' },
    );
    const truncated =
      rawTree.length > FILE_TREE_MAX_CHARS
        ? rawTree.slice(0, FILE_TREE_MAX_CHARS) + '\n…（已截断）'
        : rawTree;
    parts.push(`## 文件树（maxdepth=3）\n${truncated}`);
  } catch (err) {
    log.debug(`gatherRepoContext: find 失败 — ${String(err)}`);
  }

  // ── 架构文档摘要 ────────────────────────────────────────
  const docCandidates: string[] = [
    path.join(repoPath, 'README.md'),
    path.join(repoPath, 'ARCHITECTURE.md'),
  ];

  // 扫描 docs/ 下最多 DOCS_MAX_FILES 个 .md 文件
  const docsDir = path.join(repoPath, 'docs');
  if (fs.existsSync(docsDir)) {
    try {
      const entries = fs.readdirSync(docsDir);
      let count = 0;
      for (const entry of entries) {
        if (count >= DOCS_MAX_FILES) {
          break;
        }
        if (entry.endsWith('.md')) {
          docCandidates.push(path.join(docsDir, entry));
          count++;
        }
      }
    } catch (err) {
      log.debug(`gatherRepoContext: 读取 docs/ 失败 — ${String(err)}`);
    }
  }

  for (const docPath of docCandidates) {
    if (!fs.existsSync(docPath)) {
      continue;
    }
    try {
      const raw = fs.readFileSync(docPath, 'utf-8');
      const excerpt =
        raw.length > DOC_MAX_CHARS ? raw.slice(0, DOC_MAX_CHARS) + '\n…（已截断）' : raw;
      const relPath = path.relative(repoPath, docPath);
      parts.push(`## 文档摘要：${relPath}\n${excerpt}`);
    } catch (err) {
      log.debug(`gatherRepoContext: 读取 ${docPath} 失败 — ${String(err)}`);
    }
  }

  return parts.join('\n\n');
}

/**
 * 扫描 git 仓库信息，用 AI 生成 codebase.md 初稿。
 *
 * @param opts.repoPath           仓库根目录绝对路径
 * @param opts.existingCodebaseMd 已有 codebase.md 内容（存在时执行增量更新）
 * @returns                       AI 生成的 codebase.md 完整内容
 */
export async function generateCodebaseMd(opts: {
  repoPath: string;
  existingCodebaseMd?: string;
}): Promise<string> {
  const { repoPath, existingCodebaseMd } = opts;

  log.debug(`generateCodebaseMd: 收集仓库上下文，路径=${repoPath}`);
  const context = await gatherRepoContext(repoPath);

  let prompt: string;

  if (existingCodebaseMd) {
    // 增量更新模式
    prompt =
      `已有 codebase.md 如下，请根据新的仓库上下文更新它（保留已有内容，补充或修正变更部分）：\n` +
      `<existing>\n${existingCodebaseMd}\n</existing>\n\n` +
      `新的仓库上下文：\n<context>\n${context}\n</context>\n\n` +
      `输出完整更新后的 codebase.md，不要加额外说明。`;
  } else {
    // 全量生成模式
    prompt =
      `你是技术文档专家。根据以下 git 仓库信息，生成一份 codebase.md。\n` +
      `【必须】用中文撰写，输出纯 Markdown（不要加额外说明）。\n\n` +
      `格式要求：\n` +
      `# Codebase 概览\n\n` +
      `## 项目概述\n` +
      `（1-3 句描述项目是什么、做什么）\n\n` +
      `## 技术栈\n` +
      `（列表）\n\n` +
      `## 主要模块\n` +
      `（每个模块一行：**模块名** — 功能说明）\n\n` +
      `## 关键路径\n` +
      `（2-3 条核心业务流程）\n\n` +
      `## 备注\n` +
      `- ✅ 有文档佐证的信息\n` +
      `- ⚠️ 基于代码结构推断的信息\n\n` +
      `---\n` +
      `以下是仓库上下文：\n` +
      `<context>\n${context}\n</context>`;
  }

  log.debug('generateCodebaseMd: 调用 AI 生成文档');
  const result = await callClaude(prompt);
  return result;
}

/**
 * 将 MR 提炼的变更建议应用到现有 codebase.md 内容。
 *
 * @param current     当前 codebase.md 完整内容
 * @param suggestions MR 提炼的变更建议列表
 * @returns           AI 合并建议后的 codebase.md 完整内容
 */
export async function applyCodebaseSuggestions(
  current: string,
  suggestions: CodebaseSuggestion[],
): Promise<string> {
  // 过滤掉 action='noop' 的建议
  const effectiveSuggestions = suggestions.filter((s) => s.action !== 'noop');

  if (effectiveSuggestions.length === 0) {
    log.debug('applyCodebaseSuggestions: 无有效建议，直接返回原内容');
    return current;
  }

  const suggestionsJson = JSON.stringify(effectiveSuggestions, null, 2);

  const prompt =
    `请将以下变更建议合并到 codebase.md 中，保持原有格式和风格：\n\n` +
    `当前 codebase.md：\n<current>\n${current}\n</current>\n\n` +
    `变更建议（JSON 列表）：\n<suggestions>\n${suggestionsJson}\n</suggestions>\n\n` +
    `输出完整更新后的 codebase.md，不要加额外说明。`;

  log.debug(`applyCodebaseSuggestions: 应用 ${effectiveSuggestions.length} 条建议`);
  const result = await callClaude(prompt);
  return result;
}
