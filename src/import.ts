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
import { Listr, PRESET_TIMER } from 'listr2';
import { log } from './utils/logger.js';
import { autoPushTeamRepo } from './utils/git.js';

/**
 * Extended options for the import command, merging global options with subcommand-specific options.
 */
interface ImportOptions extends GlobalOptions {
  /** Local directory path for scanning importable files */
  dir?: string;
  /** Whether to scan Claude/Cursor rule directories */
  fromClaude?: boolean;
  /** Extract knowledge from a merged MR/PR URL */
  fromMr?: string;
  /** iWiki Space ID or page URL for bulk importing iWiki documents */
  fromIwiki?: string;
  /** Whether to resume an interrupted import session */
  resume?: boolean;
  /** Whether to import all candidates (skip interactive confirmation) */
  all?: boolean;
  /** Write draft to the specified directory instead of pushing to team repo */
  output?: string;
  /** Pull remote repo and generate single-repo codebase summary */
  fromRepo?: string;
  /** Shallow clone depth for --from-repo (string, requires parseInt), default 1 */
  depth?: string;
  /** Force SSH clone (even when HTTPS token is available) */
  ssh?: boolean;
  /** Skip AI recommendation and assign repo directly to the specified domain */
  domain?: string;
  /** Batch import multiple repos from a yaml whitelist */
  fromRepoList?: string;
  /** Concurrency for --from-repo-list (string, requires parseInt), default 3 */
  concurrency?: string;
  /** Skip domain-*.md / index.md regeneration (single-repo only) */
  skipAggregate?: boolean;
  /** Incremental mode: fetch+reset on cache hit, fall back to full clone on miss */
  incremental?: boolean;
  /** --from-org: org URL or group path */
  fromOrg?: string;
  /** --bootstrap: enter interactive review after --from-org */
  bootstrap?: boolean;
  /** --max-repos: max repos to fetch with --from-org (string, requires parseInt) */
  maxRepos?: string;
  /** --exclude-archived: exclude archived repos */
  excludeArchived?: boolean;
  /** --include-pattern: only include repos whose name matches this regex */
  includePattern?: string;
  /** --exclude-pattern: exclude repos whose name matches this regex */
  excludePattern?: string;
  /** --skip-import: only write draft, skip batch import */
  skipImport?: boolean;
  /** --iwiki-dual: iWiki dual-path mode, also produces codebase sections */
  iwikiDual?: boolean;
  /** --require-review: codebase sections land in pending-review.jsonl */
  requireReview?: boolean;
  /** --skip-enrich: skip AI enrichment, only do clone + extract + graph */
  skipEnrich?: boolean;
}

/**
 * Main entry point for the import command, orchestrating dir, MR, org, and other import flows.
 *
 * @param opts - Merged global and subcommand options object
 */
export async function importCmd(opts: ImportOptions): Promise<void> {
  try {
    if (opts.fromOrg) {
      // 分支：--from-org <org>，组织级一键初始化
      const tasks = new Listr([
        {
          title: 'Import from organization',
          task: async (ctx, task) => {
            task.output = `Org: ${opts.fromOrg}`;
            await importFromOrg({
              org: opts.fromOrg!,
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
          },
          rendererOptions: { persistentOutput: true },
        },
      ], {
        rendererOptions: { timer: PRESET_TIMER },
        exitOnError: true,
      });
      await tasks.run();
      return;
    } else if (opts.fromRepo) {
      // 分支：--from-repo <url>，拉取远端仓库并生成单仓 codebase 摘要
      const tasks = new Listr([
        {
          title: 'Import remote repository',
          task: async (ctx, task) => {
            task.output = `Repository: ${opts.fromRepo}`;
            await importFromRepo({
              url: opts.fromRepo!,
              depth: opts.depth ? parseInt(opts.depth, 10) : 1,
              forceSsh: opts.ssh ?? false,
              explicitDomain: opts.domain,
              dryRun: opts.dryRun,
              output: opts.output,
              incremental: opts.incremental ?? false,
              skipEnrich: opts.skipEnrich ?? false,
            });
          },
          rendererOptions: { persistentOutput: true },
        },
      ], {
        rendererOptions: { timer: PRESET_TIMER, collapseErrors: false },
        exitOnError: true,
      });
      await tasks.run();
      return;
    } else if (opts.fromRepoList) {
      // 分支：--from-repo-list <yaml>，批量导入
      const tasks = new Listr([
        {
          title: 'Batch import from repo list',
          task: async (ctx, task) => {
            task.output = `List: ${opts.fromRepoList}`;
            const result = await importFromRepoList({
              listPath: opts.fromRepoList!,
              concurrency: opts.concurrency ? parseInt(opts.concurrency, 10) : 3,
              forceSsh: opts.ssh ?? false,
              dryRun: opts.dryRun,
              output: opts.output,
              skipAggregate: opts.skipAggregate ?? false,
              incremental: opts.incremental ?? false,
              skipEnrich: opts.skipEnrich ?? false,
            });
            task.title = `Batch import complete: ${result.succeeded} succeeded, ${result.failed.length} failed, ${result.skipped.length} skipped`;
            if (result.failed.length > 0) process.exitCode = 1;
          },
          rendererOptions: { persistentOutput: true },
        },
      ], {
        rendererOptions: { timer: PRESET_TIMER },
        exitOnError: true,
      });
      await tasks.run();
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
            `iWiki dual-path complete: sections updated [${dualResult.sectionsUpdated.join(', ')}]` +
            (dualResult.pendingReview ? ' (pending review)' : ''),
          );
        } catch (dualErr) {
          log.warn(`iWiki dual-path error (non-blocking): ${String(dualErr)}`);
        }
      }
    } else if (opts.fromMr) {
      // 分支 1：--from-mr <url>，提取 learning + 增量更新 teamwiki
      const { localConfig, teamConfig } = await autoDetectInit();

      const tasks = new Listr([
        {
          title: 'Extract learning from MR',
          task: async (ctx) => {
            const { learning, repoUrl } = await importFromMR({
              url: opts.fromMr!,
              learningsDir: path.join(localConfig.repo.localPath, 'learnings'),
              all: opts.all,
              outputDir: opts.output,
              repoPath: opts.dryRun ? undefined : localConfig.repo.localPath,
              dryRun: opts.dryRun,
            });
            ctx.learning = learning;
            ctx.repoUrl = repoUrl;
          },
        },
        {
          title: 'Incremental teamwiki update',
          skip: (ctx) => !ctx.repoUrl || !!opts.dryRun || !!opts.output,
          task: async (ctx, task) => {
            const teamwikiRoot = path.join(localConfig.repo.localPath, 'teamwiki');
            try {
              const { detectProvider, getProvider } = await import('./providers/registry.js');
              const { getRepoSlug } = await import('./utils/repo-cache.js');
              const providerName = detectProvider(ctx.repoUrl);
              const provider = getProvider(providerName);
              const repoInfo = provider.parseRepoInput(ctx.repoUrl);
              const slug = getRepoSlug(providerName, repoInfo.owner, repoInfo.repo);
              const evidenceDir = path.join(teamwikiRoot, 'evidence', 'code', slug);

              if (await fs.pathExists(evidenceDir)) {
                task.output = `Updating ${slug}...`;
                await importFromRepo({
                  url: ctx.repoUrl,
                  incremental: true,
                  interactive: false,
                  skipAutoPush: true,
                });
                ctx.didUpdate = true;
              } else {
                task.skip('No existing evidence for this repo');
              }
            } catch (e) {
              task.output = `Failed (non-blocking): ${(e as Error).message}`;
            }
          },
          rendererOptions: { persistentOutput: true },
        },
        {
          title: 'Push changes via MR',
          skip: (ctx) => !!opts.dryRun || !!opts.output || (!ctx.learning && !ctx.didUpdate),
          task: async () => {
            const { autoPushViaMR } = await import('./utils/git.js');
            await autoPushViaMR(
              localConfig.repo.localPath,
              `[teamai] Import from MR: ${opts.fromMr}`,
              ['.'],
              { repo: teamConfig.repo, provider: teamConfig.provider, reviewers: teamConfig.reviewers },
              { repo: localConfig.repo, username: localConfig.username },
            );
          },
        },
      ], {
        rendererOptions: { timer: PRESET_TIMER, collapseErrors: false },
        exitOnError: false,
        ctx: { learning: undefined as unknown, repoUrl: '' as string, didUpdate: false as boolean },
      });
      await tasks.run();
    } else if (opts.dir) {
      // 分支 3：--dir <path>，代码知识提取（等同于 --from-repo 但跳过 clone）
      const dirPath = path.resolve(opts.dir);
      if (!(await fs.pathExists(dirPath))) {
        throw new Error(`Directory not found: ${dirPath}`);
      }
      const slug = path.basename(dirPath);
      log.info(`Scanning local directory: ${dirPath} (project: ${slug})`);

      if (opts.dryRun) {
        log.info(`[dry-run] skipping code extraction, no action taken`);
        log.success(`Local directory ${slug} import complete (dry-run)`);
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
              log.info(`Output written: ${outputWiki}`);
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
              log.info(`teamwiki/ knowledge graph updated: ${slug}`);
            }

            const { aggregateGlobalGraph } = await import('./graph-aggregate.js');
            await aggregateGlobalGraph(teamwikiRoot);

            await autoPushTeamRepo(teamRepoPath, `[teamai] Import from local dir: ${slug}`);
            log.success(`Pushed to team knowledge repo (${localConfig.repo.remote})`);
          }
      } finally {
        await fs.remove(tmpExtractDir);
      }
      log.success(`Local directory ${slug} import complete`);
    } else if (opts.fromClaude) {
      // 分支 3b：--from-claude，扫描规则文件并交互式导入
      const candidates = await scanCandidates({ fromClaude: true });
      if (candidates.length === 0) {
        log.info('no importable files found');
        return;
      }
      const classified = await classifyWithAI(candidates);
      const session = await interactiveReview(classified, { all: opts.all, resume: opts.resume });
      const { localConfig } = await autoDetectInit();
      const { pushed } = await pushAccepted(session, localConfig.repo.localPath, {
        dryRun: opts.dryRun,
        outputDir: opts.output,
      });
      log.success('Import complete');
      if (pushed > 0 && !opts.dryRun && !opts.output) {
        await autoPushTeamRepo(localConfig.repo.localPath, `[teamai] Import from local: claude-rules`);
      }
    } else {
      // 默认：未指定来源，提示用户
      log.info('Please specify import source: --dir <path>, --from-repo <url>, --from-repo-list <yaml>, --from-org <org>, --from-mr <url>, or --from-iwiki <id>');
      return;
    }
  } catch (err: unknown) {
    log.error((err as Error).message);
    process.exit(1);
  }
}
