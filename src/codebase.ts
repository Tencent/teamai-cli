import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { createGit } from './utils/git.js';
import { log } from './utils/logger.js';

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
 * The context of a git repository that a teamai-import-from-repo run gives the AI tool for the repository's narrative.
 *
 * 包含：最近 commit 记录、文件树结构、package.json 依赖、
 * 入口文件命令注册、types 关键接口、README/ARCHITECTURE/docs 摘要。
 *
 * @param repoPath  仓库根目录绝对路径
 * @returns         拼接好的上下文字符串
 */
export async function gatherRepoContext(repoPath: string): Promise<string> {
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
