/** Snapshots of what a step changed in a worktree: every path that differs from HEAD, with its content and mode. */
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { git, gitAnswer, type Git } from '../worktree.js';
import { readRegularFile } from '@teamai/shared/regular-file';

/** Every tracked or non-ignored path that differs from HEAD, with its content and mode, and where HEAD is. */
export interface WorktreeSnapshot {
  ok: boolean;
  files: Map<string, string>;
  head?: string;
  /** The ref HEAD points to, empty when it is detached, so a switch at the same commit is a change too. */
  branch: string;
}

async function gitStatus(workspace: string, run: Git): Promise<{ ok: boolean; text: string }> {
  const status = await run(workspace, ['status', '--porcelain', '-z', '--untracked-files=all', '--ignore-submodules=none']);

  return status.code === 0 ? { ok: true, text: status.stdout } : { ok: false, text: status.stderr.trim() };
}

/**
 * Porcelain records from `git status -z`. A rename or copy's first path is the one in the worktree; the next field is
 * the old path, which a snapshot does not hash.
 */
function statusEntries(text: string): { mark: string; relative: string }[] {
  return porcelainRecords(text).map((record) => ({ mark: record.mark, relative: record.paths[0] ?? '' }));
}

/** Every path in one `git status -z` record. A rename or copy lists the worktree path and then the old path. */
function porcelainRecords(text: string): { mark: string; paths: string[] }[] {
  const parts = text.split('\0');
  const records: { mark: string; paths: string[] }[] = [];

  for (let index = 0; index < parts.length; index += 1) {
    const item = parts[index] ?? '';

    if (item.length < 4) continue;
    const mark = item.slice(0, 2);
    const paths = [item.slice(3)];

    if (mark.includes('R') || mark.includes('C')) {
      index += 1;
      const previous = parts[index];

      if (previous !== undefined && previous !== '') paths.push(previous);
    }

    records.push({ mark, paths });
  }

  return records;
}

/** Every path in `text`, from `git status --porcelain -z`, that git would commit, including a rename or copy's old path. */
export function pathsGitWouldCommit(text: string): string[] {
  return porcelainRecords(text).flatMap((record) => record.paths);
}

/** The paths in `dir` that git would commit, or why `git status` could not be read. */
export async function commitPathsOf(dir: string, run: Git = git): Promise<{ paths: string[] } | { error: string }> {
  const status = await run(dir, ['status', '--porcelain', '-z', '--untracked-files=all', '--ignore-submodules=none']);

  if (status.code !== 0) return { error: status.stderr.trim() || 'git status failed' };

  return { paths: pathsGitWouldCommit(status.stdout) };
}

/**
 * Paths a merge left staged whose worktree still matches the index. An unstaged edit of a tracked file, a conflict
 * the step still has to resolve, and a path that is also untracked are not part of that. A staged deletion the host
 * recreated is both `D ` and `??`, and the untracked record is the host file.
 */
export function mergeStagedPaths(text: string): string[] {
  const records = porcelainRecords(text);
  const untracked = new Set(records.filter((record) => record.mark === '??' || record.mark === '!!').flatMap((record) => record.paths));

  return records.filter((record) => {
    const index = record.mark[0] ?? ' ';
    const worktree = record.mark[1] ?? ' ';

    return index !== ' ' && index !== '?' && worktree === ' ';
  }).flatMap((record) => record.paths).filter((relative) => !untracked.has(relative));
}

/** Those paths in `dir`, or why `git status` could not be read. */
export async function mergeStagedPathsOf(dir: string, run: Git = git): Promise<{ paths: string[] } | { error: string }> {
  const status = await run(dir, ['status', '--porcelain', '-z', '--untracked-files=all', '--ignore-submodules=none']);

  if (status.code !== 0) return { error: status.stderr.trim() || 'git status failed' };

  return { paths: mergeStagedPaths(status.stdout) };
}

async function hashPath(workspace: string, relative: string): Promise<string> {
  const full = path.resolve(workspace, relative);

  try {
    const stats = await fs.lstat(full);
    const bytes = stats.isSymbolicLink() ? await fs.readlink(full) : await readRegularFile(full);

    return createHash('sha256').update(bytes).digest('hex');
  } catch {
    return 'missing';
  }
}

/**
 * The characters of paths one `git ls-files` gets on its command line, well under Windows' 32,767 for the whole line
 * with the settings `untrustedGit` puts first. `ls-files` reads no pathspec from stdin.
 */
const PATHSPEC_CHARS = 8_000;

/** `names` in lists whose characters stay within `PATHSPEC_CHARS`, each with at least one name. */
function pathspecBatches(names: readonly string[]): string[][] {
  const batches: string[][] = [];
  let current: string[] = [];
  let size = 0;

  for (const name of names) {
    if (current.length > 0 && size + name.length > PATHSPEC_CHARS) {
      batches.push(current);
      current = [];
      size = 0;
    }

    current.push(name);
    size += name.length + 1;
  }

  if (current.length > 0) batches.push(current);

  return batches;
}

/**
 * The index entries git holds at or under each of `names`, as `mode:blob:stage` joined by commas, every stage of a
 * conflicted path in git's order, or `none`: one `ls-files` per batch of names, each name a literal path.
 */
async function stagedEntries(workspace: string, names: readonly string[], run: Git): Promise<Map<string, string>> {
  const staged = new Map<string, string>();

  // One batch at a time: each untrusted git starts three processes, and a checkout with many untracked files has many batches.
  for (const batch of pathspecBatches([...new Set(names)])) {
    const listing = await run(workspace, ['--literal-pathspecs', 'ls-files', '-s', '-z', '--', ...batch]);
    const asked = new Set(batch);
    const entries = new Map<string, string[]>();

    for (const record of listing.stdout.split('\0')) {
      const tab = record.indexOf('\t');

      if (tab === -1) continue;
      const [mode, blob, stage] = record.slice(0, tab).split(' ');
      const parts = record.slice(tab + 1).split('/');

      // An entry is the name's own, or one under it when the name is a folder git still tracks files in.
      for (let depth = parts.length; depth > 0; depth -= 1) {
        const owner = parts.slice(0, depth).join('/');

        if (asked.has(owner)) entries.set(owner, [...entries.get(owner) ?? [], `${mode}:${blob}:${stage}`]);
      }
    }

    for (const name of batch) staged.set(name, entries.get(name)?.join(',') ?? 'none');
  }

  return staged;
}

async function worktreeMode(workspace: string, relative: string): Promise<string> {
  try {
    return String((await fs.lstat(path.resolve(workspace, relative))).mode);
  } catch {
    return 'missing';
  }
}

/** `run` is the git it runs, such as `untrustedGit` in a workspace whose config a command it did not write could change. */
export async function snapshotWorktree(workspace: string, run: Git, depth = 0): Promise<WorktreeSnapshot> {
  // Independent reads, started together: each untrusted git first reads the hooks to turn off.
  const [status, headRead, branchRead] = await Promise.all([
    gitStatus(workspace, run),
    run(workspace, ['rev-parse', 'HEAD']),
    run(workspace, ['symbolic-ref', '--quiet', 'HEAD']).then(gitAnswer),
  ]);

  const head = headRead.stdout.trim();
  // No branch is detached; a git that did not answer read no status either, so the snapshot is not ok.
  const branch = branchRead.said === 'yes' ? branchRead.result.stdout.trim() : '';

  const resolved: Pick<WorktreeSnapshot, 'head'> = {};

  if (head) resolved.head = head;

  if (!status.ok || branchRead.said === 'nothing') return { ok: false, files: new Map(), ...resolved, branch };
  const files = new Map<string, string>();
  const entries = statusEntries(status.text);
  const staging = await stagedEntries(workspace, entries.map((entry) => entry.relative), run);

  for (const { mark, relative } of entries) {
    if (files.has(relative)) continue;
    const staged = staging.get(relative) ?? 'none';
    const mode = await worktreeMode(workspace, relative);
    const gitlink = staged.split(',').some((entry) => entry.startsWith('160000:'));

    const body = gitlink && depth < 3
      ? await submoduleSnapshot(path.resolve(workspace, relative), run, depth)
      : await hashPath(workspace, relative);

    files.set(relative, `${mark}:${staged}:${mode}:${body}`);
  }

  return { ok: true, files, ...resolved, branch };
}

async function submoduleSnapshot(dir: string, run: Git, depth: number): Promise<string> {
  const snap = await snapshotWorktree(dir, run, depth + 1);

  const files = [...snap.files.entries()].sort(([left], [right]) => left.localeCompare(right))
    .map(([name, value]) => `${name}=${value}`).join('\n');

  return `${snap.ok ? 'ok' : 'unreadable'}:${snap.head ?? ''}:${files}`;
}

/** The paths, and `HEAD`, that differ between two snapshots of one worktree. */
export function changedPaths(before: WorktreeSnapshot, after: WorktreeSnapshot): string[] {
  const files = !after.ok
    ? []
    : !before.ok
      ? (after.files.size === 0 ? [] : [...after.files.keys()])
      : [...new Set([...before.files.keys(), ...after.files.keys()])].filter((name) => before.files.get(name) !== after.files.get(name));

  if ((before.head && after.head && before.head !== after.head) || before.branch !== after.branch) files.push('HEAD');

  return files;
}
