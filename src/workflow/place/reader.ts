import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { readFileSafe, writeJsonAtomic } from '../../utils/fs.js';
import type { StepRead } from '../step-state.js';
import type { WorkflowFailure } from '../types.js';
import { git, keptSentence, putBackCopy, type KeptChanges } from '../worktree.js';
import { restoreOverlay } from './overlay.js';
import { changedPaths, snapshotWorktree, type WorktreeSnapshot } from './worktree-snapshot.js';

const SnapshotSchema = z.object({
  ok: z.boolean(),
  head: z.string().optional(),
  branch: z.string(),
  files: z.array(z.tuple([z.string(), z.string()])),
});

/** A reader step in `dir`: what `dir` holds before it runs, by path and content hash, saved to `file`. */
export async function stageReader(dir: string, file: string): Promise<WorktreeSnapshot> {
  const before = await snapshotWorktree(dir);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await writeJsonAtomic(file, { ...before, files: [...before.files] });
  return before;
}

/** The snapshot `stageReader` saved in `file`, undefined when it is missing or unreadable. */
export async function readSnapshot(file: string): Promise<WorktreeSnapshot | undefined> {
  const saved = SnapshotSchema.safeParse(JSON.parse(await readFileSafe(file) ?? 'null'));
  return saved.success ? { ...saved.data, files: new Map(saved.data.files) } : undefined;
}

function unreadableSnapshot(dir: string, file: string): string {
  return `The snapshot of ${dir} taken before the step is missing or unreadable (${file}), so its changes cannot be checked.`;
}

/**
 * Why a reader step that ran in `dir` fails: it changed what `stageReader` saved in `file`. A command is checked only
 * when it succeeded, so a failing command keeps its own failure; a prompt is checked whatever its tool reported. An
 * interactive prompt that does not set `workspace: read-only` may write, so it is never checked.
 */
export async function finishReader(input: {
  dir: string;
  file: string;
  executor: 'command' | 'prompt';
  outcome: 'success' | 'failed';
  interactive?: true;
  readOnly?: true;
}): Promise<WorkflowFailure | undefined> {
  if (input.interactive && !input.readOnly) return undefined;
  if (input.executor === 'command' && input.outcome !== 'success') return undefined;
  const saved = await readSnapshot(input.file);
  if (!saved) return { code: 'read_only_dirty', message: unreadableSnapshot(input.dir, input.file) };
  const paths = changedPaths(saved, await snapshotWorktree(input.dir));
  if (paths.length === 0) return undefined;
  return { code: 'read_only_dirty', message: `Read-only ${input.executor} step changed repository paths: ${paths.join(', ')}` };
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
 * changed is kept on a ref first. `found` lists what the copy held untracked when it was marked.
 */
export async function leaveReadCopy(input: {
  dir: string;
  file: string;
  workspace: { branch: string; base: { commit: string }; configCommit: string };
  found: string[];
  saved: string;
  attempt: string;
  step: string;
}): Promise<ReadCopy | WorkflowFailure> {
  const { dir, file, workspace, found, saved, attempt, step } = input;
  const before = await readSnapshot(file);
  if (!before?.head) return { code: 'workspace_base', message: unreadableSnapshot(dir, file) };
  const changed = changedPaths(before, await snapshotWorktree(dir));
  // A detach or a switch to another branch at the same commit changes no file, but a later step would commit off the branch.
  // The full ref: --short prints heads/<branch> when a tag has the same name.
  const onBranch = (await git(dir, ['symbolic-ref', '--quiet', 'HEAD'])).stdout.trim() === `refs/heads/${workspace.branch}`;
  if (!onBranch && !changed.includes('HEAD')) changed.push('HEAD');
  const unrestored = await restoreOverlay({ dir, configCommit: workspace.configCommit, saved });
  const read = { branch: workspace.branch, base: workspace.base.commit, commit: before.head };
  // The copy keeps its mark, so later steps there are refused until it is back.
  if (unrestored) return { read, state: 'unrestored', changed, reason: unrestored, dir };
  const put = await putBackCopy({ dir, branch: read.branch, commit: read.commit, found, changed, attempt, step });
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
