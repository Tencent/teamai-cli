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
import { z } from 'zod';
import { TeamaiConfigBaseSchema } from '../types.js';
import { writeJsonAtomic } from '../utils/fs.js';

/** Agent configuration a workspace step reads from the run's base rather than from its branch. */
export const AGENT_PATHS: readonly string[] = agentConfigPaths();

function agentConfigPaths(): string[] {
  const paths = new Set(['AGENTS.md', 'CLAUDE.md', '.agents', '.githooks']);
  for (const tool of Object.values(TeamaiConfigBaseSchema.shape.toolPaths.parse(undefined))) {
    for (const field of ['skills', 'rules', 'settings', 'hooks', 'claudemd', 'agents', 'mcpProject'] as const) {
      const relative = tool[field];
      if (!relative) continue;
      const root = field === 'hooks' ? path.posix.dirname(relative) : relative;
      // A hooks file at the repository root has dirname `.`, which would reset the whole worktree.
      paths.add(configRoot(root === '.' ? relative : root));
    }
  }
  return [...paths];
}

/** A tool's own directory is reset whole. `.github` also holds workflows and code owners, so only its agent paths are. */
function configRoot(relative: string): string {
  const first = relative.split('/')[0] ?? relative;
  return first !== relative && first.startsWith('.') && first !== '.github' ? first : relative;
}

/** Paths a delivered branch may not change beyond AGENT_PATHS: CI and hooks, which run with someone's credentials. */
export const DELIVERY_ONLY_PATHS: readonly string[] = [
  '.github/workflows', '.github/actions', '.github/CODEOWNERS', '.gitlab-ci.yml', '.gitlab', '.coding-ci.yaml', '.cnb.yml', '.cnb',
  '.circleci', '.buildkite', '.husky', 'Jenkinsfile', 'azure-pipelines.yml', 'bitbucket-pipelines.yml', '.pre-commit-config.yaml',
];

/**
 * The files among `changed` that no pull request TeamAI delivers may change: AGENT_PATHS, DELIVERY_ONLY_PATHS, and
 * AGENTS.md or CLAUDE.md at any depth. Case-insensitive, as a checkout on a case-insensitive file system reads them.
 */
export function protectedPaths(changed: readonly string[]): string[] {
  const roots = [...AGENT_PATHS, ...DELIVERY_ONLY_PATHS].map((root) => root.toLowerCase());
  return changed.filter((file) => {
    const lower = file.toLowerCase();
    return /(^|\/)(agents|claude)\.md$/.test(lower) || roots.some((root) => lower === root || lower.startsWith(`${root}/`));
  });
}

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs git in `cwd`, writing `input` to its stdin, or stopping it once `timeoutMs` passed. */
export function git(cwd: string, args: string[], options?: { input: string } | { timeoutMs: number; env?: NodeJS.ProcessEnv }): Promise<GitResult> {
  if (options === undefined || !('input' in options)) {
    return new Promise((resolve) => {
      execFile('git', args, { cwd, env: { ...process.env, ...options?.env }, windowsHide: true, timeout: options?.timeoutMs }, (error, stdout, stderr) => {
        const code = typeof error?.code === 'number' ? error.code : error ? 1 : 0;
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
    child.stdin.end(options.input);
  });
}

export function worktreePath(main: string, branch: string): string {
  const safe = branch.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'step';
  const hash = createHash('sha256').update(branch).digest('hex').slice(0, 12);
  return path.join(main, '.teamai', 'workflow-worktrees', `${safe}-${hash}`);
}

export function stepCheckout(active: string, branch: string | undefined): string {
  return branch === undefined ? active : worktreePath(active, branch);
}

/** The checkout `dir` is in a step worktree of (see worktreePath), whether or not that worktree still exists. */
export function worktreeCheckout(dir: string): string | undefined {
  const parts = path.resolve(dir).split(path.sep);
  const at = parts.lastIndexOf('workflow-worktrees');
  if (at < 2 || parts[at - 1] !== '.teamai' || at === parts.length - 1) return undefined;
  return parts.slice(0, at - 1).join(path.sep) || path.sep;
}

/** A path git keeps for this checkout. A linked worktree's `.git` is a file, so the path is not `<checkout>/.git`. */
export async function gitPath(cwd: string, name: string): Promise<string | undefined> {
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

/** The commit HEAD points to, and the branch when HEAD is not detached. */
export async function headCommit(cwd: string): Promise<{ ref?: string; commit: string } | undefined> {
  const result = await git(cwd, ['rev-parse', 'HEAD']);
  if (result.code !== 0) return undefined;
  const commit = result.stdout.trim();
  if (!commit) return undefined;
  const ref = (await git(cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD'])).stdout.trim();
  return ref ? { ref, commit } : { commit };
}

/**
 * Creates the worktree when it is missing. A branch that already exists is checked out as it is. An existing worktree
 * off its branch is refused, so a step never commits on whatever HEAD was left.
 */
export async function ensureWorktree(main: string, branch: string, start: string): Promise<{ dir: string; created: boolean } | { error: string }> {
  const dir = worktreePath(main, branch);
  const hooks = hooksPath(main);
  await fs.mkdir(hooks, { recursive: true });
  await hideTeamaiWorktrees(main);
  const present = await fs.stat(dir).then((stats) => stats.isDirectory(), () => false);
  // A deleted worktree stays registered, and `worktree add` refuses its path until it is pruned.
  if (!present) await git(main, ['worktree', 'prune']);
  if (present) {
    const prefix = await git(dir, ['rev-parse', '--show-prefix']);
    if (prefix.code !== 0 || prefix.stdout.trim() !== '') {
      return { error: `${dir} is not a workflow worktree, so no step runs there. Move it out of the way, then retry the step.` };
    }
    const on = await offBranch(dir, branch);
    if (on) return { error: `Workspace ${dir} is ${on}, not on branch ${branch}. Check out ${branch} in ${dir}, then retry the step.` };
    await worktreeHooks(main, dir, hooks);
    return { dir, created: false };
  }
  await fs.mkdir(path.dirname(dir), { recursive: true });
  const config = ['-c', `core.hooksPath=${hooks}`];
  const exists = await git(main, ['rev-parse', '--verify', '--quiet', branch]);
  const created = exists.code === 0
    ? await git(main, [...config, 'worktree', 'add', dir, branch])
    : await git(main, [...config, 'worktree', 'add', '-b', branch, dir, start]);
  if (created.code !== 0) return { error: created.stderr.trim() || created.stdout.trim() || 'git worktree add failed' };
  await worktreeHooks(main, dir, hooks);
  return { dir, created: true };
}

/** In the worktree's own git dir from its creation until its setup finished, so one whose setup never finished is made again. */
const SETUP_UNFINISHED = 'teamai-setup-unfinished';

export async function setupUnfinished(dir: string): Promise<boolean> {
  const marker = await gitPath(dir, SETUP_UNFINISHED);
  return marker !== undefined && await fs.stat(marker).then(() => true, () => false);
}

export async function markSetup(dir: string, state: 'unfinished' | 'finished'): Promise<void> {
  const marker = await gitPath(dir, SETUP_UNFINISHED);
  if (!marker) return;
  if (state === 'unfinished') await fs.writeFile(marker, '');
  else await fs.rm(marker, { force: true });
}

/** Where HEAD is, such as `on refs/heads/other` or `detached at <commit>`, when it is not on `branch`. Undefined when it is. */
export async function offBranch(dir: string, branch: string): Promise<string | undefined> {
  const head = (await git(dir, ['symbolic-ref', '--quiet', 'HEAD'])).stdout.trim();
  if (head === `refs/heads/${branch}`) return undefined;
  return head ? `on ${head}` : `detached at ${(await git(dir, ['rev-parse', 'HEAD'])).stdout.trim()}`;
}

/**
 * Brings local branch `branch` to `expected`, the commit a run this machine took over recorded for it, by fast-forward
 * only. A branch ahead of it or apart from it, or its worktree with changes, a reader's mark, or HEAD elsewhere, stays
 * as it is, and the answer says why, even when the branch is already at `expected`. A branch this checkout does not have
 * is left to the lease that opens it.
 */
export async function reconcileCopy(main: string, branch: string, expected: string): Promise<{ error: string } | undefined> {
  const ref = `refs/heads/${branch}`;
  const local = await git(main, ['rev-parse', '--verify', '--quiet', ref]);
  if (local.code !== 0) return undefined;
  const tip = local.stdout.trim();
  if (tip !== expected && (await git(main, ['merge-base', '--is-ancestor', tip, expected])).code !== 0) {
    return { error: `Branch ${branch} here is at ${tip}, which is not behind ${expected}, the commit the run recorded for it, so it holds work the run does not know about. teamai moves neither: keep that work elsewhere, delete or reset ${branch}, then resume the run.` };
  }
  const own = worktreePath(main, branch);
  if (await fs.stat(own).then((stats) => stats.isDirectory(), () => false)) {
    const on = await offBranch(own, branch);
    if (on) return { error: `Workspace ${own} is ${on}, not on branch ${branch}, so the run does not continue there. Check out ${branch} in ${own}, then resume the run.` };
  }
  const listed = await git(main, ['worktree', 'list', '--porcelain']);
  const dir = listed.stdout.split('\n\n').map((entry) => entry.split('\n'))
    .find((lines) => lines.includes(`branch ${ref}`))?.find((line) => line.startsWith('worktree '))?.slice('worktree '.length);
  if (dir !== undefined) {
    if (await unrestoredCopy(dir)) {
      return { error: `Workspace ${dir} was left by a reader and is not back, so the run does not continue there. Put it back as the step found it, then resume the run.` };
    }
    const status = await copyStatus(dir);
    if ('error' in status) return status;
    if (status.lines.length > 0) {
      return { error: `Workspace ${dir} on ${branch} has changes the run did not record, so the run does not continue there. Move them elsewhere or remove them, then resume the run.` };
    }
  }
  if (tip === expected) return undefined;
  if (dir === undefined) {
    const moved = await git(main, ['update-ref', ref, expected, tip]);
    return moved.code === 0 ? undefined : { error: `Branch ${branch} could not be moved from ${tip} to ${expected}: ${moved.stderr.trim()}` };
  }
  const merged = await git(dir, ['merge', '--ff-only', '--quiet', expected]);
  return merged.code === 0 ? undefined : { error: `Workspace ${dir} could not be moved to ${expected}: ${merged.stderr.trim()}` };
}

/** Points this worktree's hooks at `hooks` without changing the active checkout's hooks. */
async function worktreeHooks(main: string, dir: string, hooks: string): Promise<void> {
  await git(main, ['config', 'extensions.worktreeConfig', 'true']);
  await git(dir, ['config', '--worktree', 'core.hooksPath', hooks]);
}

/**
 * The commits among `commits` this checkout still lacks after fetching run `run`'s branches from origin. A fetch whose
 * refspec matches no branch exits 0, so each commit is checked again after it. `fetchError` is git's message when the
 * fetch itself failed. `fetch` bounds the fetch and sets its environment.
 */
export async function fetchMissingCommits(
  dir: string, { run, commits }: { run: string; commits: string[] }, fetch?: { timeoutMs: number; env?: NodeJS.ProcessEnv },
): Promise<{ missing: string[]; fetchError?: string }> {
  const lacking = await lackedCommits(dir, commits);
  if (lacking.length === 0) return { missing: [] };
  const fetched = await git(dir, ['fetch', '--quiet', '--no-tags', 'origin', `+refs/heads/teamai/${run}/*:refs/remotes/origin/teamai/${run}/*`], fetch);
  const missing = await lackedCommits(dir, lacking);
  if (fetched.code === 0 || missing.length === 0) return { missing };
  return { missing, fetchError: (fetched.stderr || fetched.stdout).trim() || 'git fetch failed' };
}

async function lackedCommits(dir: string, commits: string[]): Promise<string[]> {
  const lacking: string[] = [];
  for (const commit of new Set(commits)) {
    if ((await git(dir, ['cat-file', '-e', `${commit}^{commit}`])).code !== 0) lacking.push(commit);
  }
  return lacking;
}

/**
 * Merges `commit` unless it is already contained. A conflict leaves the worktree as git stopped. A merge that stopped
 * with no unmerged file and no merge in progress, such as unrelated histories or an untracked file in the way, is
 * `failed` with git's message.
 */
export async function mergeBranch(dir: string, commit: string): Promise<
  { state: 'merged' } | { state: 'conflict'; files: string[] } | { state: 'failed'; error: string }
> {
  const contained = await git(dir, ['merge-base', '--is-ancestor', commit, 'HEAD']);
  if (contained.code === 0) return { state: 'merged' };
  const merged = await git(dir, [
    '-c', 'user.name=TeamAI', '-c', 'user.email=teamai@localhost',
    'merge', '--no-ff', '--no-edit', commit,
  ]);
  if (merged.code === 0) return { state: 'merged' };
  const unmerged = await gitPaths(dir, ['diff', '--name-only', '--diff-filter=U']);
  if (unmerged.code !== 0) return { state: 'failed', error: unmerged.stderr.trim() || 'git diff failed' };
  // An earlier attempt that left its merge unfinished resolves it as a conflict, even with every file staged.
  const unfinished = (await git(dir, ['rev-parse', '--verify', '--quiet', 'MERGE_HEAD'])).code === 0;
  if (unmerged.paths.length > 0 || unfinished) return { state: 'conflict', files: unmerged.paths };
  return { state: 'failed', error: (merged.stderr || merged.stdout).trim() || 'git merge failed' };
}

/**
 * Replaces agent configuration with the copy at `commit` and points hooks at an empty directory.
 * `saved` is the branch's own copy, put back for paths the step does not edit.
 */
export async function applyBaseConfig(
  dir: string, commit: string, hooks: string,
): Promise<{ ok: true; saved: string } | { ok: false; message: string }> {
  await git(dir, ['config', '--worktree', 'core.hooksPath', hooks]);
  const linked = await symlinkedParent(dir);
  if (linked) {
    // Every run branch starts from the base, so no step can fix a symlink the base has.
    const inBase = (await git(dir, ['ls-tree', commit, '--', linked.parent])).stdout.startsWith('120000 ');
    if (inBase) {
      return { ok: false, message: `Agent configuration ${linked.relative} is under the symlink ${linked.parent} in the run's base commit ${commit}, so it was not reset. Commit ${linked.parent} as a directory on the base branch, then start a new run.` };
    }
    const branch = (await git(dir, ['symbolic-ref', '--quiet', 'HEAD'])).stdout.trim().replace(/^refs\/heads\//, '');
    return { ok: false, message: `Agent configuration ${linked.relative} is under the symlink ${linked.parent} on branch ${branch}, so it was not reset. Commit ${linked.parent} as a directory on branch ${branch} in ${dir}, then retry the step.` };
  }
  // Listed before anything is removed, so a base git cannot read leaves the branch's agent files in place.
  const present = await gitPaths(dir, ['ls-tree', '--name-only', commit, '--', ...AGENT_PATHS]);
  if (present.code !== 0) return { ok: false, message: unreadBase(dir, commit, present.stderr) };
  // A failed checkout still stages the base copy, so the index is put back with the files.
  const indexFile = await gitPath(dir, 'index');
  const index = indexFile === undefined ? undefined : await fs.readFile(indexFile).catch(() => undefined);
  if (indexFile === undefined || index === undefined) {
    return { ok: false, message: `Agent configuration in ${dir} could not be reset to the run's base commit ${commit}, because its git index could not be read, so the step did not run. Check that git status works in ${dir}, then retry the step.` };
  }
  const saved = await fs.mkdtemp(path.join(os.tmpdir(), 'teamai-agent-'));
  const conflicts = (await git(dir, ['ls-files', '-u', '-z', '--', ...AGENT_PATHS])).stdout;
  await fs.writeFile(path.join(saved, '_conflicts'), conflicts);
  for (const relative of AGENT_PATHS) {
    try {
      await copyEntry(path.join(dir, relative), path.join(saved, relative));
    } catch {
      // The branch does not have this path.
    }
  }
  for (const relative of AGENT_PATHS) await fs.rm(path.join(dir, relative), { recursive: true, force: true });
  const refused = await checkoutBaseConfig(dir, commit, present.paths);
  if (refused) {
    await putBackBranchConfig(dir, saved, { indexFile, index });
    return { ok: false, message: refused };
  }
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

/** Checks out the base's agent paths `paths` over the removed branch copy. Why the step cannot run, when it cannot. */
async function checkoutBaseConfig(dir: string, commit: string, paths: string[]): Promise<string | undefined> {
  if (paths.length > 0) {
    const restored = await git(dir, ['checkout', commit, '--', ...paths]);
    if (restored.code !== 0) {
      return `Agent configuration in ${dir} could not be checked out from the run's base commit ${commit}, so the step did not run and the branch's agent files were left as they were. Git said: ${restored.stderr.trim() || 'no message'}. Fix what git reported, then retry the step.`;
    }
  }
  const extra = await gitPaths(dir, ['diff', '--name-only', commit, '--', ...AGENT_PATHS]);
  if (extra.code !== 0) return unreadBase(dir, commit, extra.stderr);
  if (extra.paths.length === 0) return undefined;
  return `Agent configuration in ${dir} does not match the run's base commit ${commit} after checking it out: ${extra.paths.join(', ')}. The step did not run and the branch's agent files were left as they were. A .gitattributes filter or line-ending rule that rewrites these files on checkout usually causes this. Fix that rule and retry the step, or commit the files as they check out on the base branch and start a new run.`;
}

/** Puts the branch's agent files and index back after a reset that failed, and removes the saved copy. */
async function putBackBranchConfig(dir: string, saved: string, { indexFile, index }: { indexFile: string; index: Buffer }): Promise<void> {
  for (const relative of AGENT_PATHS) {
    await fs.rm(path.join(dir, relative), { recursive: true, force: true });
    try {
      await copyEntry(path.join(saved, relative), path.join(dir, relative));
    } catch {
      // The branch does not have this path.
    }
  }
  // Renamed over the index, so git never reads it half written.
  await fs.writeFile(`${indexFile}.teamai`, index);
  await fs.rename(`${indexFile}.teamai`, indexFile);
  await fs.rm(saved, { recursive: true, force: true });
}

function unreadBase(dir: string, commit: string, stderr: string): string {
  return `Agent configuration in ${dir} could not be reset to the run's base commit ${commit}, so the step did not run. Git said: ${stderr.trim() || 'no message'}. Make ${commit} available in this checkout, for example by fetching the branch that has it, then retry the step.`;
}

/** An agent path whose parent is a symlink. Copying or removing it would reach outside the worktree. */
async function symlinkedParent(dir: string): Promise<{ relative: string; parent: string } | undefined> {
  for (const relative of AGENT_PATHS) {
    const parent = await linkedParent(dir, relative);
    if (parent) return { relative, parent };
  }
  return undefined;
}

async function linkedParent(dir: string, relative: string): Promise<string | undefined> {
  const parts = relative.split('/');
  for (let end = 1; end < parts.length; end += 1) {
    const parent = parts.slice(0, end).join('/');
    if (await fs.lstat(path.join(dir, parent)).then((stats) => stats.isSymbolicLink(), () => false)) return parent;
  }
  return undefined;
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

/**
 * Puts back each branch agent file that the step left unchanged. A file the step edited stays. When git cannot list the
 * worktree's files, nothing is put back, `saved` is kept, and the reason is returned as a clause.
 */
export async function restoreUneditedConfig(dir: string, _commit: string, saved: string): Promise<string | undefined> {
  // Listed before anything changes. The index stays as it is until the files are back.
  const unmergedListed = await gitPaths(dir, ['diff', '--name-only', '--diff-filter=U']);
  const indexed = await gitPaths(dir, ['ls-files', '--', ...AGENT_PATHS]);
  const unlisted = [unmergedListed, indexed].find((listed) => listed.code !== 0);
  if (unlisted) {
    return `git could not list the files in ${dir} (${unlisted.stderr.trim() || 'no message'}); the branch's agent files are still in ${saved}`;
  }
  const overlay = JSON.parse(await fs.readFile(path.join(saved, '_overlay.json'), 'utf8')) as Record<string, string>;
  const current = await fileManifest(dir);
  const branch = await fileManifest(saved);
  const conflicts = await fs.readFile(path.join(saved, '_conflicts'), 'utf8').catch(() => '');
  const dirs = JSON.parse(await fs.readFile(path.join(saved, '_dirs.json'), 'utf8').catch(() => '[]')) as string[];
  const marked = await markedConflicts(dir, conflictPaths(conflicts));
  // Staging a conflict without leaving markers is a resolution, even when the text matches the overlay.
  // An unstaged file that still matches the overlay is not.
  const unmerged = new Set(unmergedListed.paths);
  const unresolved = [...new Set([
    ...conflictPaths(conflicts).filter((relative) => current[relative] === overlay[relative] && unmerged.has(relative)),
    ...marked,
  ])];
  // The step replaced a parent of these agent paths with a symlink. That is its edit, and restoring under it would
  // delete or write files outside the worktree.
  const linked: string[] = [];
  for (const root of AGENT_PATHS) if (await linkedParent(dir, root)) linked.push(path.join(root));
  const files = new Set([...Object.keys(overlay), ...Object.keys(current), ...Object.keys(branch)]);
  for (const relative of files) {
    if (linked.some((root) => relative === root || relative.startsWith(`${root}${path.sep}`))) continue;
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
  const present = await presentAgentPaths(dir, indexed.paths);
  if (present.length > 0) await git(dir, ['add', '-A', '--', ...present]);
  if (unresolved.length > 0) await restoreConflictStages(dir, conflicts, unresolved);
  return undefined;
}

/**
 * Agent paths in the worktree or among `indexed`, the index's agent files. `git add` stages nothing when one of its paths
 * matches neither.
 */
async function presentAgentPaths(dir: string, indexed: string[]): Promise<string[]> {
  const present: string[] = [];
  for (const relative of AGENT_PATHS) {
    const tracked = indexed.some((file) => file === relative || file.startsWith(`${relative}/`));
    if (tracked || await fs.lstat(path.join(dir, relative)).then(() => true, () => false)) present.push(relative);
  }
  return present;
}

async function gitPaths(dir: string, args: string[]): Promise<{ code: number; stderr: string; paths: string[] }> {
  const listed = await git(dir, [...args.slice(0, 1), '-z', ...args.slice(1)]);
  return { code: listed.code, stderr: listed.stderr, paths: listed.stdout.split('\0').filter((file) => file !== '') };
}

function conflictRecords(conflicts: string): { line: string; path: string }[] {
  return conflicts.split('\0').flatMap((record) => {
    const line = record.endsWith('\n') ? record.slice(0, -1) : record;
    const tab = line.lastIndexOf('\t');
    if (tab < 0 || line.slice(tab + 1) === '') return [];
    return [{ line, path: line.slice(tab + 1) }];
  });
}

function conflictPaths(conflicts: string): string[] {
  return [...new Set(conflictRecords(conflicts).map((record) => record.path))];
}

/** Puts unmerged stages back so `git add` does not publish conflict markers as a resolution. */
async function restoreConflictStages(dir: string, conflicts: string, paths: string[]): Promise<void> {
  const wanted = new Set(paths);
  const lines = conflictRecords(conflicts).filter((record) => wanted.has(record.path)).map((record) => record.line);
  // `git rm --cached` leaves stage 0 in place beside the restored stages, and then `git add` cannot clear them.
  const removal = paths.map((relative) => `0 ${'0'.repeat(40)}\t${relative}`);
  const payload = [...removal, ...lines];
  if (payload.length > 0) await git(dir, ['update-index', '--index-info'], { input: `${payload.join('\n')}\n` });
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

/** Stages every change. `git add -A` skips a submodule whose `ignore` is `all`, so each submodule is also staged by name. */
async function stageAll(dir: string): Promise<GitResult> {
  const added = await git(dir, ['add', '-A']);
  if (added.code !== 0) return added;
  const listed = await git(dir, ['ls-files', '-s', '-z']);
  if (listed.code !== 0) return listed;
  const modules = gitlinkLines(listed.stdout).map((line) => line.slice(line.indexOf('\t') + 1));
  return modules.length > 0 ? git(dir, ['add', '-f', '--', ...modules]) : added;
}

export async function commitWork(
  dir: string, message: string, fromCommit?: string,
): Promise<{ from: string; to: string; commits: string[] } | { error: string }> {
  const before = fromCommit === undefined ? await git(dir, ['rev-parse', 'HEAD']) : { code: 0, stdout: fromCommit, stderr: '' };
  if (before.code !== 0) return { error: before.stderr.trim() || 'HEAD could not be read' };
  const from = before.stdout.trim();
  const merging = (await git(dir, ['rev-parse', '--verify', '--quiet', 'MERGE_HEAD'])).code === 0;
  const added = await stageAll(dir);
  if (added.code !== 0) return { error: added.stderr.trim() || 'git add failed' };
  const staged = await git(dir, ['diff', '--cached', '--quiet', '--ignore-submodules=none', '--no-ext-diff']);
  if (staged.code !== 0 || merging) {
    const committed = await git(dir, ['-c', 'user.name=TeamAI', '-c', 'user.email=teamai@localhost', 'commit', '-m', message]);
    if (committed.code !== 0) return { error: committed.stderr.trim() || committed.stdout.trim() || 'git commit failed' };
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
  const holders = await git(dir, ['branch', '--no-color', '--contains', tip]);
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
  // A nested agent path such as .github/copilot-instructions.md has no parent in a fresh copy.
  await fs.mkdir(path.dirname(to), { recursive: true });
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

const UnrestoredMarker = z.object({ branch: z.string(), commit: z.string(), step: z.string(), reason: z.string(), found: z.array(z.string()) });
export type UnrestoredMarker = z.infer<typeof UnrestoredMarker>;

/** In the worktree's own git dir, so the marker never shows in its status. */
const UNRESTORED_MARKER = 'teamai-unrestored';

/** A copy's status, with every untracked file and submodule change whatever the user's status config hides. */
async function copyStatus(dir: string): Promise<{ lines: string[] } | { error: string }> {
  const status = await git(dir, ['status', '--porcelain', '--untracked-files=all', '--ignore-submodules=none']);
  if (status.code !== 0) return { error: status.stderr.trim() || 'git status failed' };
  return { lines: status.stdout.split('\n').filter((line) => line.trim() !== '') };
}

/** Why `dir` is not on `branch` at `commit` with the status `found`, submodules included. Undefined when it is. */
async function copyLeftOver(dir: string, { branch, commit, found }: { branch: string; commit: string; found: string[] }): Promise<string | undefined> {
  const head = (await git(dir, ['symbolic-ref', '--quiet', 'HEAD'])).stdout.trim();
  if (head !== `refs/heads/${branch}`) return head ? `HEAD is on ${head}` : 'HEAD is detached';
  const at = (await git(dir, ['rev-parse', 'HEAD'])).stdout.trim();
  if (at !== commit) return `HEAD is at ${at}`;
  const status = await copyStatus(dir);
  if ('error' in status) return status.error;
  const was = new Set(found);
  const now = new Set(status.lines);
  const lines = [...status.lines.filter((line) => !was.has(line)), ...found.filter((line) => !now.has(line))];
  if (lines.length === 0) return undefined;
  return `it has changes: ${lines.slice(0, 5).map((line) => line.trim()).join(', ')}${lines.length > 5 ? `, and ${lines.length - 5} more` : ''}`;
}

/**
 * Marks `dir` as left by a reader before the reader changes anything, with the status it has now. Putting the copy back
 * removes the mark, so a driver killed before that leaves the copy refused to later steps until it is back.
 */
export async function markReadCopy(dir: string, { branch, step }: { branch: string; step: string }): Promise<{ found: string[] } | { error: string }> {
  const status = await copyStatus(dir);
  if ('error' in status) return status;
  const head = await git(dir, ['rev-parse', 'HEAD']);
  const marker = await gitPath(dir, UNRESTORED_MARKER);
  if (head.code !== 0 || !marker) return { error: head.stderr.trim() || 'its git directory could not be found' };
  const record: UnrestoredMarker = { branch, commit: head.stdout.trim(), step, reason: 'the reader did not finish', found: status.lines };
  try {
    await writeJsonAtomic(marker, record);
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
  return { found: status.lines };
}

async function clearReadCopyMark(dir: string): Promise<void> {
  const marker = await gitPath(dir, UNRESTORED_MARKER);
  if (marker) await fs.rm(marker, { force: true });
}

/**
 * A copy a reader could not put back, while it is still not back. Once a copy that was clean is back, the marker is
 * removed, so the person who put it back only retries the step.
 */
export async function unrestoredCopy(dir: string): Promise<
  { state: 'unrestored'; dir: string; marker: UnrestoredMarker; left: string } | { state: 'unreadable'; dir: string; marker: string } | undefined
> {
  const file = await gitPath(dir, UNRESTORED_MARKER);
  if (!file) return undefined;
  let raw: unknown;
  try {
    raw = JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined;
    return { state: 'unreadable', dir, marker: file };
  }
  const parsed = UnrestoredMarker.safeParse(raw);
  if (!parsed.success) return { state: 'unreadable', dir, marker: file };
  // A status line names a path, not its content, so only a copy that was clean can be seen to be back.
  if (parsed.data.found.length > 0) {
    return { state: 'unrestored', dir, marker: parsed.data, left: `it had changes when the step started, so teamai cannot tell when it is back; delete ${file} once it is` };
  }
  const left = await copyLeftOver(dir, parsed.data);
  if (left) return { state: 'unrestored', dir, marker: parsed.data, left };
  await fs.rm(file, { force: true });
  return undefined;
}

function gitlinkLines(listed: string): string[] {
  return listed.split('\0').filter((line) => line.startsWith('160000 '));
}

/** Each submodule path `commit` records, with the commit it records there. */
async function treeGitlinks(dir: string, commit: string): Promise<Map<string, string> | { error: string }> {
  const listed = await git(dir, ['ls-tree', '-r', '-z', commit]);
  if (listed.code !== 0) return { error: listed.stderr.trim() || `git ls-tree ${commit} failed` };
  return new Map(gitlinkLines(listed.stdout).map((line) => {
    const tab = line.indexOf('\t');
    return [line.slice(tab + 1), line.slice(0, tab).split(' ')[2] ?? ''];
  }));
}

/** Submodule paths whose commit `to` records and `from` does not, at any depth below `prefix`. */
async function movedModules(dir: string, from: string | undefined, to: string, prefix: string): Promise<{ path: string; dir: string; commit: string }[] | { error: string }> {
  const before = from ? await treeGitlinks(dir, from) : new Map<string, string>();
  const after = await treeGitlinks(dir, to);
  if ('error' in before) return before;
  if ('error' in after) return after;
  const moved: { path: string; dir: string; commit: string }[] = [];
  for (const [relative, commit] of after) {
    const was = before.get(relative);
    if (was === commit) continue;
    const sub = path.join(dir, relative);
    moved.push({ path: `${prefix}${relative}`, dir: sub, commit });
    const nested = await movedModules(sub, was, commit, `${prefix}${relative}/`);
    if ('error' in nested) return nested;
    moved.push(...nested);
  }
  return moved;
}

/**
 * Copies each submodule commit `to` records and `from` does not, at any depth, into this repository's own store. A gitlink
 * does not keep its commit reachable, and removing the copy deletes the submodule's store with it.
 */
async function keepModuleCommits(dir: string, { from, to, attempt }: { from: string; to: string; attempt: string }): Promise<{ modules?: string } | { error: string }> {
  const moved = await movedModules(dir, from, to, '');
  if ('error' in moved) return moved;
  if (moved.length === 0) return {};
  const common = await git(dir, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  if (common.code !== 0) return { error: common.stderr.trim() || 'the git directory could not be found' };
  const modules = `refs/teamai/kept-modules/${attempt}/`;
  for (const module of moved) {
    // Named by commit: a path need not be a valid ref name, and vendor would clash with vendor/inner. This copy stays
    // local, so the user's push policy and hooks do not apply.
    const pushed = await git(module.dir, ['push', '-q', '--no-verify', '--no-recurse-submodules', common.stdout.trim(), `${module.commit}:${modules}${module.commit}`]);
    if (pushed.code !== 0) return { error: pushed.stderr.trim() || `the commit in ${module.path} could not be kept` };
  }
  return { modules };
}

/**
 * Repositories among `paths`, submodules and ones the step created, whose changes the kept commit cannot hold: uncommitted
 * or untracked files, or a nested submodule's commit its parent has not recorded. A submodule with no checkout left counts
 * too, since its files may have gone with it.
 */
async function unkeptRepositories(dir: string, { paths, commit }: { paths: string[]; commit: string }): Promise<{ paths: string[] } | { error: string }> {
  const recorded = await treeGitlinks(dir, commit);
  const staged = await git(dir, ['ls-files', '-s', '-z']);
  if ('error' in recorded || staged.code !== 0) return { error: 'error' in recorded ? recorded.error : staged.stderr.trim() || 'git ls-files failed' };
  const gitlinks = new Set([...recorded.keys(), ...gitlinkLines(staged.stdout).map((line) => line.slice(line.indexOf('\t') + 1))]);
  // Dirty, not all: a nested submodule's new commit shows only as a change in its parent.
  const status = ['status', '--porcelain', '--untracked-files=all', '--ignore-submodules=dirty'];
  const unkept: string[] = [];
  for (const relative of paths) {
    // Status lists a repository the step created as its directory with a trailing slash.
    const name = relative.replace(/\/$/, '');
    if (!gitlinks.has(name) && name === relative) continue;
    const repo = path.join(dir, name);
    const top = await git(repo, ['rev-parse', '--show-prefix']);
    if (top.code !== 0 || top.stdout.trim() !== '') {
      if (gitlinks.has(name)) unkept.push(name);
      continue;
    }
    for (const args of [status, ['submodule', '--quiet', 'foreach', '--recursive', `test -z "$(git ${status.join(' ')})" || echo "$displaypath"`]]) {
      const listed = await git(repo, args);
      if (listed.code !== 0) return { error: listed.stderr.trim() || `git ${args[0]} failed in ${name}` };
      if (listed.stdout.trim() === '') continue;
      unkept.push(name);
      break;
    }
  }
  return { paths: unkept };
}

/** Where a reader's changes were kept: the whole tree on `ref`, and each submodule commit it made under `modules`. */
export type KeptChanges = { ref: string; modules?: string };

export function keptSentence(kept: KeptChanges): string {
  return kept.modules
    ? `Its changes are kept on ${kept.ref}, and the submodule commits it made under ${kept.modules}.`
    : `Its changes are kept on ${kept.ref}.`;
}

/**
 * Puts a copy a reader read back on `branch` at `commit` with the status `found` it had when the reader started, after
 * keeping what it changed on `refs/teamai/kept/<attempt>`. A copy it cannot put back keeps its mark with the reason, so
 * later steps there are refused until it is.
 */
export async function putBackCopy({ dir, branch, commit, found, changed, attempt, step }: {
  dir: string; branch: string; commit: string; found: string[]; changed: string[]; attempt: string; step: string;
}): Promise<
  { state: 'untouched' } | { state: 'restored'; kept: KeptChanges } | { state: 'unrestored'; reason: string; kept?: KeptChanges }
> {
  if (changed.length === 0) {
    await clearReadCopyMark(dir);
    return { state: 'untouched' };
  }
  const unrestored = async (reason: string, kept?: KeptChanges): Promise<{ state: 'unrestored'; reason: string; kept?: KeptChanges }> => {
    const marker = await gitPath(dir, UNRESTORED_MARKER);
    const record: UnrestoredMarker = { branch, commit, step, reason, found };
    if (marker) await writeJsonAtomic(marker, record);
    return { state: 'unrestored', reason, ...(kept ? { kept } : {}) };
  };
  // The keep below records a submodule only as its commit, so a submodule update would destroy its files.
  const dirty = await unkeptRepositories(dir, { paths: changed, commit });
  if ('error' in dirty) return unrestored(dirty.error);
  if (dirty.paths.length > 0) return unrestored(`submodules have uncommitted or untracked files: ${dirty.paths.join(', ')}`);
  // A commit of the whole tree, not `git stash`: the stash list is shared by every worktree, and a stash leaves out a submodule's commit.
  const ref = `refs/teamai/kept/${attempt}`;
  const added = await stageAll(dir);
  const tree = added.code === 0 ? await git(dir, ['write-tree']) : added;
  const committed = tree.code === 0
    ? await git(dir, ['-c', 'user.name=TeamAI', '-c', 'user.email=teamai@localhost', 'commit-tree', tree.stdout.trim(), '-p', 'HEAD', '-m', `teamai: kept ${step}`])
    : tree;
  if (committed.code !== 0) return unrestored(committed.stderr.trim() || 'its changes could not be kept');
  const modules = await keepModuleCommits(dir, { from: commit, to: committed.stdout.trim(), attempt });
  if ('error' in modules) return unrestored(modules.error);
  const recorded = await git(dir, ['update-ref', ref, committed.stdout.trim()]);
  // Without the ref, a reset would lose the changes.
  if (recorded.code !== 0) return unrestored(recorded.stderr.trim() || 'its changes could not be kept');
  const kept: KeptChanges = { ref, ...modules };
  // Back on the copy's branch first: a reset on a branch the step switched to would leave the copy elsewhere.
  // A superproject reset leaves initialized submodules where the step moved them. It must not recurse into a submodule an
  // earlier step left dirty.
  const noRecurse = ['-c', 'submodule.recurse=false'];
  const gitlinks = await treeGitlinks(dir, commit);
  if ('error' in gitlinks) return unrestored(gitlinks.error, kept);
  // Only the submodules the step changed: an update of any other would undo what an earlier step left there.
  const touched = changed.map((relative) => relative.replace(/\/$/, '')).filter((relative) => gitlinks.has(relative));
  const update = touched.length > 0 ? [['submodule', '--quiet', 'update', '--checkout', '--recursive', '--', ...touched]] : [];
  for (const args of [[...noRecurse, 'checkout', '-q', '-f', branch], [...noRecurse, 'reset', '-q', '--hard', commit], ['clean', '-q', '-fd'], ...update]) {
    const restored = await git(dir, args);
    if (restored.code !== 0) return unrestored(restored.stderr.trim() || `git ${args.join(' ')} failed`, kept);
  }
  // Exit codes are not enough: git clean skips a repository the step created, and a later git add -A commits it.
  const left = await copyLeftOver(dir, { branch, commit, found });
  if (left) return unrestored(left, kept);
  await clearReadCopyMark(dir);
  return { state: 'restored', kept };
}
