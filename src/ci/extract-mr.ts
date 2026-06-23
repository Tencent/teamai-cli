// -*- coding: utf-8 -*-
/**
 * CI MR 知识提炼主编排。
 *
 * 复用 importFromMR 的 AI 提炼逻辑，根据 mode 执行：
 * - comment: 幂等发布/更新 MR comment
 * - write: 将 learning 和 codebase 建议写入团队仓库
 * - both: 两者都执行
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import { importFromMR } from '../import-mr.js';
import { applyCodebaseSuggestions } from '../codebase.js';
import { appendPendingReview } from '../review-store.js';
import { pushRepoDirectly } from '../utils/git.js';
import { log } from '../utils/logger.js';
import type { LearningDraft, CodebaseSuggestion } from '../types.js';
import { postOrUpdateMrComment, postIndividualComments, parseMrUrl } from './mr-comment.js';
import { readRejections, shouldWrite } from './read-rejections.js';

// ─── 类型 ────────────────────────────────────────────────

export interface CiExtractMrOptions {
  url: string;
  mode: 'comment' | 'write' | 'both';
  teamRepo?: string;
  existingCodebase?: string;
  commentMarker?: string;
  writeMode?: 'direct' | 'pending-review';
  output?: string;
  dryRun?: boolean;
  individualComments?: boolean;
}

// ─── Git User 配置 ───────────────────────────────────────

/**
 * 自动配置 git user.name 和 user.email。
 *
 * 通过 provider API 获取当前 token 对应的用户信息：
 * - GitHub: GITHUB_TOKEN → GET /user
 * - TGit: TAI_PAT_TOKEN → GET /api/v3/user
 */
async function configureGitUser(repoPath: string, provider: 'github' | 'tgit'): Promise<void> {
  const { execFileSync } = await import('node:child_process');
  let name = 'teamai-ci';
  let email = 'teamai-ci@noreply';

  try {
    if (provider === 'github') {
      const token = process.env['GITHUB_TOKEN'];
      if (token) {
        const resp = await fetch('https://api.github.com/user', {
          headers: { Authorization: `Bearer ${token}`, 'User-Agent': 'teamai-cli' },
          signal: AbortSignal.timeout(8000),
        });
        if (resp.ok) {
          const user = (await resp.json()) as { login: string; email: string | null };
          name = user.login;
          email = user.email ?? `${user.login}@users.noreply.github.com`;
        }
      }
    } else {
      const token = process.env['TAI_PAT_TOKEN'];
      if (token) {
        const resp = await fetch('https://git.woa.com/api/v3/user', {
          headers: { Authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(8000),
        });
        if (resp.ok) {
          const user = (await resp.json()) as { username: string; email: string };
          name = user.username;
          email = user.email;
        }
      }
    }
  } catch {
    log.debug('无法获取用户信息，使用默认 git user');
  }

  try {
    execFileSync('git', ['config', 'user.name', name], { cwd: repoPath, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', email], { cwd: repoPath, stdio: 'ignore' });
    log.debug(`Git user: ${name} <${email}>`);
  } catch {
    log.debug('git config 失败（非 git 仓库），跳过');
  }
}

// ─── 写入逻辑 ────────────────────────────────────────────

/**
 * 将 learning 和 codebase 建议写入团队仓库。
 */
async function writeKnowledgeToRepo(
  teamRepo: string,
  learning: LearningDraft | undefined,
  suggestions: CodebaseSuggestion[] | undefined,
  writeMode: 'direct' | 'pending-review',
  mrUrl: string,
  dryRun?: boolean,
): Promise<void> {
  const changedFiles: string[] = [];

  // 写入 learning
  if (learning) {
    const safeTitle = learning.title
      .replace(/[^a-zA-Z0-9一-鿿_-]/g, '-')
      .replace(/-+/g, '-')
      .slice(0, 50);
    const dateStr = new Date().toISOString().slice(0, 10);
    const filename = `${dateStr}-${safeTitle}.md`;
    const learningsDir = path.join(teamRepo, 'learnings');
    const learningPath = path.join(learningsDir, filename);

    if (!dryRun) {
      await fs.mkdir(learningsDir, { recursive: true });
      await fs.writeFile(learningPath, learning.content, 'utf-8');
    }
    log.success(`Learning 写入: learnings/${filename}`);
    changedFiles.push(`learnings/${filename}`);
  }

  // 处理 codebase suggestions
  if (suggestions && suggestions.length > 0) {
    if (writeMode === 'direct') {
      const codebasePath = path.join(teamRepo, 'docs', 'codebase.md');
      try {
        const existing = await fs.readFile(codebasePath, 'utf-8');
        const updated = await applyCodebaseSuggestions(existing, suggestions);
        if (!dryRun) {
          await fs.writeFile(codebasePath, updated, 'utf-8');
        }
        log.success('Codebase.md 已更新');
        changedFiles.push('docs/codebase.md');
      } catch {
        log.warn('docs/codebase.md 不存在或读取失败，跳过 codebase 更新');
      }
    } else {
      // pending-review 模式
      for (const s of suggestions) {
        if (!dryRun) {
          await appendPendingReview(teamRepo, {
            kind: 'codebase-section',
            target: { file: 'docs/codebase.md', section: s.section },
            payload: { content: s.content, action: s.action },
            source: `ci:extract-mr:${mrUrl}`,
          });
        }
      }
      log.success(`${suggestions.length} 条建议已加入 pending-review 队列`);
      changedFiles.push('.teamai/pending-review.jsonl');
    }
  }

  // 提交并推送
  if (!dryRun && changedFiles.length > 0) {
    try {
      const provider = mrUrl.includes('github.com') ? 'github' as const : 'tgit' as const;
      await configureGitUser(teamRepo, provider);
      await pushRepoDirectly(teamRepo, `[teamai] CI extract knowledge from MR`, changedFiles);
      log.success('已推送到团队仓库');
    } catch (err) {
      log.warn(`推送失败: ${(err as Error).message}，文件已写入本地`);
    }
  }
}

// ─── 输出 artifacts ─────────────────────────────────────

async function writeArtifacts(
  outputDir: string,
  learning: LearningDraft | undefined,
  suggestions: CodebaseSuggestion[] | undefined,
): Promise<void> {
  await fs.mkdir(outputDir, { recursive: true });

  if (learning) {
    await fs.writeFile(path.join(outputDir, 'learning.md'), learning.content, 'utf-8');
  }

  if (suggestions && suggestions.length > 0) {
    await fs.writeFile(
      path.join(outputDir, 'codebase-suggestions.json'),
      JSON.stringify(suggestions, null, 2),
      'utf-8',
    );
  }
}

// ─── 主入口 ─────────────────────────────────────────────

/**
 * CI MR 知识提炼主函数。
 *
 * @param opts  命令选项
 * @throws     参数校验失败或 AI 调用失败时抛出 Error
 */
export async function ciExtractMr(opts: CiExtractMrOptions): Promise<void> {
  // 参数校验
  if ((opts.mode === 'write' || opts.mode === 'both') && !opts.teamRepo) {
    throw new Error('write 模式需要 --team-repo 参数');
  }

  // 读取 existing codebase.md (可选)
  let existingCodebaseMd: string | undefined;
  if (opts.existingCodebase) {
    try {
      existingCodebaseMd = await fs.readFile(opts.existingCodebase, 'utf-8');
    } catch {
      log.warn(`无法读取 --existing-codebase: ${opts.existingCodebase}`);
    }
  } else if (opts.teamRepo) {
    const codebasePath = path.join(opts.teamRepo, 'docs', 'codebase.md');
    try {
      existingCodebaseMd = await fs.readFile(codebasePath, 'utf-8');
    } catch {
      // 不存在则不传
    }
  }

  // AI 提炼（复用 importFromMR）
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'teamai-ci-extract-'));
  let learning: LearningDraft | undefined;
  let suggestions: CodebaseSuggestion[] | undefined;

  try {
    const result = await importFromMR({
      url: opts.url,
      all: true,
      outputDir: tmpDir,
      existingCodebaseMd,
      dryRun: true, // 不让 importFromMR 自己写文件，我们自己控制写入
    });
    learning = result.learning;
    suggestions = result.codebaseSuggestions;
  } finally {
    // 清理临时目录
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }

  // 执行 comment
  if (opts.mode === 'comment' || opts.mode === 'both') {
    if (opts.individualComments) {
      const { posted } = await postIndividualComments(opts.url, learning, suggestions, opts.dryRun);
      log.success(`已发布 ${posted} 条独立建议 comment`);
    } else {
      const result = await postOrUpdateMrComment(
        opts.url,
        learning,
        suggestions,
        opts.commentMarker,
        opts.dryRun,
      );
      if (result.created) {
        log.success('MR comment 已发布');
      } else {
        log.success('MR comment 已更新');
      }
      if (result.url) {
        log.info(`Comment URL: ${result.url}`);
      }
    }
  }

  // 执行 write
  if (opts.mode === 'write' || opts.mode === 'both') {
    // 当使用 individual comments 时，读取 rejection 状态进行过滤
    let filteredLearning = learning;
    let filteredSuggestions = suggestions;

    if (opts.individualComments && !opts.dryRun) {
      const parsed = parseMrUrl(opts.url);
      const rejections = await readRejections(opts.url);

      if (rejections.allIds.size > 0) {
        // 过滤 learning
        if (learning && !shouldWrite('learning', rejections, parsed.provider)) {
          log.info('Learning 被 reject，跳过写入');
          filteredLearning = undefined;
        }

        // 过滤 suggestions
        if (suggestions) {
          filteredSuggestions = suggestions.filter((_, i) =>
            shouldWrite(`suggestion:${i + 1}`, rejections, parsed.provider),
          );
          const rejected = suggestions.length - filteredSuggestions.length;
          if (rejected > 0) {
            log.info(`${rejected} 条 codebase 建议被 reject，已排除`);
          }
        }
      }
    }

    await writeKnowledgeToRepo(
      opts.teamRepo!,
      filteredLearning,
      filteredSuggestions,
      opts.writeMode ?? 'direct',
      opts.url,
      opts.dryRun,
    );
  }

  // 输出 artifacts
  if (opts.output) {
    await writeArtifacts(opts.output, learning, suggestions);
    log.success(`Artifacts 已输出到: ${opts.output}`);
  }
}
