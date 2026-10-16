/**
 * Git worktrees for workflow steps. They live under `<main>/.teamai/workflow-worktrees`,
 * which the post-checkout hook already skips, and `core.hooksPath` points at an empty directory
 * so a hook committed on a branch does not run.
 */
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const AGENT_PATHS = ['AGENTS.md', 'CLAUDE.md', '.claude', '.codex', '.opencode', '.cursor', '.agents', '.githooks'];

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

export function git(cwd: string, args: string[]): Promise<GitResult> {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, env: process.env, windowsHide: true }, (error, stdout, stderr) => {
      const failed = error as NodeJS.ErrnoException & { code?: number | string; status?: number } | null;
      const code = typeof failed?.status === 'number' ? failed.status : failed ? 1 : 0;
      resolve({ code, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

export function worktreePath(main: string, branch: string): string {
  const safe = branch.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'step';
  const hash = createHash('sha256').update(branch).digest('hex').slice(0, 12);
  return path.join(main, '.teamai', 'workflow-worktrees', `${safe}-${hash}`);
}

/** Keeps TeamAI worktrees out of `git status` in the active checkout. */
async function hideTeamaiWorktrees(main: string): Promise<void> {
  const exclude = path.join(main, '.git', 'info', 'exclude');
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
    await git(dir, ['config', 'core.hooksPath', hooks]);
    return { dir };
  }
  await fs.mkdir(path.dirname(dir), { recursive: true });
  const config = ['-c', `core.hooksPath=${hooks}`];
  const exists = await git(main, ['rev-parse', '--verify', '--quiet', branch]);
  const created = exists.code === 0
    ? await git(main, [...config, 'worktree', 'add', dir, branch])
    : await git(main, [...config, 'worktree', 'add', '-b', branch, dir, start]);
  if (created.code !== 0) return { error: created.stderr.trim() || created.stdout.trim() || 'git worktree add failed' };
  await git(dir, ['config', 'core.hooksPath', hooks]);
  return { dir };
}

/** Merges `branch` unless it is already contained. A conflict leaves the worktree as git stopped. */
export async function mergeBranch(dir: string, branch: string): Promise<{ conflict: boolean; files: string[] }> {
  const contained = await git(dir, ['merge-base', '--is-ancestor', branch, 'HEAD']);
  if (contained.code === 0) return { conflict: false, files: [] };
  const merged = await git(dir, [
    '-c', 'user.name=TeamAI', '-c', 'user.email=teamai@localhost',
    'merge', '--no-ff', '--no-edit', branch,
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
  await git(dir, ['config', 'core.hooksPath', hooks]);
  const saved = await fs.mkdtemp(path.join(os.tmpdir(), 'teamai-agent-'));
  for (const relative of AGENT_PATHS) {
    const from = path.join(dir, relative);
    try {
      await fs.cp(from, path.join(saved, relative), { recursive: true });
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
  return { ok: true, saved };
}

/** Records the agent files present after team delivery, so that delivery is not a step edit. */
export async function recordConfigOverlay(dir: string, saved: string): Promise<void> {
  await fs.writeFile(path.join(saved, '_overlay.json'), JSON.stringify(await fileManifest(dir)));
}

/** Puts back each branch agent file that the step left unchanged. A file the step edited stays. */
export async function restoreUneditedConfig(dir: string, _commit: string, saved: string): Promise<void> {
  const overlay = JSON.parse(await fs.readFile(path.join(saved, '_overlay.json'), 'utf8')) as Record<string, string>;
  const current = await fileManifest(dir);
  const branch = await fileManifest(saved);
  const files = new Set([...Object.keys(overlay), ...Object.keys(current), ...Object.keys(branch)]);
  for (const relative of files) {
    if (relative === '_overlay.json' || current[relative] !== overlay[relative]) continue;
    await fs.rm(path.join(dir, relative), { force: true });
    try {
      await fs.mkdir(path.dirname(path.join(dir, relative)), { recursive: true });
      const source = path.join(saved, relative);
      const target = path.join(dir, relative);
      const stats = await fs.lstat(source);
      if (stats.isSymbolicLink()) await fs.symlink(await fs.readlink(source), target);
      else await fs.copyFile(source, target);
    } catch {
      // The branch had no file at this path, and the step did not add one.
    }
  }
  await fs.rm(saved, { recursive: true, force: true });
}

async function fileManifest(root: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  const walk = async (relative: string): Promise<void> => {
    const current = path.join(root, relative);
    let entries;
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      try {
        files[relative] = (await fs.lstat(current)).isSymbolicLink()
          ? `link:${await fs.readlink(current)}`
          : `file:${(await fs.readFile(current)).toString('base64')}`;
      } catch {
        // Missing paths have no manifest entry.
      }
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      await walk(path.join(relative, entry.name));
    }
  };
  for (const relative of AGENT_PATHS) await walk(relative);
  return files;
}

export async function commitWork(dir: string, message: string): Promise<{ from: string; to: string; commits: string[] } | { error: string }> {
  const before = await git(dir, ['rev-parse', 'HEAD']);
  if (before.code !== 0) return { error: before.stderr.trim() || 'HEAD could not be read' };
  const from = before.stdout.trim();
  const status = await git(dir, ['status', '--porcelain']);
  if (status.stdout.trim() !== '') {
    const added = await git(dir, ['add', '-A']);
    if (added.code !== 0) return { error: added.stderr.trim() || 'git add failed' };
    const committed = await git(dir, ['-c', 'user.name=TeamAI', '-c', 'user.email=teamai@localhost', 'commit', '-m', message]);
    if (committed.code !== 0) return { error: committed.stderr.trim() || committed.stdout.trim() || 'git commit failed' };
  }
  const after = await git(dir, ['rev-parse', 'HEAD']);
  const to = after.stdout.trim();
  const listed = to === from ? { stdout: '' } : await git(dir, ['rev-list', '--reverse', `${from}..${to}`]);
  return { from, to, commits: listed.stdout.split('\n').map((commit) => commit.trim()).filter((commit) => commit !== '') };
}

/** Pushes when `origin` exists and this step made a commit. No origin is not a failure. */
export async function pushIfOrigin(dir: string, branch: string, commits: string[]): Promise<'pushed' | 'no-origin' | 'unchanged' | { error: string }> {
  if (commits.length === 0) return 'unchanged';
  const origin = await git(dir, ['remote', 'get-url', 'origin']);
  if (origin.code !== 0) return 'no-origin';
  const pushed = await git(dir, ['push', '-u', 'origin', `${branch}:${branch}`]);
  return pushed.code === 0 ? 'pushed' : { error: (pushed.stderr || pushed.stdout).trim() || 'git push failed' };
}

export async function removeWorktree(main: string, dir: string): Promise<void> {
  await git(main, ['worktree', 'remove', '--force', dir]);
  await git(main, ['worktree', 'prune']);
}
