import path from 'node:path';
import fs from 'fs-extra';

import { importFromRepoList } from './import-repo-list.js';
import { importFromOrg } from './import-org.js';
import type { GlobalOptions } from './types.js';
import { log } from './utils/logger.js';

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
        dryRun: opts.dryRun ?? false,
        command: 'teamai import --from-iwiki',
      });
    } else if (opts.fromMr && (!Array.isArray(opts.fromMr) || opts.fromMr.length > 0)) {
      const { ImportFromMr } = await import('./import-from-mr.js');

      await ImportFromMr.start({
        mrs: Array.isArray(opts.fromMr) ? opts.fromMr : [opts.fromMr],
        all: opts.all ?? false,
        output: opts.output,
        discussions: opts.discussions ?? true,
        dryRun: opts.dryRun ?? false,
        command: 'teamai import --from-mr',
      });
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
        dryRun: opts.dryRun ?? false,
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
