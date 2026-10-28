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
  /** Extract knowledge from one or more merged MR/PR URLs */
  fromMr?: string | string[];
  /** Read the MR's review threads into the extraction; `--no-discussions` sets false (#1187) */
  discussions?: boolean;
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
  /** Maximum concurrent repositories for --from-repo-list, default 3. */
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
  /** --max-files: cap on source files collected per repository (string, requires parseInt; default 200) */
  maxFiles?: string;
}

/** What one `--from-mr` URL produced: its draft, where it was written, and the repo it names. */
interface MrExtraction {
  url: string;
  learning?: { title: string; content: string };
  repoUrl: string;
  learningFile?: string;
}

/**
 * `--dir` wrote a checkout with an origin under its directory name before it
 * took the remote's slug. A role or project that scoped that name under
 * `resources.wiki` no longer matches the codebase, which recall then shares
 * with everyone: name them so the team can update the entry.
 */
async function warnStaleWikiScopes(scope: { teamRepo: string; legacySlug: string; slug: string }): Promise<void> {
  const { legacySlug, slug } = scope;
  let declarers: string[];
  try {
    const { loadRolesManifestIfPresent } = await import('./roles.js');
    const { loadProjectsManifest } = await import('./projects.js');
    const [roles, projects] = await Promise.all([
      loadRolesManifestIfPresent(scope.teamRepo),
      loadProjectsManifest(scope.teamRepo),
    ]);
    declarers = [
      ...(roles?.roles ?? []).filter((role) => role.resources.wiki?.includes(legacySlug)).map((role) => `role ${role.id}`),
      ...(projects?.projects ?? []).filter((project) => project.resources.wiki?.includes(legacySlug)).map((project) => `project ${project.id}`),
    ];
  } catch (err) {
    // The import already succeeded; a manifest pull would reject is reported there.
    log.debug(`resources.wiki check skipped: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  const [only, ...more] = declarers;
  if (!only) return;
  if (more.length === 0) {
    log.warn(`${only} lists "${legacySlug}" under resources.wiki, and this codebase is now teamwiki/evidence/code/${slug}/. `
      + `Change that entry to "${slug}" so it stays scoped to it.`);
  } else {
    log.warn(`${declarers.join(' and ')} list "${legacySlug}" under resources.wiki, and this codebase is now teamwiki/evidence/code/${slug}/. `
      + `Change those entries to "${slug}" so it stays scoped to them.`);
  }
}

/** Parse --max-files: a positive integer, or undefined to keep the extractor's default. */
function parseMaxFiles(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error('--max-files must be a positive integer');
  }
  return parsed;
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
    const maxFiles = parseMaxFiles(opts.maxFiles);
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
              maxFiles,
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
              concurrency: Number(opts.concurrency ?? 3),
              forceSsh: opts.ssh ?? false,
              dryRun: opts.dryRun,
              output: opts.output,
              incremental: opts.incremental ?? false,
              skipEnrich: opts.skipEnrich ?? false,
              maxFiles,
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
    } else if (opts.fromMr && (!Array.isArray(opts.fromMr) || opts.fromMr.length > 0)) {
      // 分支 1：--from-mr <url...>，提取 learning + 增量更新 teamwiki
      // Several URLs in one run: each draft is confirmed on its own, the accepted
      // learnings are published once, and each repository's teamwiki is updated
      // once (#1104). One MR failing does not stop the rest.
      const mrUrls = Array.isArray(opts.fromMr) ? opts.fromMr : [opts.fromMr];
      const { localConfig, teamConfig } = await autoDetectInit(undefined, { dryRun: opts.dryRun });
      // A workspace reads its children's learnings too (#913).
      const { deliveredLearningsNamespaces } = await import('./workspace-children.js');
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
      const learningsNamespaces = await deliveredLearningsNamespaces(localConfig)
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
      const learningsDirs = [pendingLearningsDir(localConfig), ...(await indexableLearningsRoots(localConfig))];
      const extractedAll: MrExtraction[] = [];
      const failedMrs: Array<{ url: string; error: string }> = [];

      for (const [index, url] of mrUrls.entries()) {
        if (mrUrls.length > 1) log.info(`[${index + 1}/${mrUrls.length}] ${url}`);
        try {
          const extracted = await importFromMR({
            url,
            // Not another repository's learnings checkout (#808).
            learningsDirs,
            learningsNamespaces,
            all: opts.all,
            outputDir: opts.output,
            // One `learning.md` per directory would be overwritten by the next MR.
            outputFileName: mrUrls.length > 1 ? `learning-${index + 1}.md` : undefined,
            // Into the contribution queue, which publishing drains (#823).
            queueLearning: opts.dryRun ? undefined : async (filename, content) => {
              const queued = await savePendingLearning(localConfig, path.posix.join(learningsSubdir, filename), content);
              if (queued.status !== 'saved') throw new Error(queueWriteRefusal(queued));
              return queued.path;
            },
            dryRun: opts.dryRun,
            discussions: opts.discussions,
            // `language: en` in teamai.yaml makes the learning English (#1187).
            language: teamConfig?.language,
          });
          extractedAll.push({ url, ...extracted });
        } catch (e: unknown) {
          // A single URL keeps reporting its failure as before.
          if (mrUrls.length === 1) throw e;
          const message = e instanceof Error ? e.message : String(e);
          log.warn(`import from MR failed: ${url} — ${message}`);
          failedMrs.push({ url, error: message });
        }
      }

      const tasks = new Listr([
        {
          title: 'Publish learning',
          skip: (ctx) => !!opts.dryRun || !!opts.output || !ctx.items.some((item) => item.learning),
          task: async (ctx, task) => {
            const { publishQueuedLearnings } = await import('./utils/learnings-publish.js');
            const { rebuildIndexAfterContribute } = await import('./contribute.js');
            // One publish for the whole run: it drains the queue every accepted
            // learning was written into.
            const report = await publishQueuedLearnings(localConfig, localConfig.username);
            // Recall finds them where they are now: published, or still queued.
            await rebuildIndexAfterContribute(localConfig).catch((e: unknown) =>
              log.debug(`import: index rebuild skipped: ${e instanceof Error ? e.message : String(e)}`));
            const queued = ctx.items
              .filter((item) => item.learningFile)
              .map((item) => path.posix.join(learningsSubdir, path.basename(item.learningFile ?? '')));
            const unpublished = queued.filter((file) => !report.published.includes(file));
            if (report.installChanged) {
              const { KEPT_FOR_ITS_INSTALL } = await import('./contribute.js');
              task.title = `Learning saved locally, not published: ${report.installChanged}. ${KEPT_FOR_ITS_INSTALL}`;
            } else if (report.refused) {
              const { KEPT_UNTIL_CHECKOUT_SETTLED } = await import('./contribute.js');
              task.title = `Learning saved locally (${report.lastError ?? 'not published yet'}). ${KEPT_UNTIL_CHECKOUT_SETTLED}`;
            } else if (unpublished.length > 0 && queued.length === 1) {
              task.title = `Learning saved locally (${report.lastError ?? 'not published yet'}); `
                + 'the next `teamai pull` publishes it';
            } else if (unpublished.length > 0) {
              task.title = `${unpublished.length} of ${queued.length} learning(s) saved locally `
                + `(${report.lastError ?? 'not published yet'}); the next \u0060teamai pull\u0060 publishes them`;
            } else if (queued.length > 1) {
              task.title = `Published ${queued.length} learnings`;
            }
          },
          rendererOptions: { persistentOutput: true },
        },
        {
          title: 'Incremental teamwiki update',
          skip: (ctx) => !ctx.items.some((item) => item.repoUrl) || !!opts.dryRun || !!opts.output,
          task: async (ctx, task) => {
            const teamwikiRoot = path.join(localConfig.repo.localPath, 'teamwiki');
            const { repoSlugForUrl } = await import('./import-repo.js');
            // One update per repository, with every MR of this run that named it
            // as its provenance.
            const mrUrlsByRepo = new Map<string, string[]>();
            for (const item of ctx.items) {
              if (!item.repoUrl) continue;
              mrUrlsByRepo.set(item.repoUrl, [...(mrUrlsByRepo.get(item.repoUrl) ?? []), item.url]);
            }
            const skipped: string[] = [];
            for (const [repoUrl, sourceMrUrls] of mrUrlsByRepo) {
              try {
                const slug = repoSlugForUrl(repoUrl);
                const evidenceDir = path.join(teamwikiRoot, 'evidence', 'code', slug);
                if (!(await fs.pathExists(evidenceDir))) {
                  skipped.push(`No existing evidence for ${slug}`);
                  continue;
                }
                task.output = `Updating ${slug}...`;
                await importFromRepo({
                  url: repoUrl,
                  incremental: true,
                  skipAutoPush: true,
                  sourceMrUrl: sourceMrUrls,
                });
                ctx.didUpdate = true;
              } catch (e) {
                skipped.push(`Incremental update skipped: ${(e as Error).message}`);
              }
            }
            // The index covers the whole teamwiki, so it is rebuilt once.
            if (ctx.didUpdate) {
              try {
                const { rebuildWikiIndex } = await import('./rebuild-wiki-index.js');
                await rebuildWikiIndex(teamwikiRoot);
              } catch (e) {
                const msg = e instanceof Error ? e.message : String(e);
                log.warn(`[wiki] global index rebuild failed (non-blocking): ${msg}`);
              }
            }
            if (skipped.length > 0) {
              const reasons = skipped.join('; ');
              if (ctx.didUpdate) task.output = reasons;
              else task.skip(reasons);
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
              `[teamai] Import from MR: ${mrUrls.join(', ')}`,
              ['.'],
              { repo: teamConfig.repo, provider: teamConfig.provider, reviewers: teamConfig.reviewers },
              { repo: localConfig.repo, username: localConfig.username, provider: localConfig.provider },
            );
          },
        },
      ], {
        rendererOptions: { timer: PRESET_TIMER, collapseErrors: false },
        exitOnError: true,
        ctx: { items: extractedAll, didUpdate: false },
      });
      setSilent(true);
      try { await tasks.run(); } finally { setSilent(false); }
      if (mrUrls.length > 1) {
        log.info(`Import from MR complete: ${extractedAll.length} succeeded, ${failedMrs.length} failed`);
        for (const failure of failedMrs) log.info(`  failed: ${failure.url}: ${failure.error}`);
      }
      // As --from-repo-list reports a partial batch.
      if (failedMrs.length > 0) process.exitCode = 1;
    } else if (opts.dir) {
      // 分支 3：--dir <path>，代码知识提取（等同于 --from-repo 但跳过 clone）
      const dirPath = path.resolve(opts.dir);
      if (!(await fs.pathExists(dirPath))) {
        throw new Error(`Directory not found: ${dirPath}`);
      }
      const { checkoutName, defaultProjectSlug } = await import('./codebase-extract.js');
      const dirSlug = await defaultProjectSlug(dirPath);
      const checkoutSlug = await checkoutName(dirPath);

      // <output>/teamwiki, else the team repo's teamwiki/; never the source directory.
      const { lockTeamwiki, resolveTeamwiki } = await import('./utils/teamwiki-root.js');
      const { importLocalCheckout, localCheckoutSlug, ownLegacySlug } = await import('./import-codebase.js');

      if (opts.dryRun) {
        // The slug depends on the evidence already published, so the preview reads
        // it; a preview without a teamwiki still reports what it can.
        const preview = await resolveTeamwiki({ output: opts.output, dryRun: true }).catch(() => undefined);
        const slug = preview ? await localCheckoutSlug({ sourceDir: dirPath, slug: dirSlug, wikiRoot: preview.wikiRoot }) : dirSlug;
        log.info(`Scanning local directory: ${dirPath} (project: ${slug})`);
        log.info(`[dry-run] skipping code extraction, no action taken`);
        log.success(`Local directory ${slug} import complete (dry-run)`);
        return;
      }

      const target = await resolveTeamwiki({ output: opts.output });
      const { wikiRoot, team } = target;
      const releaseImportLock = await lockTeamwiki(target);
      try {
        const slug = await localCheckoutSlug({ sourceDir: dirPath, slug: dirSlug, wikiRoot });
        // A checkout that gained an origin may have published under a suffix before.
        const legacySlug = slug === dirSlug && checkoutSlug !== slug
          ? await ownLegacySlug({ sourceDir: dirPath, slug: checkoutSlug, wikiRoot })
          : checkoutSlug;
        log.info(`Scanning local directory: ${dirPath} (project: ${slug})`);
        const updated = await importLocalCheckout({
          sourceDir: dirPath,
          slug,
          // A suffixed slug is a new codebase; the directory-named evidence is another source's.
          ...(slug === dirSlug ? { legacySlug } : {}),
          wikiRoot,
          incremental: opts.incremental ?? false,
          skipEnrich: opts.skipEnrich ?? false,
          maxFiles,
        });
        // While the old name still holds evidence (another repo's, or a copy the
        // import warned about), a scope on it still points at that evidence. A
        // suffixed checkout was never published under the old name, so such a
        // scope is not its own.
        if (team && slug === dirSlug && legacySlug !== slug
          && !(await fs.pathExists(path.join(wikiRoot, 'evidence', 'code', legacySlug)))) {
          await warnStaleWikiScopes({ teamRepo: team.localConfig.repo.localPath, legacySlug, slug });
        }
        if (!team) {
          log.info(`Output written: ${wikiRoot}`);
        } else if (updated) {
          await autoPushTeamRepo(team.localConfig.repo.localPath, `[teamai] Import from local dir: ${slug}`);
          log.success(`Pushed to team knowledge repo (${team.localConfig.repo.remote})`);
        }
        log.success(`Local directory ${slug} import complete`);
      } finally {
        await releaseImportLock();
      }
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
