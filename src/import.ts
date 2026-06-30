import path from 'node:path';
import os from 'node:os';
import fs from 'fs-extra';

import { autoDetectInit } from './config.js';
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
 * import 命令主入口，根据选项组合 dir、MR、org 等导入流程。
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
        skipEnrich: opts.skipEnrich ?? false,
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
        skipEnrich: opts.skipEnrich ?? false,
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
    } else if (opts.dir) {
      // 分支 3：--dir <path>，代码知识提取（等同于 --from-repo 但跳过 clone）
      const dirPath = path.resolve(opts.dir);
      if (!(await fs.pathExists(dirPath))) {
        throw new Error(`目录不存在: ${dirPath}`);
      }
      const slug = path.basename(dirPath);
      log.info(`扫描本地目录: ${dirPath} (project: ${slug})`);

      if (opts.dryRun) {
        log.info(`[dry-run] 跳过代码提取，不执行实际操作`);
        log.success(`本地目录 ${slug} 导入完成 (dry-run)`);
        return;
      }

      // 使用临时目录承接 extractCodebase 产物，避免污染源码目录已有的 teamwiki/
      const tmpExtractDir = await fs.mkdtemp(path.join(os.tmpdir(), 'teamai-extract-'));
      try {
        const { extractCodebase } = await import('./codebase-extract.js');
        await extractCodebase({
          path: dirPath,
          project: slug,
          json: false,
          skipEnrich: opts.skipEnrich ?? false,
          outputRoot: tmpExtractDir,
        });

        const srcWiki = path.join(tmpExtractDir, 'teamwiki');

        if (opts.output) {
            // --output 模式：写到指定目录，不碰团队仓库
            const outputWiki = path.join(opts.output, 'teamwiki');
            if (await fs.pathExists(srcWiki)) {
              await fs.copy(srcWiki, outputWiki, { overwrite: true });
              log.info(`产物已写入：${outputWiki}`);
            }
          } else {
            // 默认模式：写入 team-repo 并推送
            const { localConfig } = await autoDetectInit();
            const teamRepoPath = localConfig.repo.localPath;
            const teamwikiRoot = path.join(teamRepoPath, 'teamwiki');

            if (await fs.pathExists(srcWiki)) {
              const evidenceSrc = path.join(srcWiki, 'evidence', 'code', slug);
              const evidenceDest = path.join(teamwikiRoot, 'evidence', 'code', slug);
              if (await fs.pathExists(evidenceSrc)) {
                await fs.ensureDir(path.dirname(evidenceDest));
                await fs.copy(evidenceSrc, evidenceDest, { overwrite: true });
              }
              const srcGraph = path.join(srcWiki, '.indices', 'graph-index.json');
              if (await fs.pathExists(srcGraph)) {
                const destGraphDir = path.join(evidenceDest, '.indices');
                await fs.ensureDir(destGraphDir);
                await fs.copy(srcGraph, path.join(destGraphDir, 'graph-index.json'), { overwrite: true });
              }
              log.info(`teamwiki/ 知识图谱已更新: ${slug}`);
            }

            const { aggregateGlobalGraph } = await import('./graph-aggregate.js');
            await aggregateGlobalGraph(teamwikiRoot);

            const { autoPushTeamRepo } = await import('./utils/git.js');
            await autoPushTeamRepo(teamRepoPath, `[teamai] Import from local dir: ${slug}`);
            log.success(`已推送到团队知识仓库 (${localConfig.repo.remote})`);
          }
      } finally {
        await fs.remove(tmpExtractDir);
      }
      log.success(`本地目录 ${slug} 导入完成`);
    } else if (opts.fromClaude) {
      // 分支 3b：--from-claude，扫描规则文件并交互式导入
      const candidates = await scanCandidates({ fromClaude: true });
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
        await autoPushTeamRepo(localConfig.repo.localPath, `[teamai] Import from local: claude-rules`);
      }
    } else {
      // 默认：未指定来源，提示用户
      log.info('请指定导入来源：--dir <path>、--from-repo <url>、--from-repo-list <yaml>、--from-org <org>、--from-mr <url> 或 --from-iwiki <id>');
      return;
    }
  } catch (err: unknown) {
    log.error((err as Error).message);
    process.exit(1);
  }
}
