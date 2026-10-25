import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { WorkflowFailure } from '../types.js';
import type { StepChanges } from '../workspace.js';
import { commitWork, git, mergeBranch, offBranch, pushIfOrigin } from '../worktree.js';
import { restoreOverlay, unrestoredConfig } from './overlay.js';

/**
 * Merges each of `merge` into the copy `dir` of a writer. A conflict stops the merging: a command fails
 * `merge_conflict`, and a prompt gets `note`, which names the conflict and the branches left to merge for it to resolve.
 */
export async function mergeBranches({ dir, run, step, executor, merge }: {
  dir: string;
  run: string;
  step: string;
  executor: 'command' | 'prompt';
  merge: Array<{ branch: string; commit: string }>;
}): Promise<{ kind: 'merged'; note?: string } | { kind: 'failed'; failure: WorkflowFailure }> {
  let conflict: { branch: string; files: string[] } | undefined;
  const remaining: string[] = [];
  for (const item of merge) {
    if (conflict) {
      remaining.push(item.branch);
      continue;
    }
    const result = await mergeBranch(dir, item.commit);
    if (result.state === 'failed') {
      return { kind: 'failed', failure: { code: 'workspace_base', message: `Step "${step}" could not merge branch ${item.branch} at ${item.commit} into workspace ${dir}. Git stopped without a conflict to resolve, so the step did not run. Git said: ${result.error.replace(/\.$/, '')}. Fix what git reported in ${dir}, then retry this step with teamai workflow retry ${run} ${step}.` } };
    }
    if (result.state === 'conflict') conflict = { branch: item.branch, files: result.files };
  }
  if (!conflict) return { kind: 'merged' };
  if (executor === 'command') {
    const files = conflict.files.join(', ');
    return { kind: 'failed', failure: { code: 'merge_conflict', message: `Merge conflict with ${conflict.branch}${files ? `: ${files}` : ''}` } };
  }
  const files = conflict.files.join(', ') || 'unmerged files';
  const left = remaining.length > 0 ? ` Remaining branches: ${remaining.join(', ')}.` : '';
  return { kind: 'merged', note: `\n\nMerge conflict with ${conflict.branch} (${files}).${left} Resolve the conflict in the workspace.` };
}

async function conflictsPath(dir: string): Promise<string> {
  const printed = (await git(dir, ['rev-parse', '--git-path', 'teamai-conflicts.json'])).stdout.trim();
  return path.resolve(dir, printed);
}

function hashText(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/**
 * Keeps the paths that were conflicted when the merge started until a resolution is validated: a prompt commit can
 * clear MERGE_HEAD before that. Each, with the hash of its content as the step gets it. A file left unchanged is not a
 * resolution.
 */
export async function rememberConflicts(dir: string): Promise<Record<string, string>> {
  const current = await conflictContents(dir);
  const file = await conflictsPath(dir);
  let saved = new Map<string, string>();
  try {
    const parsed = z.record(z.unknown()).safeParse(JSON.parse(await fs.readFile(file, 'utf8')));
    if (parsed.success) saved = new Map(Object.entries(parsed.data).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
  } catch {
    saved = new Map();
  }
  const merged = new Map(saved);
  for (const [relative, text] of current) merged.set(relative, text);
  if (merged.size > 0) await fs.writeFile(file, JSON.stringify(Object.fromEntries(merged)));
  return Object.fromEntries([...merged].map(([relative, text]) => [relative, hashText(text)]));
}

async function clearRememberedConflicts(dir: string): Promise<void> {
  await fs.rm(await conflictsPath(dir), { force: true });
}

async function unmergedPaths(dir: string): Promise<string[]> {
  const unmerged = await git(dir, ['diff', '-z', '--name-only', '--diff-filter=U']);
  return unmerged.stdout.split('\0').filter((file) => file !== '');
}

async function conflictContents(dir: string): Promise<Map<string, string>> {
  const contents = new Map<string, string>();
  for (const file of await unmergedPaths(dir)) {
    try {
      contents.set(file, await fs.readFile(path.join(dir, file), 'utf8'));
    } catch {
      contents.set(file, '');
    }
  }
  return contents;
}

async function unresolvedConflicts(dir: string, before: Record<string, string>): Promise<string[]> {
  const textOf = async (file: string): Promise<string> => {
    try {
      return await fs.readFile(path.join(dir, file), 'utf8');
    } catch {
      return '';
    }
  };
  for (const file of await unmergedPaths(dir)) {
    const text = await textOf(file);
    if (text.includes('<<<<<<<') || before[file] === hashText(text)) continue;
    await git(dir, ['add', '--', file]);
  }
  const open = new Set(await unmergedPaths(dir));
  // `git add` removes a path from the unmerged list even when conflict markers are still in the file.
  for (const file of Object.keys(before)) {
    if ((await textOf(file)).includes('<<<<<<<')) open.add(file);
  }
  return [...open];
}

/**
 * Commits a writer's copy `dir` and pushes it, whether or not the step failed, so the commits it reports are on origin.
 * A failed push fails a step that succeeded with `push_failed`. A step that already `failed` keeps its own failure and
 * gets `unpushed`, the sentence its message adds.
 */
export async function finishWriter(input: {
  dir: string;
  step: string;
  workspace: { branch: string; base: { commit: string }; configCommit: string };
  rangeFrom?: string;
  conflicts: Record<string, string>;
  saved: string;
  failed: boolean;
}): Promise<{ changes?: StepChanges; failure?: WorkflowFailure; unpushed?: string }> {
  const { dir, step, workspace, rangeFrom, conflicts, saved, failed } = input;
  const unrestored = await restoreOverlay({ dir, configCommit: workspace.configCommit, saved });
  if (unrestored) return { failure: { code: 'workspace_base', message: `Step "${step}" ran, but nothing was committed or pushed. ${unrestoredConfig(unrestored, dir)}` } };
  // A commit on whatever HEAD the step left would be reported and pushed as the leased branch, which would lack it.
  const on = await offBranch(dir, workspace.branch);
  if (on) return { failure: { code: 'workspace_base', message: `Step "${step}" left workspace ${dir} ${on}, not on branch ${workspace.branch}, so nothing was committed or pushed. Check out ${workspace.branch} in ${dir} with the changes to keep, then retry the step.` } };
  const open = await unresolvedConflicts(dir, conflicts);
  if (open.length > 0) return { failure: { code: 'merge_conflict', message: `Unresolved merge conflict: ${open.join(', ')}` } };
  const committed = await commitWork(dir, `teamai: ${step}`, rangeFrom);
  if ('error' in committed) return { failure: { code: 'push_failed', message: committed.error } };
  await clearRememberedConflicts(dir);
  const pushed = await pushIfOrigin(dir, workspace.branch, committed.commits);
  const changes = { branch: workspace.branch, base: workspace.base.commit, from: committed.from, to: committed.to, commits: committed.commits };
  if (typeof pushed !== 'object') return { changes };
  const unpushed = `Step "${step}" committed on ${workspace.branch} in ${dir}, but pushing it to origin failed. The commits stay on ${workspace.branch}. Fix what blocked the push, then push ${workspace.branch} from ${dir} or retry the step. Git said: ${pushed.error}`;
  return failed ? { changes, unpushed } : { changes, failure: { code: 'push_failed', message: unpushed } };
}

/** `message` with the sentence a failed step's message adds when its commits could not be pushed. */
export function withUnpushed(message: string, unpushed: string | undefined): string {
  return unpushed ? `${message.replace(/\.?$/, '.')} ${unpushed}` : message;
}
