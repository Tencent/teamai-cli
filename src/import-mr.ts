import fs from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline/promises';

import matter from 'gray-matter';

import { fetchGitHubPR } from './providers/github/mr-fetch.js';
import { fetchTGitMR } from './providers/tgit/mr-fetch.js';
import type { MRData, LearningDraft, CodebaseSuggestion } from './types.js';
import { callClaude, callClaudeParallel } from './utils/ai-client.js';
import { applyCodebaseSuggestions } from './codebase.js';
import { extractKeywords, findSupersededLearnings } from './utils/dedup.js';
import { log, spinner } from './utils/logger.js';

/** 默认 learning 存放目录。 */
const DEFAULT_LEARNINGS_DIR = path.join(process.env.HOME ?? '/tmp', '.teamai', 'learnings');

/** dedup 相似度阈值。 */
const SUPERSEDE_THRESHOLD = 0.6;

/**
 * 根据 URL 自动判断 provider 并获取 MR 数据。
 *
 * @param url  MR / PR 的完整 URL
 * @returns    标准化的 MRData 对象
 * @throws     URL 不属于已知 provider 时抛出 Error
 */
async function fetchMR(url: string): Promise<MRData> {
  if (url.includes('github.com')) {
    return fetchGitHubPR(url);
  }
  if (url.includes('git.woa.com')) {
    return fetchTGitMR(url);
  }
  throw new Error(`Unsupported MR URL: ${url}，仅支持 GitHub 和 TGit`);
}

/**
 * 构造 learning 提炼 prompt。
 *
 * @param mr  MR 数据对象
 * @returns   用于 callClaude 的完整提示词字符串
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
 * 构造 codebase.md 建议提炼 prompt。
 *
 * 传入现有 codebase.md 内容时，AI 会参考其格式和粒度生成风格一致的增量条目；
 * 未传入时使用示例格式引导。
 *
 * @param mr                  MR 数据对象
 * @param existingCodebaseMd  现有 codebase.md 全文（可选）
 * @returns                   用于 callClaude 的完整提示词字符串
 */
function extractCodebaseSuggestionPrompt(mr: MRData, existingCodebaseMd?: string): string {
  const diff2000 = mr.diff.slice(0, 2000);

  // 构造现有文档上下文：有则注入全文，无则给一个示例格式
  const existingContext = existingCodebaseMd
    ? `以下是现有的 codebase.md 全文，你必须参考其格式、粒度和分组逻辑：
<existing_codebase>
${existingCodebaseMd.slice(0, 4000)}
</existing_codebase>`
    : `参考以下格式示例（按功能分组，每条含路径和功能说明）：
## 主要模块
- **src/utils/git.ts** — git 操作工具（simple-git 封装）
- **src/utils/fs.ts** — 文件系统工具（fs-extra 封装）
- **src/providers/** — Git provider 抽象层（GitHub / TGit）
- **src/resources/** — 六类资源处理器（skills/rules/docs/env/wiki/agents）`;

  return `分析以下 MR 变更，判断是否需要更新 codebase.md。

${existingContext}

请返回严格 JSON（不要加 markdown 代码块）：
{"needsUpdate":true,"suggestions":[{"section":"主要模块","action":"add","content":"多行 Markdown 条目，见格式要求"}]}
或
{"needsUpdate":false,"suggestions":[]}

action 取值：
- "add"：在该 section 末尾追加新条目
- "update"：替换该 section 中某条已有内容（content 中包含原文和新文）
- "noop"：无需变更

判断规则：
- 有新文件/模块 → add "主要模块"
- 有接口/调用链变更 → add/update "关键路径"（用 → 串联的流程描述）
- 有架构决策 → add "备注"（带 ✅ 标注）
- 纯内部实现（重构、bug fix、性能优化）→ needsUpdate=false

【格式要求】严格参照现有 codebase.md 的风格和粒度：
1. 若现有条目是目录级（**src/utils/**），新增条目也用目录级
2. 若现有条目是文件级（**src/utils/git.ts**），新增条目也用文件级
3. 同一个 MR 新增的相关文件可合并为一条 suggestion 的多行 content，而非每文件一条
4. content 字段使用 Markdown 列表格式（每行 "- **路径** — 说明"）
5. 关键路径的 content 使用 "N. **触发点**：步骤1 → 步骤2 → 结果" 格式

MR 标题：${mr.title}
MR 描述：${mr.description}
关键 diff（前 2000 字）：${diff2000}`;
}

/**
 * 交互式询问用户是否确认某项操作。
 *
 * @param question  询问文本，末尾不需要加空格
 * @returns         用户输入 'n'/'N' 时返回 false，其余（包括直接回车）返回 true
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
 * 交互式 codebase 建议审阅循环。
 *
 * 展示当前建议摘要，询问用户：
 *   [y] 直接确认并 apply
 *   [n] 跳过（不 apply）
 *   [其他文字] 视为修改意见，调用 AI 修订建议后重新展示，循环直到用户输入 y 或 n
 *
 * @param suggestions   当前 codebase 建议列表
 * @param mr            MR 数据（用于 AI 修订上下文）
 * @returns             最终确认的建议列表（用户跳过时返回 null）
 */
async function reviewCodebaseSuggestions(
  suggestions: CodebaseSuggestion[],
  mr: MRData,
): Promise<CodebaseSuggestion[] | null> {
  let current = suggestions;

  while (true) {
    // 展示当前建议摘要
    log.info('');
    log.info('📋 当前 codebase.md 更新建议：');
    for (const s of current) {
      log.info(`  [${s.action}] ${s.section}: ${s.content.slice(0, 80).replace(/\n/g, ' ')}…`);
    }
    log.info('');

    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    let answer: string;
    try {
      answer = await rl.question('确认应用？[y/n] 或输入修改意见后按回车让 AI 调整：');
    } finally {
      rl.close();
    }

    const trimmed = answer.trim().toLowerCase();
    if (trimmed === 'y' || trimmed === '') {
      return current;
    }
    if (trimmed === 'n') {
      return null;
    }

    // 用户给出了修改意见，调用 AI 修订
    const reviseSpinner = spinner('AI 根据意见修订建议中...').start();
    try {
      const revisePrompt =
        `你是团队知识库维护者。请根据用户的修改意见，调整以下 codebase.md 更新建议。\n\n` +
        `MR 标题：${mr.title}\n` +
        `MR 描述：${mr.description.slice(0, 500)}\n\n` +
        `当前建议（JSON）：\n${JSON.stringify(current, null, 2)}\n\n` +
        `用户意见：${answer.trim()}\n\n` +
        `请返回修订后的建议，严格 JSON 格式（数组，结构与输入相同），不要加 markdown 代码块。`;

      const revised = await callClaude(revisePrompt);
      const jsonMatch = revised.match(/\[[\s\S]*\]/);
      const jsonStr = jsonMatch ? jsonMatch[0] : revised;
      current = JSON.parse(jsonStr) as CodebaseSuggestion[];
      reviseSpinner.succeed('建议已修订');
    } catch (err: unknown) {
      reviseSpinner.fail(`AI 修订失败：${(err as Error).message}`);
      log.info('保持原建议，请重新选择。');
    }
  }
}

/**
 * 从 MR URL 提炼 learning 草稿和 codebase.md 建议。
 *
 * 对应 P0.5 + P4.4 功能：获取 MR 数据 → 并行 AI 提炼 → dedup → 交互确认 → 写文件。
 *
 * @param opts.url               MR / PR 完整 URL（必填）
 * @param opts.learningsDir      用于 dedup 扫描的目录，默认 ~/.teamai/learnings
 * @param opts.all               跳过交互确认，全部接受
 * @param opts.outputDir         输出模式：写到此目录（learning.md + codebase-suggestions.json）
 * @param opts.repoPath          团队 repo 路径（outputDir 未设时写入 learnings/）
 * @param opts.existingCodebaseMd 现有 codebase.md 全文，用于生成风格一致的增量建议（可选）
 * @param opts.dryRun            试运行，不写磁盘
 * @returns                      提炼结果，包含 learning 草稿和 codebase 建议
 */
export async function importFromMR(opts: {
  url: string;
  learningsDir?: string;
  all?: boolean;
  outputDir?: string;
  repoPath?: string;
  existingCodebaseMd?: string;
  dryRun?: boolean;
}): Promise<{ learning?: LearningDraft; codebaseSuggestions?: CodebaseSuggestion[] }> {
  const learningsDir = opts.learningsDir ?? DEFAULT_LEARNINGS_DIR;

  // ── 步骤 1：获取 MR 数据 ────────────────────────────────
  const fetchSpinner = spinner('获取 MR 数据...');
  fetchSpinner.start();

  let mr: MRData;
  try {
    mr = await fetchMR(opts.url);
    fetchSpinner.succeed('MR 数据获取完成');
  } catch (err: unknown) {
    fetchSpinner.fail('MR 数据获取失败');
    throw err;
  }

  // ── 步骤 2：并行 AI 分析 ────────────────────────────────
  const aiSpinner = spinner('AI 分析中...');
  aiSpinner.start();

  type CodebaseSuggestionResponse = { needsUpdate: boolean; suggestions: CodebaseSuggestion[] };

  let learningContent: string;
  let codebaseResponse: CodebaseSuggestionResponse;

  try {
    const [rawLearning, rawCodebase] = await callClaudeParallel<string | CodebaseSuggestionResponse>(
      [
        {
          prompt: extractMRLearningPrompt(mr),
          parse: (output: string) => output,
        },
        {
          prompt: extractCodebaseSuggestionPrompt(mr, opts.existingCodebaseMd),
          parse: (output: string) => {
            try {
              // AI 可能在 JSON 前附加说明文字，提取第一个 { ... } 块
              const jsonMatch = output.match(/\{[\s\S]*\}/);
              const jsonStr = jsonMatch ? jsonMatch[0] : output;
              return JSON.parse(jsonStr) as CodebaseSuggestionResponse;
            } catch {
              log.debug(`codebase suggestion JSON 解析失败，原始输出：${output.slice(0, 200)}`);
              return { needsUpdate: false, suggestions: [] };
            }
          },
        },
      ],
    );
    learningContent = rawLearning as string;
    codebaseResponse = rawCodebase as CodebaseSuggestionResponse;
    aiSpinner.succeed('AI 分析完成');
  } catch (err: unknown) {
    aiSpinner.fail('AI 分析失败');
    throw err;
  }

  // ── 步骤 3：解析 learning 草稿 + dedup ─────────────────
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

  // ── 步骤 4：解析 codebase 建议 ─────────────────────────
  const codebaseSuggestions: CodebaseSuggestion[] = codebaseResponse.needsUpdate
    ? codebaseResponse.suggestions
    : [];

  // ── 步骤 5：打印摘要 ────────────────────────────────────
  log.info(`✅ Learning 草稿已生成：${learningTitle}`);

  const tags = parsed.data['tags'] as string[] | undefined;
  if (tags && tags.length > 0) {
    log.info(`   Tags: ${tags.join(', ')}`);
  }

  if (supersedes.length > 0) {
    log.warn(`⚠️  发现 ${supersedes.length} 条重叠的 session learning，将标记为 superseded`);
  }

  if (codebaseSuggestions.length > 0) {
    const sections = [...new Set(codebaseSuggestions.map((s) => s.section))].join('、');
    log.info(`📝 Codebase.md 建议 ${codebaseSuggestions.length} 条（涉及：${sections}）`);
  }

  // ── 步骤 6：交互确认 ───────────────────────────────────
  let acceptLearning = true;
  let finalSuggestions: CodebaseSuggestion[] | null = codebaseSuggestions.length > 0 ? codebaseSuggestions : null;

  if (!opts.all) {
    acceptLearning = await promptConfirm('是否接受 learning？[Y/n]');
    if (codebaseSuggestions.length > 0) {
      finalSuggestions = await reviewCodebaseSuggestions(codebaseSuggestions, mr);
    }
  }

  // ── 步骤 7：写文件 ─────────────────────────────────────
  if (!opts.dryRun) {
    if (acceptLearning) {
      await writeLearning(learning, opts.outputDir, opts.repoPath);
    }

    if (finalSuggestions && finalSuggestions.length > 0) {
      // --output 模式：写 suggestions.json + apply 到 codebase-after.md
      if (opts.outputDir) {
        const suggestionsPath = path.join(opts.outputDir, 'codebase-suggestions.json');
        await fs.writeFile(suggestionsPath, JSON.stringify(finalSuggestions, null, 2), 'utf-8');
        log.info(`已写入 codebase 建议：${suggestionsPath}`);

        if (opts.existingCodebaseMd) {
          const applySpinner = spinner('应用 codebase 建议中...').start();
          try {
            const afterContent = await applyCodebaseSuggestions(opts.existingCodebaseMd, finalSuggestions);
            const afterPath = path.join(opts.outputDir, 'codebase-after.md');
            await fs.writeFile(afterPath, afterContent, 'utf-8');
            applySpinner.succeed(`已写入更新后的 codebase.md：${afterPath}`);
          } catch (err: unknown) {
            applySpinner.fail(`codebase 应用失败：${(err as Error).message}`);
          }
        }
      }

      // repoPath 模式：读取并更新 docs/codebase.md
      if (opts.repoPath) {
        const codebasePath = path.join(opts.repoPath, 'docs', 'codebase.md');
        let currentContent: string | undefined;
        try {
          currentContent = await fs.readFile(codebasePath, 'utf-8');
        } catch {
          log.debug('repoPath 下未找到 docs/codebase.md，跳过 apply');
        }

        if (currentContent) {
          const applySpinner = spinner('更新 codebase.md...').start();
          try {
            const afterContent = await applyCodebaseSuggestions(currentContent, finalSuggestions);
            await fs.writeFile(codebasePath, afterContent, 'utf-8');
            applySpinner.succeed(`已更新：${codebasePath}`);
          } catch (err: unknown) {
            applySpinner.fail(`codebase 更新失败：${(err as Error).message}`);
          }
        }
      }
    }
  }

  return {
    learning: acceptLearning ? learning : undefined,
    codebaseSuggestions: finalSuggestions ?? undefined,
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
    log.info(`已写入 learning：${filePath}`);
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
    log.info(`已写入 learning：${filePath}`);
    return;
  }

  log.warn('未指定 outputDir 或 repoPath，learning 草稿未写入磁盘');
}
