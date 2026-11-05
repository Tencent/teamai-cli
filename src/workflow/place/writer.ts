import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { WorkflowFailure } from '../types.js';
import type { StepChanges } from '../workspace.js';
import { commitPathsOf, mergeStagedPathsOf } from './worktree-snapshot.js';
import { commitWork, git, mergeBranch, offBranch, pushIfOrigin, worktreeContentKey } from '../worktree.js';
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
    const parsed = z.record(z.string(), z.unknown()).safeParse(JSON.parse(await fs.readFile(file, 'utf8')));

    if (parsed.success) {
      saved = new Map(Object.entries(parsed.data).flatMap<[string, string]>(([relative, note]) => {
        const text = z.string().safeParse(note);

        return text.success ? [[relative, text.data]] : [];
      }));
    }
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
  /**
   * Paths the skill child reported changing, when this place was adopted and the skill driver supplied the list.
   * Absent: commit the tree, as a place TeamAI made does.
   */
  reported?: readonly string[];
  /**
   * A failure the step already has. Kept when the tree has paths outside `reported` and this failure stopped the step
   * before it ran. A failure from a step that ran is replaced, so the report names the unreported paths.
   */
  already?: WorkflowFailure;
}): Promise<{ changes?: StepChanges; failure?: WorkflowFailure; unpushed?: string }> {
  const { dir, step, workspace, rangeFrom, conflicts, saved, failed, reported, already } = input;
  const unrestored = await restoreOverlay({ dir, configCommit: workspace.configCommit, saved });

  if (unrestored) return { failure: { code: 'workspace_base', message: `Step "${step}" ran, but nothing was committed or pushed. ${unrestoredConfig(unrestored, dir)}` } };
  // A commit on whatever HEAD the step left would be reported and pushed as the leased branch, which would lack it.
  const on = await offBranch(dir, workspace.branch);

  if (on) return { failure: { code: 'workspace_base', message: `Step "${step}" left workspace ${dir} ${on}, not on branch ${workspace.branch}, so nothing was committed or pushed. Check out ${workspace.branch} in ${dir} with the changes to keep, then retry the step.` } };
  const open = await unresolvedConflicts(dir, conflicts);

  if (open.length > 0) return { failure: { code: 'merge_conflict', message: `Unresolved merge conflict: ${open.join(', ')}` } };

  let paths: readonly string[] | undefined;

  if (reported) {
    const listed = await commitPathsOf(dir);

    if ('error' in listed) return { failure: { code: 'workspace_base', message: `Step "${step}" could not list changes in ${dir}, so nothing was committed or pushed. Git said: ${listed.error}.` } };
    const prepared = await unchangedMergePreparation(dir, listed.paths);

    if ('error' in prepared) return { failure: { code: 'workspace_base', message: `Step "${step}" could not read the merge recorded for ${dir}, so nothing was committed or pushed. ${prepared.error}` } };
    const missing = listed.paths.filter((relative) => !reported.includes(relative) && !prepared.paths.has(relative)).sort((left, right) => left.localeCompare(right));

    if (missing.length > 0) {
      const kept = already !== undefined && stoppedBeforeTheStep(already.code) ? already : undefined;

      return { failure: kept ?? { code: 'unreported_changes', message: unreportedChangesMessage(step, dir, missing, 'which the step did not report changing, so nothing was committed or pushed.') } };
    }

    paths = listed.paths;
  }

  const committed = await commitWork(dir, `teamai: ${step}`, rangeFrom, git, paths);

  if ('error' in committed) return { failure: { code: 'push_failed', message: committed.error } };
  await clearRememberedConflicts(dir);
  const pushed = await pushIfOrigin(dir, workspace.branch, committed.commits);
  const changes = { branch: workspace.branch, base: workspace.base.commit, from: committed.from, to: committed.to, commits: committed.commits };

  if (!(pushed instanceof Object)) return { changes };
  const unpushed = `Step "${step}" committed on ${workspace.branch} in ${dir}, but pushing it to origin failed. The commits stay on ${workspace.branch}. Fix what blocked the push, then push ${workspace.branch} from ${dir} or retry the step. Git said: ${pushed.error}`;

  return failed ? { changes, unpushed } : { changes, failure: { code: 'push_failed', message: unpushed } };
}

/** Where an adopted place records the merge prepare staged, so finish can tell it from a host file. */
async function mergePreparedPath(dir: string): Promise<string> {
  const printed = (await git(dir, ['rev-parse', '--git-path', 'teamai-merge.json'])).stdout.trim();

  return path.resolve(dir, printed);
}

/**
 * Records the paths prepare's merge left staged, with a worktree that still matches the index. A path that still has
 * this content at finish is the merge. An unstaged edit of a tracked file is not recorded.
 */
export async function recordMergePreparation(dir: string): Promise<string | undefined> {
  const listed = await mergeStagedPathsOf(dir);

  if ('error' in listed) return listed.error;
  const record: Record<string, string> = {};

  for (const relative of listed.paths) record[relative] = await worktreeContentKey(dir, relative);
  await fs.writeFile(await mergePreparedPath(dir), JSON.stringify(record));

  return undefined;
}

/** Paths among `dirty` that still match the merge `recordMergePreparation` stored. A missing record matches nothing. */
async function unchangedMergePreparation(dir: string, dirty: readonly string[]): Promise<{ paths: ReadonlySet<string> } | { error: string }> {
  const file = await mergePreparedPath(dir);
  const text = await fs.readFile(file, 'utf8').catch(() => undefined);

  if (text === undefined) return { paths: new Set() };

  let raw: unknown;

  try {
    raw = JSON.parse(text);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);

    return { error: `${file} could not be read (${reason})` };
  }

  const parsed = z.record(z.string(), z.string()).safeParse(raw);

  if (!parsed.success) return { error: `${file} is not a record of the merge` };
  const paths = new Set<string>();

  for (const relative of dirty) {
    if (parsed.data[relative] !== undefined && await worktreeContentKey(dir, relative) === parsed.data[relative]) paths.add(relative);
  }

  return { paths };
}

/** Failures that stop a step before it runs. A later failure, such as a child's `blocked`, does not hide an unreported path. */
function stoppedBeforeTheStep(code: string): boolean {
  return code === 'model_unavailable'
    || code === 'missing_env'
    || code === 'setup_failed'
    || code === 'setup_dirty'
    || code === 'setup_secret'
    || code === 'unreported_changes';
}

const HOST_SETUP_ADVICE = 'If your host\'s setup wrote it, make setup write only files git ignores, or wait for it to finish before adopt. Otherwise remove it, then retry the step.';

/** The failure an adopted place shows when `paths` were not part of the step's reported work. `because` is the clause after the path list. */
export function unreportedChangesMessage(step: string, dir: string, paths: readonly string[], because: string): string {
  return `Step "${step}" left ${paths.join(', ')} in ${dir}, ${because} ${HOST_SETUP_ADVICE}`;
}

/** `message` with the sentence a failed step's message adds when its commits could not be pushed. */
export function withUnpushed(message: string, unpushed: string | undefined): string {
  return unpushed ? `${message.replace(/\.?$/, '.')} ${unpushed}` : message;
}
