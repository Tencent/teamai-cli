/**
 * Git worktrees for workflow steps. They live under `<main>/.teamai/workflow-worktrees`,
 * which the post-checkout hook already skips, and `core.hooksPath` points at an empty directory
 * so a hook committed on a branch does not run.
 */
import { createHash } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const AGENT_PATHS = ['AGENTS.md', 'CLAUDE.md', '.claude', '.codex', '.opencode', '.cursor', '.agents', '.githooks'];

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

export function git(cwd: string, args: string[], input?: string): Promise<GitResult> {
  if (input === undefined) {
    return new Promise((resolve) => {
      execFile('git', args, { cwd, env: process.env, windowsHide: true }, (error, stdout, stderr) => {
        const failed = error as NodeJS.ErrnoException & { status?: number } | null;
        const code = typeof failed?.status === 'number' ? failed.status : failed ? 1 : 0;
        resolve({ code, stdout: String(stdout), stderr: String(stderr) });
      });
    });
  }
  return new Promise((resolve) => {
    const child = spawn('git', args, { cwd, env: process.env, windowsHide: true });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (code: number): void => {
      if (settled) return;
      settled = true;
      resolve({ code, stdout, stderr });
    };
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    child.on('error', () => finish(1));
    child.on('close', (code) => finish(code ?? 1));
    child.stdin.end(input);
  });
}

export function worktreePath(main: string, branch: string): string {
  const safe = branch.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'step';
  const hash = createHash('sha256').update(branch).digest('hex').slice(0, 12);
  return path.join(main, '.teamai', 'workflow-worktrees', `${safe}-${hash}`);
}

/** A path git keeps for this checkout. A linked worktree's `.git` is a file, so the path is not `<checkout>/.git`. */
async function gitPath(cwd: string, name: string): Promise<string | undefined> {
  const result = await git(cwd, ['rev-parse', '--git-path', name]);
  const printed = result.code === 0 ? result.stdout.trim() : '';
  return printed === '' ? undefined : path.resolve(cwd, printed);
}

/** Keeps TeamAI worktrees out of `git status` in the active checkout. */
async function hideTeamaiWorktrees(main: string): Promise<void> {
  const exclude = await gitPath(main, 'info/exclude');
  if (!exclude) return;
  const marker = '# teamai workflow worktrees';
  const current = await fs.readFile(exclude, 'utf8').catch(() => '');
  if (current.includes(marker)) return;
  await fs.mkdir(path.dirname(exclude), { recursive: true });
  await fs.appendFile(exclude, `${current.endsWith('\n') || current === '' ? '' : '\n'}${marker}\n.teamai/workflow-worktrees/\n.teamai/workflow-hooks/\n`);
}

export function hooksPath(main: string): string {
  return path.join(main, '.teamai', 'workflow-hooks');
}

export async function headCommit(cwd: string): Promise<{ ref: string; commit: string } | undefined> {
  const result = await git(cwd, ['rev-parse', 'HEAD']);
  if (result.code !== 0) return undefined;
  const commit = result.stdout.trim();
  return commit ? { ref: 'HEAD', commit } : undefined;
}

/** Creates the worktree when it is missing. A branch that already exists is checked out as it is. */
export async function ensureWorktree(main: string, branch: string, start: string): Promise<{ dir: string } | { error: string }> {
  const dir = worktreePath(main, branch);
  const hooks = hooksPath(main);
  await fs.mkdir(hooks, { recursive: true });
  await hideTeamaiWorktrees(main);
  const listed = await git(main, ['worktree', 'list', '--porcelain']);
  const known = listed.code === 0 && listed.stdout.split('\n').some((line) => line.startsWith('worktree ') && path.resolve(line.slice('worktree '.length)) === path.resolve(dir));
  const existing = known || await git(dir, ['rev-parse', '--is-inside-work-tree']).then((result) => result.stdout.trim() === 'true').catch(() => false);
  if (existing) {
    await worktreeHooks(main, dir, hooks);
    return { dir };
  }
  await fs.mkdir(path.dirname(dir), { recursive: true });
  const config = ['-c', `core.hooksPath=${hooks}`];
  const exists = await git(main, ['rev-parse', '--verify', '--quiet', branch]);
  const created = exists.code === 0
    ? await git(main, [...config, 'worktree', 'add', dir, branch])
    : await git(main, [...config, 'worktree', 'add', '-b', branch, dir, start]);
  if (created.code !== 0) return { error: created.stderr.trim() || created.stdout.trim() || 'git worktree add failed' };
  await worktreeHooks(main, dir, hooks);
  return { dir };
}

/** Points this worktree's hooks at `hooks` without changing the active checkout's hooks. */
async function worktreeHooks(main: string, dir: string, hooks: string): Promise<void> {
  await git(main, ['config', 'extensions.worktreeConfig', 'true']);
  await git(dir, ['config', '--worktree', 'core.hooksPath', hooks]);
}

/** Merges `commit` unless it is already contained. A conflict leaves the worktree as git stopped. */
export async function mergeBranch(dir: string, commit: string): Promise<{ conflict: boolean; files: string[] }> {
  const contained = await git(dir, ['merge-base', '--is-ancestor', commit, 'HEAD']);
  if (contained.code === 0) return { conflict: false, files: [] };
  const merged = await git(dir, [
    '-c', 'user.name=TeamAI', '-c', 'user.email=teamai@localhost',
    'merge', '--no-ff', '--no-edit', commit,
  ]);
  if (merged.code === 0) return { conflict: false, files: [] };
  const files = await git(dir, ['diff', '--name-only', '--diff-filter=U']);
  return { conflict: true, files: files.stdout.split('\n').map((file) => file.trim()).filter((file) => file !== '') };
}

/**
 * Replaces agent configuration with the copy at `commit` and points hooks at an empty directory.
 * `saved` is the branch's own copy, put back for paths the step does not edit.
 */
export async function applyBaseConfig(
  dir: string, commit: string, hooks: string,
): Promise<{ ok: true; saved: string } | { ok: false; message: string }> {
  await git(dir, ['config', '--worktree', 'core.hooksPath', hooks]);
  const saved = await fs.mkdtemp(path.join(os.tmpdir(), 'teamai-agent-'));
  const conflicts = (await git(dir, ['ls-files', '-u', '--', ...AGENT_PATHS])).stdout;
  await fs.writeFile(path.join(saved, '_conflicts'), conflicts);
  for (const relative of AGENT_PATHS) {
    try {
      await copyEntry(path.join(dir, relative), path.join(saved, relative));
    } catch {
      // The branch does not have this path.
    }
  }
  for (const relative of AGENT_PATHS) await fs.rm(path.join(dir, relative), { recursive: true, force: true });
  const listed = await git(dir, ['ls-tree', '--name-only', commit, ...AGENT_PATHS]);
  if (listed.code !== 0) return { ok: false, message: listed.stderr.trim() || 'the base commit could not be read' };
  const present = listed.stdout.split('\n').map((file) => file.trim()).filter((file) => file !== '');
  if (present.length > 0) {
    const restored = await git(dir, ['checkout', commit, '--', ...present]);
    if (restored.code !== 0) return { ok: false, message: restored.stderr.trim() || 'agent configuration could not be restored' };
  }
  const diff = await git(dir, ['diff', '--name-only', commit, '--', ...AGENT_PATHS]);
  const extra = diff.stdout.split('\n').map((file) => file.trim()).filter((file) => file !== '');
  if (extra.length > 0) return { ok: false, message: `agent configuration does not match the base commit: ${extra.join(', ')}` };
  // The base checkout cleared unmerged agent files. Put the conflict back so the step can see it,
  // and keep the stages in `_conflicts` so an untouched file is not committed as resolved.
  for (const relative of conflictPaths(conflicts)) {
    await fs.rm(path.join(dir, relative), { recursive: true, force: true });
    try {
      await copyEntry(path.join(saved, relative), path.join(dir, relative));
    } catch {
      // One side of the conflict deleted the file.
    }
  }
  return { ok: true, saved };
}

/** Puts saved conflict stages back after the base checkout cleared them, before the step runs. */
export async function reopenConfigConflicts(dir: string, saved: string): Promise<void> {
  const conflicts = await fs.readFile(path.join(saved, '_conflicts'), 'utf8').catch(() => '');
  const paths = conflictPaths(conflicts);
  if (paths.length > 0) await restoreConflictStages(dir, conflicts, paths);
}

/** Records the agent files present after team delivery, so that delivery is not a step edit. */
export async function recordConfigOverlay(dir: string, saved: string): Promise<void> {
  await fs.writeFile(path.join(saved, '_overlay.json'), JSON.stringify(await fileManifest(dir)));
  await fs.writeFile(path.join(saved, '_dirs.json'), JSON.stringify(await agentDirs(dir)));
}

/** Puts back each branch agent file that the step left unchanged. A file the step edited stays. */
export async function restoreUneditedConfig(dir: string, _commit: string, saved: string): Promise<void> {
  const overlay = JSON.parse(await fs.readFile(path.join(saved, '_overlay.json'), 'utf8')) as Record<string, string>;
  const current = await fileManifest(dir);
  const branch = await fileManifest(saved);
  const conflicts = await fs.readFile(path.join(saved, '_conflicts'), 'utf8').catch(() => '');
  const dirs = JSON.parse(await fs.readFile(path.join(saved, '_dirs.json'), 'utf8').catch(() => '[]')) as string[];
  const marked = await markedConflicts(dir, conflictPaths(conflicts));
  // Staging a conflict without leaving markers is a resolution, even when the text matches the overlay.
  // An unstaged file that still matches the overlay is not.
  const unmerged = new Set((await git(dir, ['diff', '--name-only', '--diff-filter=U'])).stdout
    .split('\n').map((file) => file.trim()).filter((file) => file !== ''));
  const unresolved = [...new Set([
    ...conflictPaths(conflicts).filter((relative) => current[relative] === overlay[relative] && unmerged.has(relative)),
    ...marked,
  ])];
  const files = new Set([...Object.keys(overlay), ...Object.keys(current), ...Object.keys(branch)]);
  for (const relative of files) {
    if (unresolved.includes(relative)) continue;
    if (relative === '_overlay.json' || current[relative] !== overlay[relative]) continue;
    // The step replaced a parent, for example a directory with a symlink. Do not restore through that edit.
    if (ancestorEdited(current, overlay, relative)) continue;
    if (await parentRemoved(dir, dirs, relative)) continue;
    // The step wrote under a directory the branch stores as a symlink. Keep that edit.
    if (descendantEdited(current, overlay, relative)) continue;
    // A branch symlink replaces the directory the base checkout put back. Leave its children alone.
    if (underBranchSymlink(branch, relative)) continue;
    const target = path.join(dir, relative);
    try {
      await fs.rm(target, { recursive: true, force: true });
      await removeBlockingSymlink(dir, relative);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await copyEntry(path.join(saved, relative), target);
    } catch {
      // The branch had no file at this path, and the step did not add one.
    }
  }
  await fs.rm(saved, { recursive: true, force: true });
  // `checkout` of the base copies staged those paths. Put the index back with the files, or a step that
  // edits nothing still looks dirty and the empty commit fails it.
  await git(dir, ['add', '-A', '--', ...AGENT_PATHS]);
  if (unresolved.length > 0) await restoreConflictStages(dir, conflicts, unresolved);
}

function conflictPaths(conflicts: string): string[] {
  const paths = new Set<string>();
  for (const line of conflicts.split('\n')) {
    const tab = line.lastIndexOf('\t');
    if (tab >= 0 && line.slice(tab + 1) !== '') paths.add(line.slice(tab + 1));
  }
  return [...paths];
}

/** Puts unmerged stages back so `git add` does not publish conflict markers as a resolution. */
async function restoreConflictStages(dir: string, conflicts: string, paths: string[]): Promise<void> {
  const wanted = new Set(paths);
  const lines = conflicts.split('\n').filter((line) => {
    const tab = line.lastIndexOf('\t');
    return tab >= 0 && wanted.has(line.slice(tab + 1));
  });
  // `git rm --cached` leaves stage 0 in place beside the restored stages, and then `git add` cannot clear them.
  const removal = paths.map((relative) => `0 ${'0'.repeat(40)}\t${relative}`);
  const payload = [...removal, ...lines];
  if (payload.length > 0) await git(dir, ['update-index', '--index-info'], `${payload.join('\n')}\n`);
}

async function fileManifest(root: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  const walk = async (relative: string): Promise<void> => {
    const current = path.join(root, relative);
    let stats;
    try {
      stats = await fs.lstat(current);
    } catch {
      return;
    }
    // A directory symlink is the link, not the files it points at. Following it would delete those files on restore.
    if (stats.isSymbolicLink()) {
      files[relative] = `link:${await fs.readlink(current)}`;
      return;
    }
    if (stats.isDirectory()) {
      const entries = await fs.readdir(current);
      for (const name of entries.sort((a, b) => a.localeCompare(b))) await walk(path.join(relative, name));
      return;
    }
    if (stats.isFile()) files[relative] = `file:${(stats.mode & 0o777).toString(8)}:${(await fs.readFile(current)).toString('base64')}`;
  };
  for (const relative of AGENT_PATHS) await walk(relative);
  return files;
}

export async function commitWork(
  dir: string, message: string, fromCommit?: string,
): Promise<{ from: string; to: string; commits: string[] } | { error: string }> {
  const before = fromCommit === undefined ? await git(dir, ['rev-parse', 'HEAD']) : { code: 0, stdout: fromCommit, stderr: '' };
  if (before.code !== 0) return { error: before.stderr.trim() || 'HEAD could not be read' };
  const from = before.stdout.trim();
  const status = await git(dir, ['status', '--porcelain']);
  const merging = (await git(dir, ['rev-parse', '--verify', '--quiet', 'MERGE_HEAD'])).code === 0;
  if (status.stdout.trim() !== '' || merging) {
    if (status.stdout.trim() !== '') {
      const added = await git(dir, ['add', '-A']);
      if (added.code !== 0) return { error: added.stderr.trim() || 'git add failed' };
    }
    const staged = await git(dir, ['diff', '--cached', '--quiet']);
    if (staged.code !== 0 || merging) {
      const committed = await git(dir, ['-c', 'user.name=TeamAI', '-c', 'user.email=teamai@localhost', 'commit', '-m', message]);
      if (committed.code !== 0) return { error: committed.stderr.trim() || committed.stdout.trim() || 'git commit failed' };
    }
  }
  const after = await git(dir, ['rev-parse', 'HEAD']);
  const to = after.stdout.trim();
  const listed = to === from ? { stdout: '' } : await git(dir, ['rev-list', '--reverse', `${from}..${to}`]);
  return { from, to, commits: listed.stdout.split('\n').map((commit) => commit.trim()).filter((commit) => commit !== '') };
}

/**
 * Pushes when `origin` exists and the branch is ahead of the copy `origin` has.
 * A retry that adds no commit still pushes when an earlier attempt left commits unpublished,
 * including a first push that never created the remote branch.
 * No origin is not a failure.
 */
export async function pushIfOrigin(dir: string, branch: string, commits: string[]): Promise<'pushed' | 'no-origin' | 'unchanged' | { error: string }> {
  const origin = await git(dir, ['remote', 'get-url', 'origin']);
  if (origin.code !== 0) return commits.length === 0 ? 'unchanged' : 'no-origin';
  if (commits.length === 0 && !await branchNeedsPush(dir, branch)) return 'unchanged';
  const pushed = await git(dir, ['push', '-u', 'origin', `${branch}:${branch}`]);
  return pushed.code === 0 ? 'pushed' : { error: (pushed.stderr || pushed.stdout).trim() || 'git push failed' };
}

/**
 * Whether this branch's tip is missing from `origin`.
 * A remote-tracking ref that does not contain the tip needs another push.
 * With no tracking refs at all, push when the tip is not already on another local branch:
 * a first push that never landed leaves commits only on this branch.
 */
async function branchNeedsPush(dir: string, branch: string): Promise<boolean> {
  const local = await git(dir, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]);
  if (local.code !== 0) return false;
  const tip = local.stdout.trim();
  const remote = `refs/remotes/origin/${branch}`;
  const known = await git(dir, ['rev-parse', '--verify', '--quiet', remote]);
  if (known.code === 0) {
    const contained = await git(dir, ['merge-base', '--is-ancestor', tip, remote]);
    return contained.code !== 0;
  }
  const listed = await git(dir, ['for-each-ref', '--format=%(refname)', 'refs/remotes/origin']);
  if (listed.stdout.trim() === '') return tipIsOnlyOn(dir, branch, tip);
  const published = await git(dir, ['branch', '-r', '--contains', tip]);
  return published.code === 0 && published.stdout.trim() === '';
}

/** True when no other local branch already contains this tip. */
async function tipIsOnlyOn(dir: string, branch: string, tip: string): Promise<boolean> {
  const holders = await git(dir, ['branch', '--contains', tip]);
  if (holders.code !== 0) return true;
  const names = holders.stdout.split('\n').map((line) => line.trim().replace(/^[*+] /, '')).filter((name) => name !== '');
  return names.every((name) => name === branch);
}

function descendantEdited(current: Record<string, string>, overlay: Record<string, string>, relative: string): boolean {
  const prefix = `${relative}${path.sep}`;
  for (const key of new Set([...Object.keys(current), ...Object.keys(overlay)])) {
    if (key.startsWith(prefix) && current[key] !== overlay[key]) return true;
  }
  return false;
}

/** Copies a file, directory, or symlink without rewriting the link or dropping its mode. */
async function copyEntry(from: string, to: string): Promise<void> {
  const stats = await fs.lstat(from);
  if (stats.isSymbolicLink()) {
    await fs.symlink(await fs.readlink(from), to);
    return;
  }
  if (stats.isDirectory()) {
    await fs.mkdir(to, { recursive: true });
    for (const name of await fs.readdir(from)) await copyEntry(path.join(from, name), path.join(to, name));
    await fs.chmod(to, stats.mode);
    return;
  }
  await fs.copyFile(from, to);
  await fs.chmod(to, stats.mode);
}

async function parentRemoved(dir: string, dirs: string[], relative: string): Promise<boolean> {
  const parts = relative.split(path.sep);
  let parent = '';
  for (const part of parts.slice(0, -1)) {
    parent = parent === '' ? part : path.join(parent, part);
    if (!dirs.includes(parent)) continue;
    try {
      if ((await fs.lstat(path.join(dir, parent))).isSymbolicLink()) continue;
    } catch {
      return true;
    }
  }
  return false;
}

async function markedConflicts(dir: string, paths: string[]): Promise<string[]> {
  const marked: string[] = [];
  for (const relative of paths) {
    try {
      if ((await fs.readFile(path.join(dir, relative), 'utf8')).includes('<<<<<<<')) marked.push(relative);
    } catch {
      // The step removed the conflicted file.
    }
  }
  return marked;
}

async function agentDirs(root: string): Promise<string[]> {
  const dirs: string[] = [];
  const walk = async (relative: string): Promise<void> => {
    let stats;
    try {
      stats = await fs.lstat(path.join(root, relative));
    } catch {
      return;
    }
    if (!stats.isDirectory()) return;
    dirs.push(relative);
    for (const name of await fs.readdir(path.join(root, relative))) await walk(path.join(relative, name));
  };
  for (const relative of AGENT_PATHS) await walk(relative);
  return dirs;
}

function ancestorEdited(current: Record<string, string>, overlay: Record<string, string>, relative: string): boolean {
  const parts = relative.split(path.sep);
  let parent = '';
  for (const part of parts.slice(0, -1)) {
    parent = parent === '' ? part : path.join(parent, part);
    if (current[parent] !== overlay[parent]) return true;
  }
  return false;
}

function underBranchSymlink(branch: Record<string, string>, relative: string): boolean {
  const parts = relative.split(path.sep);
  let parent = '';
  for (const part of parts.slice(0, -1)) {
    parent = parent === '' ? part : path.join(parent, part);
    if (branch[parent]?.startsWith('link:')) return true;
  }
  return false;
}

/** Removes a symlink that sits where a restored file needs a real directory, without following it. */
async function removeBlockingSymlink(dir: string, relative: string): Promise<void> {
  const parts = relative.split(path.sep);
  let parent = '';
  for (const part of parts.slice(0, -1)) {
    parent = parent === '' ? part : path.join(parent, part);
    const at = path.join(dir, parent);
    try {
      if ((await fs.lstat(at)).isSymbolicLink()) await fs.rm(at, { force: true });
    } catch {
      // The parent is absent.
    }
  }
}

export async function removeWorktree(main: string, dir: string): Promise<void> {
  await git(main, ['worktree', 'remove', '--force', dir]);
  await git(main, ['worktree', 'prune']);
}
