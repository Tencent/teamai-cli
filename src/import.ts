import path from 'node:path';
import fs from 'fs-extra';

import { autoDetectInit } from './config.js';
import { scanCandidates, classifyWithAI, interactiveReview, pushAccepted } from './import-local.js';
import { importFromIWiki } from './import-iwiki.js';
import { importFromMR } from './import-mr.js';
import { importFromRepo } from './import-repo.js';
import { importFromRepoList } from './import-repo-list.js';
import { importFromOrg } from './import-org.js';
import { importFromIWikiDual } from './iwiki-dual.js';
import { resolveActiveLearningsNamespaces } from './projects.js';
import { indexableLearningsRoots } from './utils/learnings-roots.js';
import { pendingLearningsDir, queueWriteRefusal, savePendingLearning } from './utils/pending-learnings.js';
import type { GlobalOptions } from './types.js';
import { assertNotReadOnly } from './read-only.js';
import { log, setSilent } from './utils/logger.js';
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
  /** Incremental mode: re-extract only what changed since the published baseline (--from-repo also fetch+resets its cache) */
  incremental?: boolean;
  /** --from-org: org URL or group path */
  fromOrg?: string;
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
  // Loaded here, not at startup: only this command shows a task list.
  const { Listr, PRESET_TIMER } = await import('listr2');
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
      const { localConfig } = await autoDetectInit(undefined, { dryRun: opts.dryRun });
      await importFromIWiki({
        input: opts.fromIwiki,
        all: opts.all,
        outputDir: opts.output,
        repoPath: localConfig.repo.localPath,
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
      const { localConfig, teamConfig } = await autoDetectInit(undefined, { dryRun: opts.dryRun });
      // Its learning is published the way `teamai contribute` publishes, which a
      // read-only (HTTP) source refuses; a dry run or --output publishes nothing.
      if (!opts.dryRun && !opts.output) assertNotReadOnly(localConfig, 'teamai import --from-mr');
      // As contribute: into the active project's learnings namespace when there
      // is exactly one, else the shared root.
      const { resolveLearningsSubdir } = await import('./contribute.js');
      const learningsSubdir = opts.dryRun || opts.output ? '' : await resolveLearningsSubdir(localConfig);
      // The namespaces recall finds learnings in here (#823). The duplicate
      // check is advisory: a broken projects.yaml narrows it to the shared
      // root, as recall does.
      const learningsNamespaces = await resolveActiveLearningsNamespaces(localConfig.repo.localPath, localConfig.projects ?? [])
        .catch((e: unknown) => {
          log.warn(`The duplicate check reads the shared learnings only: ${e instanceof Error ? e.message : String(e)}`);
          return [];
        });
      // Publishing creates a worktree under `.teamai/`; self-heal the ignore
      // rule first, as contribute does, while its notice can still be seen.
      if (!opts.dryRun && !opts.output) {
        const { migrateSelfModeGitignore } = await import('./init.js');
        await migrateSelfModeGitignore(localConfig);
      }

      // Before the task list, not in it: in a terminal, listr2 holds back what
      // is written to stdout while a task runs, so `Accept learning?` never
      // showed and the extraction seemed to hang (#823).
      const extracted = await importFromMR({
        url: opts.fromMr,
        // Not another repository's learnings checkout (#808).
        learningsDirs: [pendingLearningsDir(localConfig), ...(await indexableLearningsRoots(localConfig))],
        learningsNamespaces,
        all: opts.all,
        outputDir: opts.output,
        // Into the contribution queue, which publishing drains (#823).
        queueLearning: opts.dryRun ? undefined : async (filename, content) => {
          const queued = await savePendingLearning(localConfig, path.posix.join(learningsSubdir, filename), content);
          if (queued.status !== 'saved') throw new Error(queueWriteRefusal(queued));
          return queued.path;
        },
        dryRun: opts.dryRun,
      });

      const tasks = new Listr([
        {
          title: 'Publish learning',
          skip: (ctx) => !!opts.dryRun || !!opts.output || !ctx.learning,
          task: async (ctx, task) => {
            const { publishQueuedLearnings } = await import('./utils/learnings-publish.js');
            const { rebuildIndexAfterContribute } = await import('./contribute.js');
            const report = await publishQueuedLearnings(localConfig, localConfig.username);
            // Recall finds it where it is now: published, or still queued.
            await rebuildIndexAfterContribute(localConfig).catch((e: unknown) =>
              log.debug(`import: index rebuild skipped: ${e instanceof Error ? e.message : String(e)}`));
            const queued = ctx.learningFile ? path.posix.join(learningsSubdir, path.basename(ctx.learningFile)) : '';
            if (report.installChanged) {
              const { KEPT_FOR_ITS_INSTALL } = await import('./contribute.js');
              task.title = `Learning saved locally, not published: ${report.installChanged}. ${KEPT_FOR_ITS_INSTALL}`;
            } else if (report.refused) {
              const { KEPT_UNTIL_CHECKOUT_SETTLED } = await import('./contribute.js');
              task.title = `Learning saved locally (${report.lastError ?? 'not published yet'}). ${KEPT_UNTIL_CHECKOUT_SETTLED}`;
            } else if (!report.published.includes(queued)) {
              task.title = `Learning saved locally (${report.lastError ?? 'not published yet'}); `
                + 'the next `teamai pull` publishes it';
            }
          },
          rendererOptions: { persistentOutput: true },
        },
        {
          title: 'Incremental teamwiki update',
          skip: (ctx) => !ctx.repoUrl || !!opts.dryRun || !!opts.output,
          task: async (ctx, task) => {
            const teamwikiRoot = path.join(localConfig.repo.localPath, 'teamwiki');
            try {
              const { repoSlugForUrl } = await import('./import-repo.js');
              const slug = repoSlugForUrl(ctx.repoUrl);
              const evidenceDir = path.join(teamwikiRoot, 'evidence', 'code', slug);

              if (await fs.pathExists(evidenceDir)) {
                task.output = `Updating ${slug}...`;
                await importFromRepo({
                  url: ctx.repoUrl,
                  incremental: true,
                  skipAutoPush: true,
                  sourceMrUrl: opts.fromMr,
                });
                try {
                  const { rebuildWikiIndex } = await import('./rebuild-wiki-index.js');
                  await rebuildWikiIndex(teamwikiRoot);
                } catch (e) {
                  const msg = e instanceof Error ? e.message : String(e);
                  log.warn(`[wiki] global index rebuild failed (non-blocking): ${msg}`);
                }
                ctx.didUpdate = true;
              } else {
                task.skip('No existing evidence for this repo');
              }
            } catch (e) {
              task.title = `Incremental update skipped: ${(e as Error).message}`;
            }
          },
          rendererOptions: { persistentOutput: true },
        },
        {
          // The teamwiki update only: the learning was published above.
          title: 'Push changes via MR',
          skip: (ctx) => !!opts.dryRun || !!opts.output || (!ctx.didUpdate && 'No teamwiki changes to push'),
          task: async () => {
            const { autoPushViaMR } = await import('./utils/git.js');
            await autoPushViaMR(
              localConfig.repo.localPath,
              `[teamai] Import from MR: ${opts.fromMr}`,
              ['.'],
              { repo: teamConfig.repo, provider: teamConfig.provider, reviewers: teamConfig.reviewers },
              { repo: localConfig.repo, username: localConfig.username, provider: localConfig.provider },
            );
          },
        },
      ], {
        rendererOptions: { timer: PRESET_TIMER, collapseErrors: false },
        exitOnError: true,
        ctx: { ...extracted, didUpdate: false },
      });
      setSilent(true);
      try { await tasks.run(); } finally { setSilent(false); }
    } else if (opts.dir) {
      // 分支 3：--dir <path>，代码知识提取（等同于 --from-repo 但跳过 clone）
      const dirPath = path.resolve(opts.dir);
      if (!(await fs.pathExists(dirPath))) {
        throw new Error(`Directory not found: ${dirPath}`);
      }
      const { defaultProjectSlug } = await import('./codebase-extract.js');
      const slug = await defaultProjectSlug(dirPath);
      log.info(`Scanning local directory: ${dirPath} (project: ${slug})`);

      if (opts.dryRun) {
        log.info(`[dry-run] skipping code extraction, no action taken`);
        log.success(`Local directory ${slug} import complete (dry-run)`);
        return;
      }

      // <output>/teamwiki, else the team repo's teamwiki/; never the source directory.
      const { lockTeamwiki, resolveTeamwiki } = await import('./utils/teamwiki-root.js');
      const target = await resolveTeamwiki({ output: opts.output });
      const { wikiRoot, team } = target;
      const releaseImportLock = await lockTeamwiki(target);
      try {
        const { importLocalCheckout } = await import('./import-codebase.js');
        const updated = await importLocalCheckout({
          sourceDir: dirPath,
          slug,
          wikiRoot,
          incremental: opts.incremental ?? false,
          skipEnrich: opts.skipEnrich ?? false,
        });
        if (!team) {
          log.info(`Output written: ${wikiRoot}`);
        } else if (updated) {
          await autoPushTeamRepo(team.localConfig.repo.localPath, `[teamai] Import from local dir: ${slug}`);
          log.success(`Pushed to team knowledge repo (${team.localConfig.repo.remote})`);
        }
      } finally {
        await releaseImportLock();
      }
      log.success(`Local directory ${slug} import complete`);
    } else if (opts.fromClaude) {
      // 分支 3b：--from-claude，扫描规则文件并交互式导入
      const candidates = await scanCandidates({ fromClaude: true, dryRun: opts.dryRun });
      if (candidates.length === 0) {
        log.info('no importable files found');
        return;
      }
      const classified = await classifyWithAI(candidates);
      const session = await interactiveReview(classified, { all: opts.all, resume: opts.resume });
      const { localConfig } = await autoDetectInit(undefined, { dryRun: opts.dryRun });
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
