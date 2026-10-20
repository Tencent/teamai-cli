import path from 'node:path';

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
 * Hold the import lock while writing into the team repo, so the usage
 * reporter does not reset it mid-import. An `--output` teamwiki needs none.
 *
 * @returns the release function
 */
export async function lockTeamwiki(target: TeamwikiTarget): Promise<() => Promise<void>> {
  if (!target.team) return async () => {};
  await assertTeamwikiWritable(target);
  const { acquireImportLock } = await import('./import-lock.js');
  return acquireImportLock(target.team.localConfig.repo.localPath);
}
