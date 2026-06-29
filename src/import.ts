import path from 'node:path';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';

import { autoDetectInit } from './config.js';
import { generateCodebaseMd, generateCodebaseIndex, lintCodebaseMd } from './codebase.js';
import { scanCandidates, classifyWithAI, interactiveReview, pushAccepted } from './import-local.js';
import { importFromIWiki } from './import-iwiki.js';
import { importFromMR } from './import-mr.js';
import { importFromRepo } from './import-repo.js';
import { importFromRepoList } from './import-repo-list.js';
import { importFromOrg } from './import-org.js';
import { importFromIWikiDual } from './iwiki-dual.js';
import { GlobalOptions } from './types.js';
import { log } from './utils/logger.js';
import { autoPushTeamRepo } from './utils/git.js';

/**
 * import 命令的扩展选项，合并全局选项与子命令专属选项。
 */
interface ImportOptions extends GlobalOptions {
  /** 本地目录路径，用于扫描可导入文件 */
  dir?: string;
  /** 是否扫描 Claude/Cursor rule 目录 */
  fromClaude?: boolean;
  /** 是否从当前 git 工作区生成 codebase.md */
  workspace?: boolean;
  /** 从已合并 MR/PR URL 提取知识 */
  fromMr?: string;
  /** iWiki Space ID 或页面 URL，用于批量导入 iWiki 文档 */
  fromIwiki?: string;
  /** 是否恢复中断的导入会话 */
  resume?: boolean;
  /** 是否导入全部候选（跳过交互确认） */
  all?: boolean;
  /** 将草稿写入指定目录而非推送至团队仓库 */
  output?: string;
  /** 显式指定现有 codebase.md 路径（优先于从团队仓库自动读取） */
  existingCodebase?: string;
  /** 拉取远端仓库并生成单仓 codebase 摘要 */
  fromRepo?: string;
  /** --from-repo 的 shallow clone 深度（字符串，需 parseInt），默认 1 */
  depth?: string;
  /** 强制 SSH clone（即使 HTTPS token 可用） */
  ssh?: boolean;
  /** 跳过 AI 推荐，直接将仓库归入指定域 */
  domain?: string;
  /** 批量从 yaml 白名单导入多个仓库 */
  fromRepoList?: string;
  /** --from-repo-list 的并发数（字符串，需 parseInt），默认 3 */
  concurrency?: string;
  /** 跳过 domain-*.md / index.md 重生（仅做单仓） */
  skipAggregate?: boolean;
  /** 增量模式：缓存命中时仅 fetch+reset，未命中时 fallback 到全量 clone */
  incremental?: boolean;
  /** --from-org：org URL 或 group 路径 */
  fromOrg?: string;
  /** --bootstrap：在 --from-org 后进入交互 review */
  bootstrap?: boolean;
  /** --max-repos：--from-org 拉取仓库上限（字符串，需 parseInt） */
  maxRepos?: string;
  /** --exclude-archived：排除 archived 仓库 */
  excludeArchived?: boolean;
  /** --include-pattern：仅纳入匹配此正则的仓库 */
  includePattern?: string;
  /** --exclude-pattern：排除匹配此正则的仓库 */
  excludePattern?: string;
  /** --skip-import：只写草稿，跳过批量导入 */
  skipImport?: boolean;
  /** --iwiki-dual：iWiki 双路模式，同时产出 codebase sections */
  iwikiDual?: boolean;
  /** --require-review：codebase sections 落到 pending-review.jsonl */
  requireReview?: boolean;
  /** --skip-enrich：跳过 AI enrichment，只做 clone + extract + graph */
  skipEnrich?: boolean;
}

/**
 * import 命令主入口，根据选项组合 local、workspace、MR 三条导入流程。
 *
 * @param opts - 合并了全局选项与子命令选项的参数对象
 */
export async function importCmd(opts: ImportOptions): Promise<void> {
  try {
    if (opts.fromOrg) {
      // 分支：--from-org <org>，组织级一键初始化
      await importFromOrg({
        org: opts.fromOrg,
        bootstrap: opts.bootstrap ?? false,
        maxRepos: opts.maxRepos ? parseInt(opts.maxRepos, 10) : 200,
        excludeArchived: opts.excludeArchived ?? true,
        includePattern: opts.includePattern,
        excludePattern: opts.excludePattern,
        skipImport: opts.skipImport ?? false,
        dryRun: opts.dryRun,
        output: opts.output,
        forceSsh: opts.ssh ?? false,
      });
      return;
    } else if (opts.fromRepo) {
      // 分支：--from-repo <url>，拉取远端仓库并生成单仓 codebase 摘要
      await importFromRepo({
        url: opts.fromRepo,
        depth: opts.depth ? parseInt(opts.depth, 10) : 1,
        forceSsh: opts.ssh ?? false,
        explicitDomain: opts.domain,
        dryRun: opts.dryRun,
        output: opts.output,
        incremental: opts.incremental ?? false,
        skipEnrich: opts.skipEnrich ?? false,
      });
      return;
    } else if (opts.fromRepoList) {
      // 分支：--from-repo-list <yaml>，批量导入
      const result = await importFromRepoList({
        listPath: opts.fromRepoList,
        concurrency: opts.concurrency ? parseInt(opts.concurrency, 10) : 3,
        forceSsh: opts.ssh ?? false,
        dryRun: opts.dryRun,
        output: opts.output,
        skipAggregate: opts.skipAggregate ?? false,
        incremental: opts.incremental ?? false,
      });
      log.info(`完成：成功 ${result.succeeded}，失败 ${result.failed.length}，跳过 ${result.skipped.length}`);
      if (result.failed.length > 0) process.exitCode = 1;
      return;
    } else if (opts.fromIwiki) {
      // 分支 0：--from-iwiki，从 iWiki Space 或单页批量导入
      const { localConfig } = await autoDetectInit();
      await importFromIWiki({
        input: opts.fromIwiki,
        all: opts.all,
        outputDir: opts.output,
        repoPath: opts.dryRun ? undefined : localConfig.repo.localPath,
        dryRun: opts.dryRun,
      });
      // 若启用双路模式，追加调用 importFromIWikiDual
      if (opts.iwikiDual) {
        try {
          const dualResult = await importFromIWikiDual({
            input: opts.fromIwiki,
            output: opts.output,
            dryRun: opts.dryRun,
            requireReview: opts.requireReview ?? false,
          });
          log.info(
            `iWiki 双路完成：更新章节 [${dualResult.sectionsUpdated.join(', ')}]` +
            (dualResult.pendingReview ? '（待 review）' : ''),
          );
        } catch (dualErr) {
          log.warn(`iWiki 双路模式出错（不影响 learning 路径）：${String(dualErr)}`);
        }
      }
    } else if (opts.fromMr) {
      // 分支 1：--from-mr <url>，从已合并 MR 提取学习内容
      const { localConfig } = await autoDetectInit();

      // 尝试读取现有 codebase.md，用于生成风格一致的增量建议
      // 优先使用 --existing-codebase 显式指定的路径，其次从团队仓库读取
      let existingCodebaseMd: string | undefined;
      if (opts.existingCodebase) {
        try {
          existingCodebaseMd = await fs.readFile(opts.existingCodebase, 'utf-8');
          log.debug(`已加载指定 codebase.md（${existingCodebaseMd.length} 字符）：${opts.existingCodebase}`);
        } catch {
          log.warn(`无法读取 --existing-codebase 指定的文件：${opts.existingCodebase}`);
        }
      } else {
        const codebasePath = path.join(localConfig.repo.localPath, 'docs', 'codebase.md');
        try {
          existingCodebaseMd = await fs.readFile(codebasePath, 'utf-8');
          log.debug(`已加载现有 codebase.md（${existingCodebaseMd.length} 字符）`);
        } catch {
          log.debug('未找到现有 codebase.md，将使用默认格式示例');
        }
      }

      await importFromMR({
        url: opts.fromMr,
        learningsDir: path.join(localConfig.repo.localPath, 'learnings'),
        all: opts.all,
        outputDir: opts.output,
        repoPath: opts.dryRun ? undefined : localConfig.repo.localPath,
        existingCodebaseMd,
        dryRun: opts.dryRun,
      });
      if (!opts.dryRun && !opts.output) {
        await autoPushTeamRepo(localConfig.repo.localPath, `[teamai] Import from MR: ${opts.fromMr}`);
      }
    } else if (opts.workspace) {
      // 分支 2：--workspace，从当前 git 工作区生成 codebase.md
      const repoPath = process.cwd();

      // 尝试使用默认 learnings 目录（不增加 CLI flag）
      const defaultLearningsDir = path.join(repoPath, 'learnings');
      const learningsDir = fsSync.existsSync(defaultLearningsDir) ? defaultLearningsDir : undefined;

      const codebaseMd = await generateCodebaseMd({ repoPath, learningsDir });

      // 决定 codebase.md 的写出路径
      let codebaseOutputPath: string | undefined;
      if (opts.output) {
        await fs.writeFile(opts.output, codebaseMd, 'utf-8');
        log.info(`已写入：${opts.output}`);
        codebaseOutputPath = opts.output;
      } else {
        log.info(codebaseMd);
        // stdout 模式：把索引写到 cwd/codebase-index.md
        codebaseOutputPath = path.join(repoPath, 'codebase.md');
      }

      // 生成并写出索引
      try {
        const indexMd = await generateCodebaseIndex(codebaseMd);
        const indexDir = opts.output ? path.dirname(codebaseOutputPath) : repoPath;
        const indexPath = path.join(indexDir, 'codebase-index.md');
        await fs.writeFile(indexPath, indexMd, 'utf-8');
        log.info(`索引已写入：${indexPath}`);
      } catch (indexErr) {
        log.debug(`生成索引失败（不中断流程）：${String(indexErr)}`);
      }

      // 执行 lint 检查（只打印不写文件，不因失败中断）
      try {
        const lintReport = await lintCodebaseMd(codebaseMd);
        const highIssues = lintReport.issues.filter((i) => i.severity === 'high');
        log.info(`[lint] ${lintReport.summary}（共 ${lintReport.issues.length} 个问题）`);
        if (highIssues.length > 0) {
          const displayCount = Math.min(highIssues.length, 5);
          log.info(`[lint] 高严重度问题（${highIssues.length} 条）：`);
          for (let idx = 0; idx < displayCount; idx++) {
            const issue = highIssues[idx]!;
            log.info(`  ⚠️  [${issue.category}] ${issue.location}: ${issue.description}`);
          }
          if (highIssues.length > 5) {
            log.info(`  … 还有 ${highIssues.length - 5} 条 high 级 lint 问题，请查阅完整报告`);
          }
        }
      } catch (lintErr) {
        log.debug(`lint 检查失败（不中断流程）：${String(lintErr)}`);
      }
    } else if (opts.dir || opts.fromClaude) {
      // 分支 3：--dir 或 --from-claude，扫描本地文件并交互式导入
      const candidates = await scanCandidates({ dir: opts.dir, fromClaude: opts.fromClaude });
      if (candidates.length === 0) {
        log.info('未发现可导入的文件');
        return;
      }
      const classified = await classifyWithAI(candidates);
      const session = await interactiveReview(classified, { all: opts.all, resume: opts.resume });
      const { localConfig } = await autoDetectInit();
      const { pushed } = await pushAccepted(session, localConfig.repo.localPath, {
        dryRun: opts.dryRun,
        outputDir: opts.output,
      });
      log.success('导入完成');
      if (pushed > 0 && !opts.dryRun && !opts.output) {
        await autoPushTeamRepo(localConfig.repo.localPath, `[teamai] Import from local: ${opts.dir ?? 'claude-rules'}`);
      }
    } else {
      // 默认：未指定来源，提示用户
      log.info('请指定导入来源：--dir <path>、--from-claude、--workspace、--from-mr <url> 或 --from-iwiki <space-id-or-url>');
      return;
    }
  } catch (err: unknown) {
    log.error((err as Error).message);
    process.exit(1);
  }
}
