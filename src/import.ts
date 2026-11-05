import path from 'node:path';
import fs from 'fs-extra';

import { autoDetectInit } from './config.js';
import { importFromMR } from './import-mr.js';
import { importFromRepoList } from './import-repo-list.js';
import { importFromOrg } from './import-org.js';
import { indexableLearningsRoots } from './utils/learnings-roots.js';
import { pendingLearningsDir, queueWriteRefusal, savePendingLearning } from './utils/pending-learnings.js';
import type { GlobalOptions } from './types.js';
import { assertNotReadOnly } from './read-only.js';
import { log, setSilent } from './utils/logger.js';

/**
 * Extended options for the import command, merging global options with subcommand-specific options.
 */
interface ImportOptions extends GlobalOptions {
  /** Local directory path for scanning importable files */
  dir?: string;
  /** Import the rules of every AI coding tool */
  fromTools?: boolean;
  /** Alias of fromTools */
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
      const fromRepo = opts.fromRepo;
      const { previewRepoImport, repoSourceOf } = await import('./import-repo.js');
      // An unsupported or unsafe URL is refused before anything is written, the lock included.
      const source = repoSourceOf(fromRepo);
      const settings = { depth: opts.depth ? parseInt(opts.depth, 10) : 1, forceSsh: opts.ssh ?? false, incremental: opts.incremental ?? false, skipEnrich: opts.skipEnrich ?? false, maxFiles };

      if (opts.dryRun) {
        log.info(`Importing remote repo: ${source.owner}/${source.repo} (provider: ${source.providerName})`);
        await previewRepoImport(source, { ...settings, output: opts.output });

        return;
      }

      const { assertTeamwikiWritable, resolveTeamwiki } = await import('./utils/teamwiki-root.js');
      // Resolved before the run so a missing team repo fails fast.
      const target = await resolveTeamwiki({ output: opts.output });
      await assertTeamwikiWritable(target);

      const tasks = new Listr([
        {
          title: 'Import remote repository',
          task: async (ctx, task) => {
            task.output = `Repository: ${fromRepo}`;
            const { ImportFromRepo } = await import('./import-from-repo.js');

            const ended = await ImportFromRepo.start({
              mode: 'repo',
              items: [{ kind: 'repo', url: fromRepo, domain: opts.domain }],
              settings,
              target,
              command: 'teamai import --from-repo',
            });

            // A deep enrich that did not finish leaves the import done and its exit code 1, as the run said.
            const isImported = ended?.outcome === 'succeeded' && ImportFromRepo.importedOf(ended).some((entry) => !entry.failed);

            if (!isImported) throw new ImportRunFailed(`The import of ${fromRepo} did not finish; the failed step is named above.`);
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

            const imported = await importFromRepoList({
              listPath: opts.fromRepoList!,
              concurrency: Number(opts.concurrency ?? 3),
              forceSsh: opts.ssh ?? false,
              dryRun: opts.dryRun,
              output: opts.output,
              incremental: opts.incremental ?? false,
              skipEnrich: opts.skipEnrich ?? false,
              maxFiles,
            });

            // The run prints its own summary and exit code.
            if (imported.kind === 'preview') {
              task.title = imported.summary;

              if (imported.failed > 0) process.exitCode = 1;
            }
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
      const { ImportFromIwiki } = await import('./import-iwiki.js');

      await ImportFromIwiki.start({
        source: opts.fromIwiki,
        dual: opts.iwikiDual ?? false,
        requireReview: opts.requireReview ?? false,
        all: opts.all ?? false,
        output: opts.output,
        resume: opts.resume ?? false,
        command: 'teamai import --from-iwiki',
      });
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
        .catch((cause: unknown) => {
          log.warn(`The duplicate check reads the shared learnings only: ${cause instanceof Error ? cause.message : String(cause)}`);

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
            await rebuildIndexAfterContribute(localConfig).catch((cause: unknown) =>
              log.debug(`import: index rebuild skipped: ${cause instanceof Error ? cause.message : String(cause)}`));

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
            // One update per repository, with every MR of this run that named it
            // as its provenance.
            const mrUrlsByRepo = new Map<string, string[]>();

            for (const item of ctx.items) {
              if (!item.repoUrl) continue;
              mrUrlsByRepo.set(item.repoUrl, [...(mrUrlsByRepo.get(item.repoUrl) ?? []), item.url]);
            }

            const skipped: string[] = [];
            const { ImportFromRepo } = await import('./import-from-repo.js');
            const { repoSlugForUrl } = await import('./import-repo.js');

            for (const [repoUrl, sourceMrUrls] of mrUrlsByRepo) {
              // Non-blocking: a repository whose update failed is named, and the import still succeeds.
              const exitCode = process.exitCode;

              try {
                const slug = repoSlugForUrl(repoUrl);
                const evidenceDir = path.join(teamwikiRoot, 'evidence', 'code', slug);

                if (!(await fs.pathExists(evidenceDir))) {
                  skipped.push(`No existing evidence for ${slug}`);
                  continue;
                }

                task.output = `Updating ${slug}...`;

                const ended = await ImportFromRepo.start({
                  mode: 'update',
                  items: [{ kind: 'repo', url: repoUrl, mrUrls: sourceMrUrls }],
                  settings: { depth: 1, forceSsh: false, incremental: true, skipEnrich: false },
                  target: { wikiRoot: teamwikiRoot, team: { localConfig, teamConfig } },
                  command: 'teamai import --from-mr',
                });

                if (ImportFromRepo.importedOf(ended).some((entry) => !entry.failed)) ctx.didUpdate = true;
                else skipped.push(`Incremental update skipped: the import of ${slug} failed`);
              } catch (e) {
                skipped.push(`Incremental update skipped: ${e instanceof Error ? e.message : String(e)}`);
              } finally {
                process.exitCode = exitCode;
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

      // <output>/teamwiki, else the team repo's teamwiki/; never the source directory.
      const { assertTeamwikiWritable, resolveTeamwiki } = await import('./utils/teamwiki-root.js');

      if (opts.dryRun) {
        const { defaultProjectSlug } = await import('./codebase-extract.js');
        const { localCheckoutSlug } = await import('./import-codebase.js');
        const dirSlug = await defaultProjectSlug(dirPath);
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
      await assertTeamwikiWritable(target);
      const { ImportFromRepo } = await import('./import-from-repo.js');

      await ImportFromRepo.start({
        mode: 'dir',
        items: [{ kind: 'dir', dir: dirPath }],
        settings: { depth: 1, forceSsh: false, incremental: opts.incremental ?? false, skipEnrich: opts.skipEnrich ?? false, maxFiles },
        target,
        command: 'teamai import --dir',
      });
    } else if (opts.fromTools || opts.fromClaude) {
      const { ImportLearnings } = await import('./import-local.js');

      await ImportLearnings.startRules({
        all: opts.all ?? false,
        output: opts.output,
        resume: opts.resume ?? false,
        command: opts.fromTools ? 'teamai import --from-tools' : 'teamai import --from-claude',
      });
    } else {
      // 默认：未指定来源，提示用户
      log.info('Please specify import source: --dir <path>, --from-repo <url>, --from-repo-list <yaml>, --from-org <org>, --from-mr <url>, --from-tools, or --from-iwiki <id>');

      return;
    }
  } catch (err: unknown) {
    // A run that failed already named the step that failed.
    if (!(err instanceof ImportRunFailed)) log.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

/** A teamai-import-from-repo run that a Listr task started did not succeed; its steps already said why. */
class ImportRunFailed extends Error {
  readonly name = 'ImportRunFailed';
}
