import path from 'node:path';

import { EPHEMERAL_CONFIG_ENV, RUN_DIR_ENV } from '../launch-context.js';
import { assertAttachedTeamRepo, createGit } from './git.js';

import type { TeamaiInit } from '../config.js';

/**
 * The teamwiki an import writes and a `codebase` command reads: `<output>/teamwiki`
 * when `--output` is given, else the team repo's `teamwiki/`. Every import source
 * and `teamai codebase` resolve it here, so `--output` means the same directory
 * everywhere and nothing writes a teamwiki into the source checkout or the clone
 * cache.
 */
export interface TeamwikiTarget {
  /** Absolute path of the `teamwiki/` directory. */
  wikiRoot: string;
  /** The team repo that holds `wikiRoot`, or undefined for `--output`. */
  team?: TeamaiInit;
}

/**
 * Resolve the teamwiki target.
 *
 * @param opts.output - The `--output` directory: the teamwiki is `<output>/teamwiki`
 * @param opts.dryRun - Load the team config without persisting a migration (#893)
 * @throws When there is no `--output` and no team repo is configured
 */
export async function resolveTeamwiki(opts: { output?: string; dryRun?: boolean } = {}): Promise<TeamwikiTarget> {
  if (opts.output) return { wikiRoot: path.resolve(opts.output, 'teamwiki') };
  const { autoDetectInit } = await import('../config.js');
  const team = await autoDetectInit(undefined, { dryRun: opts.dryRun });

  return { wikiRoot: path.join(team.localConfig.repo.localPath, 'teamwiki'), team };
}

/**
 * Refuse a write into a team clone checked out at a fixed commit, before
 * anything is written. An `--output` teamwiki is always writable.
 */
export async function assertTeamwikiWritable(target: TeamwikiTarget | undefined): Promise<void> {
  if (!target?.team) return;
  const localPath = target.team.localConfig.repo.localPath;
  await assertAttachedTeamRepo(createGit(localPath), localPath);
}

/**
 * Hold the exclusive import lock of the teamwiki while writing it, so two imports never write one teamwiki at once and
 * the usage reporter does not reset a team repo mid-import. A teamwiki outside a team repo is locked too.
 *
 * @param runDir - The `$TEAMAI_RUN_DIR` of the workflow step that writes it: that run then holds the lock until it ends
 * @returns the release function
 * @throws ImportLockHeldError when another live process or run holds the lock
 */
export async function lockTeamwiki(target: TeamwikiTarget, runDir?: string): Promise<() => Promise<void>> {
  const { acquireImportLock } = await import('./import-lock.js');

  if (!target.team) return acquireImportLock(target.wikiRoot, runDir);
  await assertTeamwikiWritable(target);

  return acquireImportLock(target.team.localConfig.repo.localPath, runDir);
}

/** The teamwiki at `wikiRoot`, with the member's team repo when that is the repo holding it. Needs no teamai init. */
export async function teamwikiAt(wikiRoot: string): Promise<TeamwikiTarget> {
  const { NotInitializedError } = await import('../config.js');
  const own = path.resolve(wikiRoot);

  try {
    const team = await resolveTeamwiki();

    return team.wikiRoot === own ? team : { wikiRoot: own };
  } catch (error) {
    if (error instanceof NotInitializedError) return { wikiRoot: own };
    throw error;
  }
}

/**
 * Runs `write`, a workflow step that writes the teamwiki at `wikiRoot`, under its import lock, which its run, named by
 * `$TEAMAI_RUN_DIR`, then holds until it ends, so a run continued with `teamai workflow resume` keeps other imports
 * out between its steps as the command that started the run did. Under that command's or that run's hold, it goes on.
 * A run with no `teamai init` cannot be resumed, so it holds the lock only while a process of it does.
 *
 * @throws ImportLockHeldError when another live process or run holds the lock
 */
export async function whileTeamwikiLocked<T>(wikiRoot: string, write: () => Promise<T>): Promise<T> {
  const resumable = process.env[EPHEMERAL_CONFIG_ENV] === undefined;
  const release = await lockTeamwiki(await teamwikiAt(wikiRoot), resumable ? process.env[RUN_DIR_ENV] : undefined);

  try {
    return await write();
  } finally {
    await release();
  }
}
