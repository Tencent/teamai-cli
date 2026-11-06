/**
 * The default workflow `teamai-import-from-repo`, which `teamai import --dir`, `--from-repo`, `--from-repo-list` and
 * `--from-org` start: `start` takes the import lock of the teamwiki and runs it, and the `teamai import` verbs its steps
 * call stage each item, publish it, finish it, and finish the batch.
 */
import path from 'node:path';

import chalk from 'chalk';
import fs from 'fs-extra';
import { z } from 'zod';

import type { TeamwikiTarget } from './utils/teamwiki-root.js';
import type { ShortcutEnd } from './workflow-commands.js';
import { RUN_DIR_ENV } from './launch-context.js';
import { log } from './utils/logger.js';

const WORKFLOW = 'teamai-import-from-repo';

/** The command that started an import, which says how its batch is published and summed up. */
const ImportModeSchema = z.enum(['dir', 'repo', 'list', 'org', 'update', 'ci']);

export type ImportMode = z.infer<typeof ImportModeSchema>;

/** An item as the workflow's `items` input carries it: every field present, '' when not given. */
const ItemInputSchema = z.object({
  kind: z.enum(['repo', 'dir']),
  source: z.string().min(1),
  domain: z.string(),
  auth: z.enum(['', 'token', 'ssh', 'public']),
  slug: z.string(),
  repo_url: z.string(),
  mr_urls: z.array(z.string()),
});

type ItemInput = z.infer<typeof ItemInputSchema>;

/**
 * What one item of an import reads: a remote repository, with the business domain and the auth of its list entry, or a
 * local checkout, with the slug and repository URL `ci extract-mr` names for it. `mrUrls` are the MRs recorded as
 * ingested in its source-manifest.json.
 */
export type ImportItem =
  | { kind: 'repo'; url: string; domain?: string; auth?: 'token' | 'ssh' | 'public'; mrUrls?: string[] }
  | { kind: 'dir'; dir: string; slug?: string; repoUrl?: string; mrUrls?: string[] };

const ImportItemSchema = ItemInputSchema.transform((input): ImportItem => {
  const given = (value: string): string | undefined => (value === '' ? undefined : value);

  const mrUrls = input.mr_urls.length > 0 ? input.mr_urls : undefined;

  if (input.kind === 'repo') return { kind: 'repo', url: input.source, domain: given(input.domain), auth: input.auth === '' ? undefined : input.auth, mrUrls };

  return { kind: 'dir', dir: input.source, slug: given(input.slug), repoUrl: given(input.repo_url), mrUrls };
});

function itemInput(item: ImportItem): ItemInput {
  return item.kind === 'repo'
    ? { kind: 'repo', source: item.url, domain: item.domain ?? '', auth: item.auth ?? '', slug: '', repo_url: '', mr_urls: item.mrUrls ?? [] }
    : { kind: 'dir', source: item.dir, domain: '', auth: '', slug: item.slug ?? '', repo_url: item.repoUrl ?? '', mr_urls: item.mrUrls ?? [] };
}

/** The workflow's `settings` input. `max_files` 0 keeps the extractor's default; `team_repo` '' when no team repo holds the teamwiki. */
const SettingsInputSchema = z.object({
  depth: z.number().int().positive(),
  ssh: z.boolean(),
  incremental: z.boolean(),
  skip_enrich: z.boolean(),
  max_files: z.number().int().nonnegative(),
  team_repo: z.string(),
});

type SettingsInput = z.infer<typeof SettingsInputSchema>;

/** How every item of an import is read. */
export interface ImportSettings {
  /** Shallow clone depth of a repository. */
  depth: number;
  forceSsh: boolean;
  incremental: boolean;
  skipEnrich: boolean;
  /** Cap on source files collected per codebase; undefined keeps the extractor's default. */
  maxFiles?: number;
}

/** A verb's flag that is not what its workflow step passes: the step fails input_rejected. */
export class ImportInputError extends Error {
  readonly name = 'ImportInputError';
}

function parseFlag<T>(schema: z.ZodType<T>, flag: string, raw: string): T {
  let json: unknown;

  try {
    json = JSON.parse(raw);
  } catch {
    throw new ImportInputError(`${flag} is not JSON. Pass what the ${WORKFLOW} step passes.`);
  }

  const parsed = schema.safeParse(json);

  if (!parsed.success) throw new ImportInputError(`${flag} is not what the ${WORKFLOW} step passes: ${parsed.error.message}`);

  return parsed.data;
}

/** The flags every step of an item passes. */
function itemFlags(flags: { item: string; settings: string }) {
  return { item: parseFlag(ImportItemSchema, '--item', flags.item), settings: parseFlag(SettingsInputSchema, '--settings', flags.settings) };
}

/**
 * Imports `items` into the teamwiki `target` names through a `teamai-import-from-repo` run, as the command `command`
 * does, under the teamwiki's import lock, which refuses while another import writes it. At most `concurrency` items are in progress at once.
 * A teamwiki outside a team repo needs no teamai init: the run then builds a config of its own.
 *
 * @throws ImportLockHeldError when another import holds the teamwiki's lock
 */
async function start({ mode, items, settings, target, skipped = 0, concurrency = 1, command }: {
  mode: ImportMode;
  items: ImportItem[];
  settings: ImportSettings;
  target: TeamwikiTarget;
  skipped?: number;
  concurrency?: number;
  command: string;
}): Promise<ShortcutEnd | undefined> {
  const { lockTeamwiki } = await import('./utils/teamwiki-root.js');
  const { runShortcut } = await import('./workflow-commands.js');
  const { setStderrOnly } = await import('./utils/logger.js');
  const releaseLock = await lockTeamwiki(target);
  const stderrOnly = setStderrOnly(false);
  setStderrOnly(stderrOnly);

  const settingsInput: SettingsInput = {
    depth: settings.depth,
    ssh: settings.forceSsh,
    incremental: settings.incremental,
    skip_enrich: settings.skipEnrich,
    max_files: settings.maxFiles ?? 0,
    team_repo: mode === 'ci' ? '' : target.team?.localConfig.repo.localPath ?? '',
  };

  try {
    return await runShortcut({
      workflow: WORKFLOW,
      inputs: { wiki_root: target.wikiRoot, mode, items: items.map(itemInput), settings: { ...settingsInput }, skipped, concurrency },
      command,
      json: false,
    });
  } finally {
    // What the command says after the run goes where it went before the run.
    setStderrOnly(stderrOnly);
    await releaseLock();
  }
}

/** What `teamai import stage` prints: the item's staged evidence, and what the steps after it do. */
export interface StagedItem {
  slug: string;
  /** The staging directory, whose `teamwiki/` holds the extracted evidence; '' when nothing was staged. */
  stage: string;
  /** Whether the extract found anything to publish. */
  updated: boolean;
  /** Whether teamai-codebase-enrich enriches the staged evidence. */
  enrich: boolean;
  /** Whether the AI tool writes the repository's narrative, from `context`. */
  narrate: boolean;
  context: string;
  /** The commit a repository was fetched at; '' for a checkout. */
  head: string;
  /** Whether the item is already done: an incremental import of a repository the teamwiki holds unchanged. */
  finished: boolean;
}

/**
 * `teamai import stage`: fetch a repository into its clone cache, or read a checkout, and extract it into a staging
 * teamwiki under the run's `$TEAMAI_RUN_DIR`. Nothing is asked of an AI tool and the teamwiki is not written.
 */
async function stage(flags: { item: string; settings: string; wikiRoot: string }): Promise<StagedItem> {
  const { item, settings } = itemFlags(flags);
  const runDir = process.env[RUN_DIR_ENV];

  if (!runDir) throw new ImportInputError(`${RUN_DIR_ENV} is not set. teamai import stage is a step of a ${WORKFLOW} run.`);
  const wikiRoot = path.resolve(flags.wikiRoot);
  const { extractToStaging } = await import('./import-codebase.js');
  const extract = { wikiRoot, incremental: settings.incremental, skipEnrich: settings.skip_enrich, maxFiles: settings.max_files || undefined };
  const stagingRoot = async (): Promise<string> => fs.mkdtemp(path.join(runDir, 'import-'));

  /** Extracts into a new staging directory, removed again unless it holds evidence to publish. */
  const staged = async (opts: Omit<Parameters<typeof extractToStaging>[0], 'stagingRoot'>): Promise<string | undefined> => {
    const root = await stagingRoot();
    let isUpdated = false;

    try {
      isUpdated = await extractToStaging({ ...opts, stagingRoot: root });
    } finally {
      if (!isUpdated) await fs.remove(root);
    }

    return isUpdated ? root : undefined;
  };

  if (item.kind === 'repo') {
    const { fetchRepo, repoSourceOf } = await import('./import-repo.js');
    const source = repoSourceOf(item.url);
    const { owner, repo, providerName, cacheDir, slug } = source;
    log.info(`Importing remote repo: ${owner}/${repo} (provider: ${providerName})`);

    const fetched = await fetchRepo(source, {
      depth: settings.depth,
      forceSsh: item.auth === 'ssh' || settings.ssh,
      forceAnonymous: item.auth === 'public',
      incremental: settings.incremental,
      evidenceDest: path.join(wikiRoot, 'evidence', 'code', slug),
    });

    if (fetched.kind === 'unchanged') return { slug, stage: '', updated: false, enrich: false, narrate: false, context: '', head: fetched.sha, finished: true };
    log.info('Scanning repository...');

    if (settings.skip_enrich) log.debug('AI enrichment skipped (--skip-enrich)');
    let stagingDir: string | undefined;

    try {
      stagingDir = await staged({ ...extract, sourceDir: cacheDir, slug, repoUrl: item.url, branch: fetched.branch === 'HEAD' ? undefined : fetched.branch, sourceMrUrl: item.mrUrls });
    } catch (err) {
      throw new Error(`Knowledge extraction failed: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
    }

    if (!stagingDir) log.info(chalk.green(`✓ ${slug}: no source changes since the last import, teamwiki unchanged`));
    const narrate = stagingDir !== undefined && !settings.skip_enrich;
    const { gatherRepoContext } = await import('./codebase.js');

    return {
      slug, stage: stagingDir ?? '', updated: stagingDir !== undefined, enrich: narrate, narrate, context: narrate ? await gatherRepoContext(cacheDir) : '', head: fetched.sha, finished: false,
    };
  }

  const dir = path.resolve(item.dir);

  if (!(await fs.pathExists(dir))) throw new Error(`Directory not found: ${dir}`);
  let { slug } = item;

  if (slug === undefined) {
    const { defaultProjectSlug } = await import('./codebase-extract.js');
    const { localCheckoutSlug } = await import('./import-codebase.js');
    slug = await localCheckoutSlug({ sourceDir: dir, slug: await defaultProjectSlug(dir), wikiRoot });
    log.info(`Scanning local directory: ${dir} (project: ${slug})`);
  }

  const stagingDir = await staged({ ...extract, sourceDir: dir, slug, repoUrl: item.repoUrl, sourceMrUrl: item.mrUrls });

  if (!stagingDir) log.info(`${slug}: no source changes since the last import, teamwiki unchanged`);

  return { slug, stage: stagingDir ?? '', updated: stagingDir !== undefined, enrich: stagingDir !== undefined && !settings.skip_enrich, narrate: false, context: '', head: '', finished: false };
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

/**
 * `teamai import publish`: publish an item's staged evidence into the teamwiki, with the narrative the AI tool wrote for
 * a repository and the domain its list entry names, then reconcile the teamwiki. Answers whether deep enrich follows.
 */
async function publish(flags: { item: string; settings: string; wikiRoot: string; stage: string; slug: string; narrative: string; narrativeFailure: string }): Promise<{ deep: boolean }> {
  const { item, settings } = itemFlags(flags);
  const wikiRoot = path.resolve(flags.wikiRoot);
  const { slug } = flags;
  const evidenceDest = path.join(wikiRoot, 'evidence', 'code', slug);
  const { publishStaging, reconcileTeamwiki } = await import('./import-codebase.js');
  const published = { stagingRoot: flags.stage, slug, wikiRoot, skipEnrich: settings.skip_enrich };

  if (item.kind === 'repo') {
    const { repoSourceOf, writeExplicitDomain, writeRepoNarrative } = await import('./import-repo.js');
    await publishStaging({ ...published, sourceDir: repoSourceOf(item.url).cacheDir });

    if (flags.narrativeFailure) log.warn(`AI codebase scan failed (non-blocking): ${flags.narrativeFailure}`);

    if (flags.narrative) await writeRepoNarrative(evidenceDest, slug, flags.narrative);

    if (item.domain) await writeExplicitDomain(evidenceDest, item.domain);
    log.info(chalk.green(`✓ teamwiki/ knowledge graph updated: ${slug}`));
  } else {
    const dir = path.resolve(item.dir);
    // A checkout `ci extract-mr` names has its slug; one `--dir` names may have published under another before.
    const legacy = item.slug === undefined ? await legacySlugOf(dir, slug, wikiRoot) : undefined;
    await publishStaging({ ...published, sourceDir: dir, legacySlug: legacy?.adopt });
    log.info(`teamwiki/ knowledge graph updated: ${slug}`);

    // While the old name still holds evidence (another repo's, or a copy the import warned about), a scope on it still
    // points at that evidence. A suffixed checkout was never published under the old name, so such a scope is not its own.
    if (settings.team_repo && legacy?.scoped && legacy.scoped !== slug
      && !(await fs.pathExists(path.join(wikiRoot, 'evidence', 'code', legacy.scoped)))) {
      await warnStaleWikiScopes({ teamRepo: settings.team_repo, legacySlug: legacy.scoped, slug });
    }
  }

  await fs.remove(flags.stage);
  await reconcileTeamwiki(wikiRoot);

  return { deep: !settings.skip_enrich && await fs.pathExists(path.join(evidenceDest, '_manifest.json')) };
}

/**
 * The names a `--dir` checkout may have published under before `slug`: `adopt`, whose evidence moves to `slug`, and
 * `scoped`, a name a `resources.wiki` entry may still use. A suffixed slug is a new codebase: the directory-named
 * evidence is another source's, so it adopts none and no scope is its own.
 */
async function legacySlugOf(dir: string, slug: string, wikiRoot: string): Promise<{ adopt?: string; scoped?: string }> {
  const { checkoutName, defaultProjectSlug } = await import('./codebase-extract.js');
  const { ownLegacySlug } = await import('./import-codebase.js');
  const [dirSlug, checkoutSlug] = await Promise.all([defaultProjectSlug(dir), checkoutName(dir)]);

  if (slug !== dirSlug) return {};
  // A checkout that gained an origin may have published under a suffix before.
  const legacySlug = checkoutSlug !== slug ? await ownLegacySlug({ sourceDir: dir, slug: checkoutSlug, wikiRoot }) : checkoutSlug;

  return { adopt: legacySlug, scoped: legacySlug };
}

/** Tells the person who ran an import how to finish the deep enrich of `slug`, in the teamwiki it imported into. */
async function warnIncomplete({ slug, teamRepo, wikiRoot }: { slug: string; teamRepo: string; wikiRoot: string }): Promise<void> {
  const { warnIncompleteDeepEnrich } = await import('./import-codebase.js');
  warnIncompleteDeepEnrich({ slug, output: teamRepo ? undefined : path.dirname(path.resolve(wikiRoot)) });
}

/** `--deep` as `teamai import finish-item` reads it: the deep-enrich run said complete, said incomplete, or did not run. */
const DeepFlagSchema = z.enum(['true', 'false', '']);

/**
 * `teamai import finish-item`: say how an item's deep enrich ended, a failed one as one that did not finish, and record
 * the commit a repository was imported at. Answers whether its deep enrich finished (true when none ran).
 */
async function finishItem(flags: { item: string; settings: string; wikiRoot: string; mode: string; slug: string; head: string; deep: string; deepFailure: string }): Promise<{ deep_complete: boolean }> {
  const { item, settings } = itemFlags(flags);
  const mode = parseFlag(ImportModeSchema, '--mode', JSON.stringify(flags.mode));
  const { slug } = flags;

  if (flags.deepFailure) log.warn(`Deep enrich failed for ${slug}: ${flags.deepFailure}`);
  const deep = flags.deepFailure ? 'false' : parseFlag(DeepFlagSchema, '--deep', JSON.stringify(flags.deep));

  if (deep === 'true') log.info(`Deep enrich complete: ${slug}`);

  // A batch says how to finish each repository as it settles; a single import says it once it is published (finish).
  if (deep === 'false' && (mode === 'list' || mode === 'org')) await warnIncomplete({ slug, teamRepo: settings.team_repo, wikiRoot: flags.wikiRoot });

  if (item.kind === 'repo' && flags.head) {
    const { recordRepoSync, repoSourceOf } = await import('./import-repo.js');
    const source = repoSourceOf(item.url);
    await recordRepoSync(source, flags.head);

    // A single --from-repo says it once its batch is published.
    if (mode !== 'repo') log.info(chalk.green(`✓ Repo ${source.owner}/${source.repo} import complete`));
  }

  return { deep_complete: deep !== 'false' };
}

/** The results of the imports step: each item, how it settled, and what it said. */
const ImportResultsSchema = z.array(z.object({
  item: ItemInputSchema,
  outcome: z.string(),
  outputs: z.object({ slug: z.string().nullish(), updated: z.boolean().nullish(), deep_complete: z.boolean().nullish() }).nullish(),
}));

/** What one item of an import did, as `teamai import finish` prints it in the run's outputs. */
export interface ImportedItem {
  source: string;
  slug: string;
  updated: boolean;
  failed: boolean;
}

/** What the run says once its batch is finished. */
export interface ImportEnd {
  text: string;
  exit_code: number;
  imported: ImportedItem[];
}

/**
 * `teamai import finish`: once every item settled, rebuild the teamwiki indexes, publish the batch to the team repo as
 * the command always did (a checkout is pushed, repositories go on an MR branch; `ci extract-mr`, `import --from-mr` and
 * `codebase --upgrade-wiki` publish themselves), and sum the batch up. Exits 1 when an item failed or its deep enrich did not finish.
 */
async function finish(flags: { mode: string; wikiRoot: string; settings: string; skipped: string; results: string }): Promise<ImportEnd> {
  const mode = parseFlag(ImportModeSchema, '--mode', JSON.stringify(flags.mode));
  const settings = parseFlag(SettingsInputSchema, '--settings', flags.settings);
  const skipped = parseFlag(z.number().int().nonnegative(), '--skipped', flags.skipped);
  const results = parseFlag(ImportResultsSchema, '--results', flags.results);
  const wikiRoot = path.resolve(flags.wikiRoot);

  const imported = results.map(({ item, outcome, outputs }): ImportedItem => ({
    source: item.source, slug: outputs?.slug ?? '', updated: outputs?.updated ?? false, failed: outcome !== 'success',
  }));

  const failed = imported.filter((entry) => entry.failed);
  const succeeded = imported.length - failed.length;
  const isIncomplete = results.some(({ outputs }) => outputs?.deep_complete === false);
  const isUpdated = imported.some((entry) => entry.updated);
  const end = (text: string): ImportEnd => ({ text, exit_code: failed.length > 0 || isIncomplete ? 1 : 0, imported });
  const { publishTeamwikiViaMR, refreshTeamwikiIndexes } = await import('./import-codebase.js');
  const team = settings.team_repo ? await teamOf(settings.team_repo) : undefined;

  switch (mode) {
    case 'list':
    case 'org': {
      for (const entry of failed) log.warn(`import failed: ${entry.source}`);

      // Rebuilt once for the batch, so the items never race on router.md and index.md.
      if (succeeded > 0 && await fs.pathExists(wikiRoot)) {
        await refreshTeamwikiIndexes(wikiRoot);
        log.info('teamwiki router.md / index.md rebuilt');
      }

      if (team && succeeded > 0) {
        const { DetachedTeamRepoError } = await import('./utils/git.js');

        try {
          await publishTeamwikiViaMR(team, '[teamai] Batch import: graph');
        } catch (e) {
          DetachedTeamRepoError.rethrow(e);
          log.warn(`[git] batch push failed (non-blocking): ${e instanceof Error ? e.message : String(e)}`);
        }
      }

      return end(`Batch import complete: ${succeeded} succeeded, ${failed.length} failed, ${skipped} skipped`);
    }

    case 'repo': {
      const [only] = results;

      if (!only || failed.length > 0) return end('');

      const { repoSourceOf } = await import('./import-repo.js');
      const { owner, repo } = repoSourceOf(only.item.source);

      if (isUpdated) {
        await refreshTeamwikiIndexes(wikiRoot);

        if (team) await publishTeamwikiViaMR(team, `[teamai] Import codebase knowledge from ${owner}/${repo}`);
      }

      log.info(chalk.green(`✓ Repo ${owner}/${repo} import complete`));

      if (isIncomplete) await warnIncomplete({ slug: only.outputs?.slug ?? '', teamRepo: settings.team_repo, wikiRoot });

      return end('');
    }

    case 'dir': {
      const [only] = imported;

      if (!only || only.failed) return end('');

      if (isUpdated) await refreshTeamwikiIndexes(wikiRoot);

      if (!team) {
        log.info(`Output written: ${wikiRoot}`);
      } else if (isUpdated) {
        const { autoPushTeamRepo } = await import('./utils/git.js');
        await autoPushTeamRepo(team.localConfig.repo.localPath, `[teamai] Import from local dir: ${only.slug}`);
        log.success(`Pushed to team knowledge repo (${team.localConfig.repo.remote})`);
      }

      log.success(`Local directory ${only.slug} import complete`);

      if (isIncomplete) await warnIncomplete({ slug: only.slug, teamRepo: settings.team_repo, wikiRoot });

      return end('');
    }

    case 'ci':
      if (isUpdated) await refreshTeamwikiIndexes(wikiRoot);

      return end('');
    case 'update':
      return end('');
    default: {
      const unhandled: never = mode;
      throw new Error(`Unhandled import mode: ${String(unhandled)}`);
    }
  }
}

/** The member's team config, when its team repo is `teamRepo`, which the shortcut said holds the teamwiki. */
async function teamOf(teamRepo: string): Promise<import('./config.js').TeamaiInit> {
  const { autoDetectInit } = await import('./config.js');
  // The batch is published to the team repo, which a config migration may update first, as the command always did.
  const team = await autoDetectInit(undefined, { dryRun: false });

  if (path.resolve(team.localConfig.repo.localPath) !== path.resolve(teamRepo)) {
    throw new Error(`The team repo of this config is ${team.localConfig.repo.localPath}, not ${teamRepo}, which the import writes. Run the import again from the checkout it started in.`);
  }

  return team;
}

/** Reads the outputs a `teamai-import-from-repo` run ended with, as `start` answers them: what each item did. */
function importedOf(end: ShortcutEnd | undefined): ImportedItem[] {
  return z.object({ imported: z.array(z.object({ source: z.string(), slug: z.string(), updated: z.boolean(), failed: z.boolean() })) })
    .safeParse(end?.outputs).data?.imported ?? [];
}

export const ImportFromRepo = { start, stage, publish, finishItem, finish, importedOf } as const;
