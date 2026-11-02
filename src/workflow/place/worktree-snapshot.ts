/** Snapshots of what a step changed in a worktree: every path that differs from HEAD, with its content and mode. */
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { git, type Git } from '../worktree.js';

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

/** Porcelain records from `git status -z`. A rename's first path is the one in the worktree; the next field is the old path. */
function statusEntries(text: string): { mark: string; relative: string }[] {
  const parts = text.split('\0');
  const entries: { mark: string; relative: string }[] = [];
  for (let index = 0; index < parts.length; index += 1) {
    const item = parts[index] ?? '';
    if (item.length < 4) continue;
    const mark = item.slice(0, 2);
    if (mark.includes('R') || mark.includes('C')) index += 1;
    entries.push({ mark, relative: item.slice(3) });
  }
  return entries;
}

async function hashPath(workspace: string, relative: string): Promise<string> {
  const full = path.resolve(workspace, relative);
  try {
    const stats = await fs.lstat(full);
    const bytes = stats.isSymbolicLink() ? await fs.readlink(full) : await fs.readFile(full);
    return createHash('sha256').update(bytes).digest('hex');
  } catch {
    return 'missing';
  }
}

async function stagedEntry(workspace: string, relative: string, run: Git): Promise<string> {
  const listed = await run(workspace, ['ls-files', '-s', '--', relative]);
  const entries = listed.stdout.split('\n').filter((line) => line.trim() !== '').map((line) => {
    const [mode, blob, stage] = line.split(/\s+/);
    return `${mode}:${blob}:${stage}`;
  });
  return entries.join(',') || 'none';
}

async function worktreeMode(workspace: string, relative: string): Promise<string> {
  try {
    return String((await fs.lstat(path.resolve(workspace, relative))).mode);
  } catch {
    return 'missing';
  }
}

/** `run` is the git it runs, such as `untrustedGit` in a workspace whose config a command it did not write could change. */
export async function snapshotWorktree(workspace: string, run: Git = git, depth = 0): Promise<WorktreeSnapshot> {
  // Independent reads, started together: each untrusted git first reads the hooks to turn off.
  const [status, headRead, branchRead] = await Promise.all([
    gitStatus(workspace, run),
    run(workspace, ['rev-parse', 'HEAD']),
    run(workspace, ['symbolic-ref', '--quiet', 'HEAD']),
  ]);
  const head = headRead.stdout.trim();
  const branch = branchRead.stdout.trim();
  if (!status.ok) return { ok: false, files: new Map(), ...(head ? { head } : {}), branch };
  const files = new Map<string, string>();
  for (const { mark, relative } of statusEntries(status.text)) {
    if (files.has(relative)) continue;
    const staged = await stagedEntry(workspace, relative, run);
    const mode = await worktreeMode(workspace, relative);
    const gitlink = staged.split(',').some((entry) => entry.startsWith('160000:'));
    const body = gitlink && depth < 3
      ? await submoduleSnapshot(path.resolve(workspace, relative), run, depth)
      : await hashPath(workspace, relative);
    files.set(relative, `${mark}:${staged}:${mode}:${body}`);
  }
  return { ok: true, files, ...(head ? { head } : {}), branch };
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
