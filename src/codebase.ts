import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { callClaude } from './utils/ai-client.js';
import { createGit } from './utils/git.js';
import { log } from './utils/logger.js';
import type { CodebaseSuggestion } from './types.js';

/** 文件扫描截断上限（字符数）。 */
const FILE_TREE_MAX_CHARS = 5000;

/** 架构文档读取上限（字符数）。 */
const DOC_MAX_CHARS = 2000;

/** docs/ 目录下最多读取的 .md 文件数量。 */
const DOCS_MAX_FILES = 3;

/** git log 读取条数。 */
const GIT_LOG_MAX_COUNT = 20;

/** package.json / types 文件读取上限（字符数）。 */
const META_MAX_CHARS = 2500;

/**
 * 收集 git 仓库上下文信息。
 *
 * 包含：最近 commit 记录、文件树结构、package.json 依赖、
 * 入口文件命令注册、types 关键接口、README/ARCHITECTURE/docs 摘要。
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

  // ── 文件树结构（加大深度，过滤噪音目录）──────────────────
  try {
    const rawTree = execSync(
      'find . -maxdepth 4' +
        ' -not -path "*/.git/*"' +
        ' -not -path "*/node_modules/*"' +
        ' -not -path "*/__pycache__/*"' +
        ' -not -path "*/dist/*"' +
        ' -not -path "*/.claude/worktrees/*"' +
        ' -not -name "*.js.map"',
      { cwd: repoPath, encoding: 'utf-8' },
    );
    const truncated =
      rawTree.length > FILE_TREE_MAX_CHARS
        ? rawTree.slice(0, FILE_TREE_MAX_CHARS) + '\n…（已截断）'
        : rawTree;
    parts.push(`## 文件树（maxdepth=4，已过滤 dist/node_modules）\n${truncated}`);
  } catch (err) {
    log.debug(`gatherRepoContext: find 失败 — ${String(err)}`);
  }

  // ── package.json：获取依赖和 scripts ────────────────────
  const pkgPath = path.join(repoPath, 'package.json');
  if (fs.existsSync(pkgPath)) {
    try {
      const raw = fs.readFileSync(pkgPath, 'utf-8');
      const excerpt = raw.length > META_MAX_CHARS ? raw.slice(0, META_MAX_CHARS) + '\n…' : raw;
      parts.push(`## package.json\n\`\`\`json\n${excerpt}\n\`\`\``);
    } catch (err) {
      log.debug(`gatherRepoContext: 读取 package.json 失败 — ${String(err)}`);
    }
  }

  // ── 入口文件命令注册（index.ts / main.py 等）────────────
  for (const candidate of ['src/index.ts', 'src/main.ts', 'index.ts', 'main.py']) {
    const entryPath = path.join(repoPath, candidate);
    if (fs.existsSync(entryPath)) {
      try {
        const raw = fs.readFileSync(entryPath, 'utf-8');
        const excerpt = raw.length > META_MAX_CHARS ? raw.slice(0, META_MAX_CHARS) + '\n…' : raw;
        parts.push(`## 入口文件：${candidate}\n\`\`\`typescript\n${excerpt}\n\`\`\``);
        break;
      } catch (err) {
        log.debug(`gatherRepoContext: 读取 ${candidate} 失败 — ${String(err)}`);
      }
    }
  }

  // ── 类型定义文件（types.ts）────────────────────────────
  for (const candidate of ['src/types.ts', 'src/types/index.ts', 'types.py']) {
    const typesPath = path.join(repoPath, candidate);
    if (fs.existsSync(typesPath)) {
      try {
        const raw = fs.readFileSync(typesPath, 'utf-8');
        const excerpt = raw.length > META_MAX_CHARS ? raw.slice(0, META_MAX_CHARS) + '\n…' : raw;
        parts.push(`## 类型定义：${candidate}\n\`\`\`typescript\n${excerpt}\n\`\`\``);
        break;
      } catch (err) {
        log.debug(`gatherRepoContext: 读取 ${candidate} 失败 — ${String(err)}`);
      }
    }
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
        if (count >= DOCS_MAX_FILES) break;
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
    if (!fs.existsSync(docPath)) continue;
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
    // 全量生成模式：提供完整格式骨架，引导 AI 生成 A1 级别文档
    prompt =
      `你是技术文档专家。根据以下 git 仓库信息，生成一份结构完整的 codebase.md 技术全景文档。\n` +
      `【必须】用中文撰写，输出纯 Markdown（不要加额外说明）。\n\n` +
      `== 格式骨架（严格按此结构生成，每个章节都必须包含）==\n\n` +
      `# Codebase 概览\n\n` +
      `## 项目概述\n` +
      `（2-4 句描述项目是什么、做什么，然后列出核心能力 bullet list，每条带 emoji）\n` +
      `核心能力：\n` +
      `- 🔄 **功能名**：简短说明\n` +
      `- 📥 **功能名**：简短说明\n\n` +
      `## 技术栈\n` +
      `（用表格，含版本信息）\n` +
      `| 维度 | 技术 |\n` +
      `|------|------|\n` +
      `| 语言 | **语言** 版本+ |\n` +
      `| 运行时 | **运行时** 版本 |\n` +
      `（继续列出构建、测试、关键依赖库等）\n\n` +
      `## 目录结构与模块职责\n` +
      `（用带分组框的树形结构，相关文件归为一组，格式如下）\n` +
      `\`\`\`\n` +
      `项目根/\n` +
      `├── src/\n` +
      `│   ├── index.ts                    # CLI 入口，注册所有命令\n` +
      `│   │\n` +
      `│   ├── ┌─ 功能分组名 ────────────────────────────────┐\n` +
      `│   ├── │ fileA.ts                  # 功能说明                │\n` +
      `│   ├── │ fileB.ts                  # 功能说明                │\n` +
      `│   ├── └─────────────────────────────────────────────────────┘\n` +
      `│   │\n` +
      `│   ├── ┌─ 另一个功能分组 ─────────────────────────────┐\n` +
      `│   ├── │ dir/\n` +
      `│   ├── │   ├── fileC.ts            # 功能说明                │\n` +
      `│   ├── └─────────────────────────────────────────────────────┘\n` +
      `\`\`\`\n\n` +
      `## 数据与配置\n` +
      `（列出关键配置文件和运行时数据目录的路径树，说明每个目录/文件的用途）\n\n` +
      `## 核心数据流\n` +
      `（列出 2-4 条核心业务流程，每条用带缩进和 → 的流程图格式）\n` +
      `### 1. 流程名称\n` +
      `\`\`\`\n` +
      `触发点（用户执行 xxx 命令）\n` +
      `    │\n` +
      `    ├─ 1. 步骤描述\n` +
      `    │   └─ 子步骤\n` +
      `    ├─ 2. 步骤描述 → 结果\n` +
      `    └─ ✅ 完成\n` +
      `\`\`\`\n\n` +
      `## 关键接口与抽象\n` +
      `（列出项目中最重要的 interface/abstract class，用代码块展示签名，并说明实现）\n\n` +
      `## 配置系统\n` +
      `（说明配置优先级、scope 检测逻辑、关键配置结构示例）\n\n` +
      `## 性能与可靠性\n` +
      `（表格列出关键性能设计：并发控制、超时、缓存、降级等）\n\n` +
      `## 测试覆盖\n` +
      `（表格列出测试层级、用例数、覆盖率）\n\n` +
      `## 备注\n` +
      `- ✅ 有文档佐证的信息\n` +
      `- ⚠️ 基于代码结构推断的信息\n\n` +
      `== 以上是格式骨架，根据实际仓库内容填充。若某章节确实无法从上下文推断，可简略但不得省略章节标题。==\n\n` +
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
    `【输出格式要求】\n` +
    `- 直接输出完整的 Markdown 文档，从文档第一行（通常是 # 开头的标题）开始\n` +
    `- 不要输出任何前缀说明、总结、"我已经..."、"更新内容包括..."等描述性文字\n` +
    `- 保留原文档的所有已有内容，仅按建议新增或修改对应部分\n` +
    `- 输出必须是可以直接写入文件的完整 codebase.md`;

  log.debug(`applyCodebaseSuggestions: 应用 ${effectiveSuggestions.length} 条建议`);
  const result = await callClaude(prompt);
  return result;
}
