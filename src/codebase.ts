import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import matter from 'gray-matter';

import { callClaude } from './utils/ai-client.js';
import { createGit } from './utils/git.js';
import { log } from './utils/logger.js';
import type { CodebaseSuggestion, LintIssue, LintReport } from './types.js';

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

/** learnings 目录最多读取的 .md 文件数量。 */
const LEARNINGS_MAX_FILES = 50;

/** lint 报告中展示的高频 tag 数量上限。 */
const TOP_TAGS_COUNT = 10;

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
 * 聚合 learnings 相关上下文，用于注入 codebase.md 生成 prompt。
 *
 * 若有 learningsSuggestions，则拼出最近 MR 建议小节；
 * 若有 learningsDir 且目录存在，则统计 frontmatter tags 高频词。
 *
 * @param opts.learningsSuggestions  来自 P4.4 的 codebase suggestions
 * @param opts.learningsDir          learnings 目录路径
 * @returns                          拼接好的上下文段落，无内容时返回空字符串
 */
async function gatherLearningsContext(opts: {
  learningsSuggestions?: CodebaseSuggestion[];
  learningsDir?: string;
}): Promise<string> {
  const { learningsSuggestions, learningsDir } = opts;

  if (!learningsSuggestions?.length && !learningsDir) {
    return '';
  }

  const parts: string[] = [];

  // ── 最近 MR 提炼建议 ────────────────────────────────────
  if (learningsSuggestions && learningsSuggestions.length > 0) {
    const lines = learningsSuggestions.map(
      (s) => `- [${s.action}] ${s.section}: ${s.content.slice(0, 200)}`,
    );
    parts.push(`## 最近 MR 提炼建议（参考）\n${lines.join('\n')}`);
  }

  // ── learnings 目录高频 tags ──────────────────────────────
  if (learningsDir && fs.existsSync(learningsDir)) {
    try {
      const entries = fs.readdirSync(learningsDir);
      const tagFreq: Record<string, number> = {};
      let fileCount = 0;

      for (const entry of entries) {
        if (fileCount >= LEARNINGS_MAX_FILES) break;
        if (!entry.endsWith('.md')) continue;

        try {
          const filePath = path.join(learningsDir, entry);
          const raw = fs.readFileSync(filePath, 'utf-8');
          const parsed = matter(raw);
          const tags: unknown = parsed.data['tags'];
          if (Array.isArray(tags)) {
            for (const tag of tags) {
              if (typeof tag === 'string') {
                tagFreq[tag] = (tagFreq[tag] ?? 0) + 1;
              }
            }
          }
          fileCount++;
        } catch (err) {
          log.debug(`gatherLearningsContext: 解析 ${entry} 失败 — ${String(err)}`);
        }
      }

      const topTags = Object.entries(tagFreq)
        .sort((a, b) => b[1] - a[1])
        .slice(0, TOP_TAGS_COUNT)
        .map(([tag, count]) => `${tag}(${count})`)
        .join(', ');

      if (topTags) {
        parts.push(`## Learnings 高频标签\n高频标签：${topTags}`);
      }
    } catch (err) {
      log.debug(`gatherLearningsContext: 读取 learningsDir 失败 — ${String(err)}`);
    }
  }

  return parts.join('\n\n');
}

/**
 * 生成 codebase.md 的 YAML frontmatter 头部。
 *
 * @param repoPath  仓库根目录绝对路径
 * @returns         frontmatter 字符串（含尾部换行）
 */
function buildFrontmatter(repoPath: string): string {
  const now = new Date().toISOString();
  return [
    '---',
    'title: Codebase 概览',
    `lastUpdated: ${now}`,
    `source: ${repoPath}`,
    'generator: teamai-cli',
    'schemaVersion: 1',
    '---',
    '',
    '',
  ].join('\n');
}

/**
 * 若 Markdown 内容顶部存在 frontmatter（以 `---\n` 开头），则剥离并返回正文。
 *
 * @param md  原始 Markdown 字符串
 * @returns   剥离 frontmatter 后的正文
 */
function stripExistingFrontmatter(md: string): string {
  if (!md.startsWith('---\n')) {
    return md;
  }
  // 找到第二个 `---` 行的结束位置
  const secondDash = md.indexOf('\n---\n', 4);
  if (secondDash === -1) {
    return md;
  }
  // 跳过 `\n---\n`（5 个字符），再跳过可能的空行
  const afterFrontmatter = md.slice(secondDash + 5);
  return afterFrontmatter.replace(/^\n+/, '');
}

/**
 * 扫描 git 仓库信息，用 AI 生成 codebase.md 初稿。
 *
 * @param opts.repoPath              仓库根目录绝对路径
 * @param opts.existingCodebaseMd    已有 codebase.md 内容（存在时执行增量更新）
 * @param opts.learningsSuggestions  来自 P4.4 的 codebase suggestions（已 apply 后的版本仍可作为提示）
 * @param opts.learningsDir          learnings 目录路径，函数会读取该目录下所有 .md 文件提取 frontmatter tags 做高频统计
 * @returns                          AI 生成的 codebase.md 完整内容（含 frontmatter）
 */
export async function generateCodebaseMd(opts: {
  repoPath: string;
  existingCodebaseMd?: string;
  /** 来自 P4.4 的 codebase suggestions（已 apply 后的版本仍可作为提示） */
  learningsSuggestions?: CodebaseSuggestion[];
  /** learnings 目录路径，函数会读取该目录下所有 .md 文件提取 frontmatter tags 做高频统计 */
  learningsDir?: string;
}): Promise<string> {
  const { repoPath, existingCodebaseMd, learningsSuggestions, learningsDir } = opts;

  log.debug(`generateCodebaseMd: 收集仓库上下文，路径=${repoPath}`);
  const context = await gatherRepoContext(repoPath);

  // 聚合 learnings 上下文（可能为空）
  const learningsContext = await gatherLearningsContext({ learningsSuggestions, learningsDir });
  const learningsInjection =
    learningsContext
      ? `\n以下是最近 MR 提炼出的更新提示与团队关注点，请融合进文档相应章节：\n<learnings>\n${learningsContext}\n</learnings>\n`
      : '';

  let prompt: string;

  if (existingCodebaseMd) {
    // 增量更新模式
    prompt =
      `已有 codebase.md 如下，请根据新的仓库上下文更新它（保留已有内容，补充或修正变更部分）：\n` +
      `<existing>\n${existingCodebaseMd}\n</existing>\n\n` +
      `新的仓库上下文：\n<context>\n${context}\n</context>\n` +
      learningsInjection +
      `\n输出完整更新后的 codebase.md，不要加额外说明。`;
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
      `## 架构决策与权衡\n` +
      `（列出 3-5 条主要设计选择的"为什么"，格式如"为什么选择 X 而不是 Y：原因说明"）\n\n` +
      `## 已知限制与演进方向\n` +
      `（列出 3-5 条当前实现的局限与下一步可能的优化）\n\n` +
      `## 测试覆盖\n` +
      `（表格列出测试层级、用例数、覆盖率）\n\n` +
      `## 备注\n` +
      `- ✅ 有文档佐证的信息\n` +
      `- ⚠️ 基于代码结构推断的信息\n\n` +
      `== 以上是格式骨架，根据实际仓库内容填充。若某章节确实无法从上下文推断，可简略但不得省略章节标题。==\n\n` +
      `---\n` +
      `以下是仓库上下文：\n` +
      `<context>\n${context}\n</context>` +
      learningsInjection;
  }

  log.debug('generateCodebaseMd: 调用 AI 生成文档');
  const rawResult = await callClaude(prompt);

  // 剥离 AI 可能自行附加的 frontmatter，再 prepend 标准 frontmatter
  let body = stripExistingFrontmatter(rawResult);

  // 去除 AI 可能在首个标题前输出的过渡性文字（如"文件写入需要权限确认…"）
  const h1Idx = body.indexOf('# ');
  const h2Idx = body.indexOf('## ');
  const titleIdx = h1Idx >= 0 ? h1Idx : h2Idx;
  if (titleIdx > 0) {
    body = body.slice(titleIdx);
  } else if (titleIdx < 0) {
    // 完全没有标题，尝试去除明显的 AI 过渡文字行
    body = body.replace(/^.*(?:文件写入|请授权|权限确认|以下是生成的|完整内容|文档已准备|由于无法).*\n*/gm, '').trim();
  }

  return buildFrontmatter(repoPath) + body;
}

/**
 * 基于 codebase.md 生成精简索引文档。
 * 索引让 LLM 跨会话快速定位章节，无需重读全文。
 *
 * @param codebaseMd  完整 codebase.md 内容（包含 frontmatter）
 * @returns           Markdown 索引（含表格：章节 / 一句摘要 / 关键词）
 */
export async function generateCodebaseIndex(codebaseMd: string): Promise<string> {
  const prompt =
    `请分析以下 codebase.md 文档，提取所有二级章节（## 开头的标题），` +
    `为每个章节生成：一句摘要（≤30 字）和 3-5 个关键词。\n\n` +
    `【输出格式要求】严格输出 JSON 数组，不要加任何额外说明：\n` +
    `[{"section": "章节名", "summary": "摘要", "keywords": ["词1", "词2", "词3"]}]\n\n` +
    `文档内容：\n<codebase>\n${codebaseMd}\n</codebase>`;

  log.debug('generateCodebaseIndex: 调用 AI 生成索引');
  const raw = await callClaude(prompt);

  const now = new Date().toISOString();
  const frontmatter = `---\ntitle: Codebase 索引\nlastUpdated: ${now}\n---\n\n`;

  interface IndexEntry {
    section: string;
    summary: string;
    keywords: string[];
  }

  try {
    // 从输出中提取 JSON（AI 可能包裹在代码块里）
    const jsonMatch = raw.match(/\[[\s\S]*\]/);
    if (!jsonMatch) {
      throw new Error('未找到 JSON 数组');
    }
    const entries: IndexEntry[] = JSON.parse(jsonMatch[0]);

    const tableRows = entries
      .map((e) => `| ${e.section} | ${e.summary} | ${e.keywords.join(', ')} |`)
      .join('\n');

    return (
      frontmatter +
      `# Codebase 索引\n\n` +
      `| 章节 | 摘要 | 关键词 |\n` +
      `| ---- | ---- | ------ |\n` +
      tableRows +
      '\n'
    );
  } catch (err) {
    log.debug(`generateCodebaseIndex: 解析 JSON 失败 — ${String(err)}，原始输出：${raw.slice(0, 200)}`);
    return (
      frontmatter +
      `# Codebase 索引\n\n` +
      `> ⚠️ 索引生成失败，请重新运行 \`teamai import --workspace\` 以重新生成。\n`
    );
  }
}

/**
 * 健康检查：让 AI 检测 codebase.md 中的矛盾、过时声明、孤儿模块、缺失关键概念。
 *
 * 不修改文档，只返回问题清单。
 *
 * @param codebaseMd  完整 codebase.md 内容
 * @returns           LintReport，含 issues 数组
 */
export async function lintCodebaseMd(codebaseMd: string): Promise<LintReport> {
  const prompt =
    `请对以下 codebase.md 文档做健康检查，检测：\n` +
    `1. 矛盾（contradiction）：文档内部自相矛盾的陈述\n` +
    `2. 过时（outdated）：可能已经不准确的声明\n` +
    `3. 孤儿（orphan）：提到了但文档其他地方没有解释的模块或概念\n` +
    `4. 缺失（missing）：重要章节或关键概念未被覆盖\n\n` +
    `【输出格式要求】严格输出 JSON，不要加任何额外说明：\n` +
    `{"summary": "一句话总结", "issues": [` +
    `{"severity": "high|medium|low", "category": "contradiction|outdated|orphan|missing", ` +
    `"location": "章节名或行号区间", "description": "问题描述", "suggestion": "修复建议"}` +
    `]}\n\n` +
    `文档内容：\n<codebase>\n${codebaseMd}\n</codebase>`;

  log.debug('lintCodebaseMd: 调用 AI 做 lint 检查');

  try {
    const raw = await callClaude(prompt);

    // 从输出中提取 JSON 对象
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error('未找到 JSON 对象');
    }
    const parsed = JSON.parse(jsonMatch[0]) as { summary?: string; issues?: LintIssue[] };
    return {
      issues: Array.isArray(parsed.issues) ? parsed.issues : [],
      summary: typeof parsed.summary === 'string' ? parsed.summary : '检查完成',
    };
  } catch (err) {
    log.debug(`lintCodebaseMd: 解析失败 — ${String(err)}`);
    return { issues: [], summary: '解析失败，无法 lint' };
  }
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
