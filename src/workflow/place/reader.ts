import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { writeJsonAtomic } from '../../utils/fs.js';
import type { StepRead } from '../step-state.js';
import type { WorkflowFailure } from '../types.js';
import { gitAnswer, keptSentence, putBackCopy, type Git, type KeptChanges } from '../worktree.js';
import { restoreOverlay } from './overlay.js';
import { changedPaths, snapshotWorktree, type WorktreeSnapshot } from './worktree-snapshot.js';
import { Writes } from '../writes.js';
import { readRegularFile } from '@teamai/shared/regular-file';

const SnapshotSchema = z.object({
  ok: z.boolean(),
  head: z.string().optional(),
  branch: z.string(),
  files: z.array(z.tuple([z.string(), z.string()])),
});

/** A reader step in `dir`: what `dir` holds before it runs, by path and content hash, saved to `file`. `run` is the git it runs there. */
export async function stageReader(dir: string, file: string, run: Git): Promise<WorktreeSnapshot> {
  const before = await snapshotWorktree(dir, run);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await writeJsonAtomic(file, { ...before, files: [...before.files] });

  return before;
}

/** The snapshot `stageReader` saved in `file`, undefined when it is missing or unreadable. */
export async function readSnapshot(file: string): Promise<WorktreeSnapshot | undefined> {
  const saved = SnapshotSchema.safeParse(JSON.parse(await readRegularFile(file, 'utf8').catch(() => null) ?? 'null'));

  return saved.success ? { ...saved.data, files: new Map(saved.data.files) } : undefined;
}

function unreadableSnapshot(dir: string, file: string): string {
  return `The snapshot of ${dir} taken before the step is missing or unreadable (${file}), so its changes cannot be checked.`;
}

/**
 * Why a reader step that ran in `dir` fails: it changed what `stageReader` saved in `file`. A command is checked only
 * when it succeeded, so a failing command keeps its own failure; a prompt is checked whatever its tool reported. An
 * interactive prompt that does not set `workspace: read-only` may write, so it is never checked. A change under one of
 * `writes`, the paths a command writes, is kept, and one outside `dir` cannot dirty it. So is a commit the step added on
 * the branch it found, when every path it changes is under `writes`, as when a command publishes what it wrote; any
 * other move of HEAD never is. `run` is the git it runs in `dir`, where the step ran.
 */
export async function finishReader(input: {
  dir: string;
  run: Git;
  file: string;
  executor: 'command' | 'prompt';
  outcome: 'success' | 'failed';
  interactive?: true;
  readOnly?: true;
  writes?: string[];
}): Promise<WorkflowFailure | undefined> {
  if (input.interactive && !input.readOnly) return undefined;

  if (input.executor === 'command' && input.outcome !== 'success') return undefined;
  const saved = await readSnapshot(input.file);

  if (!saved) return { code: 'read_only_dirty', message: unreadableSnapshot(input.dir, input.file) };
  const writes = Writes.inCheckout(input.writes ?? [], input.dir);
  const after = await snapshotWorktree(input.dir, input.run);
  const isKeptCommit = await isCommitUnder(writes, input.dir, saved, after, input.run);
  const paths = changedPaths(saved, after).filter((changed) => (changed === 'HEAD' ? !isKeptCommit : !Writes.keeps(writes, changed)));

  if (paths.length === 0) return undefined;

  return { code: 'read_only_dirty', message: `Read-only ${input.executor} step changed repository paths: ${paths.join(', ')}` };
}

/**
 * Whether HEAD moved only by commits added on the branch `before` found, each path they change under `writes`. A switch,
 * a detach and a reset are no such move, so a path cannot keep them.
 */
async function isCommitUnder(writes: string[], dir: string, before: WorktreeSnapshot, after: WorktreeSnapshot, git: Git): Promise<boolean> {
  if (!before.head || !after.head || before.head === after.head || before.branch === '' || before.branch !== after.branch) return false;

  // Only a yes keeps the commits: a git that did not answer leaves them a change the reader made.
  if (gitAnswer(await git(dir, ['merge-base', '--is-ancestor', before.head, after.head])).said !== 'yes') return false;
  const diff = await git(dir, ['diff', '--name-only', '--no-renames', '-z', before.head, after.head]);
  const committed = diff.stdout.split('\0').filter((changed) => changed !== '');

  return diff.code === 0 && committed.length > 0 && committed.every((changed) => Writes.keeps(writes, changed));
}

/** How a reader left its copy. `kept` holds what the step changed; an unrestored copy lacks it when keeping failed. */
export type ReadCopy = { read: StepRead } & (
  | { state: 'untouched' }
  | { state: 'restored'; changed: string[]; kept: KeptChanges }
  | { state: 'unrestored'; changed: string[]; reason: string; dir: string; kept?: KeptChanges }
);

/**
 * Leaves the read-only copy `dir` of `workspace.branch` as the step found it: the base agent files go back, and a copy
 * the step changed is reset to the commit it read, so a later step there does not commit the change. What the step
 * changed is kept on a ref first. `found` lists what the copy held untracked when it was marked. `run` is the git it runs there.
 */
export async function leaveReadCopy(input: {
  dir: string;
  run: Git;
  file: string;
  workspace: { branch: string; base: { commit: string }; configCommit: string };
  found: string[];
  saved: string;
  attempt: string;
  step: string;
}): Promise<ReadCopy | WorkflowFailure> {
  const { dir, file, workspace, found, saved, attempt, step, run } = input;
  const before = await readSnapshot(file);

  if (!before?.head) return { code: 'workspace_base', message: unreadableSnapshot(dir, file) };
  const changed = changedPaths(before, await snapshotWorktree(dir, run));
  // A detach or a switch to another branch at the same commit changes no file, but a later step would commit off the branch.
  // The full ref: --short prints heads/<branch> when a tag has the same name.
  // A git that did not answer is off the branch, so the copy is restored and the change reported.
  const head = gitAnswer(await run(dir, ['symbolic-ref', '--quiet', 'HEAD']));
  const onBranch = head.said === 'yes' && head.result.stdout.trim() === `refs/heads/${workspace.branch}`;

  if (!onBranch && !changed.includes('HEAD')) changed.push('HEAD');
  const unrestored = await restoreOverlay({ dir, configCommit: workspace.configCommit, saved, run });
  const read = { branch: workspace.branch, base: workspace.base.commit, commit: before.head };

  // The copy keeps its mark, so later steps there are refused until it is back.
  if (unrestored) return { read, state: 'unrestored', changed, reason: unrestored, dir };
  const put = await putBackCopy({ dir, branch: read.branch, commit: read.commit, found, changed, attempt, step, run });

  return put.state === 'unrestored' ? { read, changed, dir, ...put } : put.state === 'restored' ? { read, changed, ...put } : { read, ...put };
}

/**
 * A reader that changed its copy, or whose copy could not be put back, fails. `changed` is the step's own sentence naming
 * the paths, empty when it changed none.
 */
export function readCopyFailure(left: Exclude<ReadCopy, { state: 'untouched' }>, changed: string): WorkflowFailure {
  const { branch, commit } = left.read;
  const lead = changed === '' ? '' : `${changed} `;

  switch (left.state) {
    case 'restored':
      return { code: 'read_only_dirty', message: `${lead}Workspace ${branch} was put back at ${commit}. ${keptSentence(left.kept)}` };
    case 'unrestored':
      return {
        code: 'workspace_base',
        message: left.kept
          ? `${lead}Workspace ${branch} could NOT be put back at ${commit}: ${left.reason}. ${keptSentence(left.kept)} Later steps there fail until ${left.dir} is back on ${branch} at ${commit} as the step found it.`
          : left.changed.length === 0
            ? `${lead}Workspace ${branch} could NOT be put back at ${commit}: ${left.reason}. Put ${left.dir} back on ${branch} at ${commit} as the step found it. Later steps there fail until it is.`
            : `${lead}Workspace ${branch} could NOT be put back at ${commit}: ${left.reason}. Its changes were NOT saved and are still in ${left.dir}. Copy them out before you put ${left.dir} back on ${branch} at ${commit} as the step found it. Later steps there fail until it is.`,
      };
    default: {
      const unhandled: never = left;

      return unhandled;
    }
  }
}
