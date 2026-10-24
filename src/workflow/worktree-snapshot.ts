/** Snapshots of what a step changed in a worktree: every path that differs from HEAD, with its content and mode. */
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { git } from './worktree.js';

/** Every tracked or non-ignored path that differs from HEAD, with its content and mode, and where HEAD is. */
export interface WorktreeSnapshot {
  ok: boolean;
  files: Map<string, string>;
  head?: string;
  /** The ref HEAD points to, empty when it is detached, so a switch at the same commit is a change too. */
  branch: string;
}

function gitStatus(workspace: string): Promise<{ ok: boolean; text: string }> {
  return new Promise((resolve) => {
    execFile('git', ['status', '--porcelain', '-z', '--untracked-files=all', '--ignore-submodules=none'], { cwd: workspace, env: process.env }, (error, stdout, stderr) => {
      resolve(error ? { ok: false, text: stderr.trim() } : { ok: true, text: stdout });
    });
  });
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

async function stagedEntry(workspace: string, relative: string): Promise<string> {
  const listed = await git(workspace, ['ls-files', '-s', '--', relative]);
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

export async function snapshotWorktree(workspace: string, depth = 0): Promise<WorktreeSnapshot> {
  const status = await gitStatus(workspace);
  const head = (await git(workspace, ['rev-parse', 'HEAD'])).stdout.trim();
  const branch = (await git(workspace, ['symbolic-ref', '--quiet', 'HEAD'])).stdout.trim();
  if (!status.ok) return { ok: false, files: new Map(), ...(head ? { head } : {}), branch };
  const files = new Map<string, string>();
  for (const { mark, relative } of statusEntries(status.text)) {
    if (files.has(relative)) continue;
    const staged = await stagedEntry(workspace, relative);
    const mode = await worktreeMode(workspace, relative);
    const gitlink = staged.split(',').some((entry) => entry.startsWith('160000:'));
    const body = gitlink && depth < 3
      ? await submoduleSnapshot(path.resolve(workspace, relative), depth)
      : await hashPath(workspace, relative);
    files.set(relative, `${mark}:${staged}:${mode}:${body}`);
  }
  return { ok: true, files, ...(head ? { head } : {}), branch };
}

async function submoduleSnapshot(dir: string, depth: number): Promise<string> {
  const snap = await snapshotWorktree(dir, depth + 1);
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
