/**
 * The team revision a run starts from: the newest commit of the member's team checkout that the team remote reaches,
 * and, when the checkout holds more than that commit (commits not pushed, edits, new files), a patch of it. A feature
 * reads its team files at this pin, so an edit made while the run is open does not change the run.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { z } from 'zod';
import { getBusinessRoot, getKnowledgeDir, isSelfMode, type LocalConfig } from '../types.js';
import { readFileSafe, writeFileAtomic } from '../utils/fs.js';
import { withTeamRevision } from './cache.js';
import { runsDir, TeamPinSchema } from './store.js';
import type { RunState } from './types.js';
import { boundedGit, git } from './worktree.js';

export type TeamPin = z.infer<typeof TeamPinSchema>;

/** `runs/<run>/team-pin.patch`: the changes of the checkout past the pinned revision, as `git apply` takes them. */
function patchPath(config: LocalConfig, runId: string): string {
  return path.join(runsDir(config), runId, 'team-pin.patch');
}

/** The top level of the member's team repository: the business repository in self mode. */
function repositoryRoot(config: LocalConfig): string {
  return isSelfMode(config) ? getBusinessRoot(config) : config.repo.localPath;
}

/** The team files' directory, relative to the repository root, as a pathspec: `.` outside self mode. */
function teamPathspec(config: LocalConfig): string {
  return path.relative(repositoryRoot(config), getKnowledgeDir(config)).split(path.sep).join('/') || '.';
}

/** The newest commit of HEAD that a ref of the team remote holds, or HEAD when none does. */
async function pushedRevision(root: string, head: string): Promise<string> {
  const listed = await git(root, ['rev-list', '--boundary', head, '--not', '--remotes=origin']);
  const lines = listed.code === 0 ? listed.stdout.split('\n').filter(Boolean) : [];

  if (lines.length === 0) return head;

  return lines.find((line) => line.startsWith('-'))?.slice(1) ?? head;
}

/**
 * What the checkout holds past `revision` under the team files, untracked files included, read through a copy of its
 * index, so the member's own index is left as it is and the copy's stat data spares hashing unchanged files.
 */
async function changesPast(config: LocalConfig, root: string, revision: string): Promise<string | undefined> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'teamai-team-pin-'));

  try {
    const index = path.join(dir, 'index');
    const own = await git(root, ['rev-parse', '--path-format=absolute', '--git-path', 'index']);
    const copied = own.code === 0 && await fs.copyFile(own.stdout.trim(), index).then(() => true, () => false);
    const withIndex = boundedGit(undefined, { ...process.env, GIT_INDEX_FILE: index });
    const spec = teamPathspec(config);

    for (const args of [...copied ? [] : [['read-tree', 'HEAD']], ['add', '-A', '--', spec]]) {
      const ran = await withIndex(root, args);

      if (ran.code !== 0) return undefined;
    }

    const diff = await withIndex(root, ['diff', '--cached', '--binary', '--no-color', '--no-ext-diff', revision, '--', spec]);

    return diff.code === 0 && diff.stdout !== '' ? diff.stdout : undefined;
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

export const TeamPin = {
  /**
   * The pin of the member's team checkout now, with the patch to keep for it; undefined when the checkout is not a git
   * repository with a commit, so the run reads its team files as the checkout holds them.
   */
  async capture(config: LocalConfig): Promise<{ pin: TeamPin; patch?: string } | undefined> {
    const root = repositoryRoot(config);
    const head = await git(root, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']);

    if (head.code !== 0) return undefined;
    const revision = await pushedRevision(root, head.stdout.trim());
    const patch = await changesPast(config, root, revision);

    return patch === undefined ? { pin: { revision } } : { pin: { revision, patch: sha256(patch) }, patch };
  },

  /** Keeps `patch` for run `runId`, before its file names it. */
  async keepPatch(config: LocalConfig, runId: string, patch: string): Promise<void> {
    await writeFileAtomic(patchPath(config, runId), patch);
  },

  /**
   * Calls `use` with `config` at the team pin of `run`: a clone of the team repository at its revision with its patch
   * applied. Fails when the revision cannot be read here, or the patch is gone or changed, such as on a machine that took
   * the run over. A run with no pin is read as the member's checkout holds it now.
   */
  async withTree<T>(config: LocalConfig, run: Pick<RunState, 'id' | 'teamPin'>, use: (atPin: LocalConfig) => Promise<T>): Promise<T | { failed: string }> {
    const { teamPin } = run;

    if (teamPin === undefined) return use(config);
    const patch = teamPin.patch === undefined ? undefined : await readFileSafe(patchPath(config, run.id)) ?? '';

    if (patch !== undefined && sha256(patch) !== teamPin.patch) {
      return { failed: `the changes run ${run.id} started from beyond team commit ${teamPin.revision.slice(0, 7)} are not on this machine` };
    }

    return withTeamRevision(config, teamPin.revision, async (at) => {
      if (patch !== undefined) {
        const applied = await git(repositoryRoot(at), ['apply', '--binary', '--whitespace=nowarn'], { input: patch });

        if (applied.code !== 0) throw new Error(`the changes run ${run.id} started from do not apply to team commit ${teamPin.revision.slice(0, 7)}: ${applied.stderr.trim()}`);
      }

      return use(at);
    });
  },
};
