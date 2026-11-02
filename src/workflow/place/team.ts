/**
 * The team place a step opens with `workspace: { team: { branch } }`: a fresh clone of the team repo from its origin,
 * on `branch` as origin has it with origin's default branch merged in, else on the default branch. The step's work is
 * committed and pushed to `branch` only while origin still has the branch where the clone found it, so a commit a
 * teammate pushed meanwhile is never replaced. In single-repo mode the team repo is the project's, and the step runs in
 * its `.teamai/`.
 *
 *   <runsDir>/<run>/team/<8 hex of the branch>/    the clone, made again by every prepare, so a crash leaves nothing to resume
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { isPlaceableType } from '../../push-namespaces.js';
import { isSelfMode, LocalConfigSchema, type LocalConfig } from '../../types.js';
import { NON_INTERACTIVE_GIT_ENV } from '../../utils/git-env.js';
import { checkoutCredentials, getConfiguredRemoteUrl, redactGitCredentials } from '../../utils/git.js';
import type { StepChanges } from '../workspace.js';
import { runsDir, type RunId } from '../store.js';
import type { WorkflowFailure } from '../types.js';
import { commitWork, git } from '../worktree.js';

/** How long one git call that reaches origin may take. */
const ORIGIN_TIMEOUT_MS = 120_000;
const ORIGIN = { timeoutMs: ORIGIN_TIMEOUT_MS, env: { ...process.env, ...NON_INTERACTIVE_GIT_ENV } };
const TEAMAI = ['-c', 'user.name=TeamAI', '-c', 'user.email=teamai@localhost'];

/** What the clone started from: origin's default branch and its tip, and the branch tip it found, if origin had one. */
export type TeamStart = { root: string; dir: string; target: string; base: string; start: string; found?: string };

export function teamKeyOf(branch: string): string {
  return `team:${branch}`;
}

/** Where the clones of the team repo `run`'s steps run in live, one per branch. */
export function teamClonesOf(config: LocalConfig, run: string): string {
  return path.join(runsDir(config), run, 'team');
}

function teamRoot(config: LocalConfig, run: RunId, branch: string): string {
  return path.join(teamClonesOf(config, run), createHash('sha256').update(branch).digest('hex').slice(0, 8));
}

/** Removes the clone of `branch` that a step of `run` ran in. */
export async function removeTeamClone(config: LocalConfig, run: RunId, branch: string): Promise<void> {
  await fs.rm(teamRoot(config, run, branch), { recursive: true, force: true });
}

const said = (result: { stderr: string; stdout: string }): string => (result.stderr || result.stdout).trim();

/**
 * Clones the team repo afresh for `step`, on `branch`, from the origin of the member's team checkout and with the
 * credential settings that checkout's config holds, which the clone keeps for its push. A branch that conflicts with
 * the default branch fails as `merge_conflict`, and the step does not run.
 */
export async function openTeamClone(input: { config: LocalConfig; run: RunId; step: string; branch: string }): Promise<TeamStart | WorkflowFailure> {
  const { config, run, step, branch } = input;
  const root = teamRoot(config, run, branch);
  await fs.rm(root, { recursive: true, force: true });
  await fs.mkdir(path.dirname(root), { recursive: true });
  // The checkout's URL, which may carry its credential, as a TGit clone's does; init keeps a GitHub one in its config.
  const remote = await getConfiguredRemoteUrl(config.repo.localPath) ?? config.repo.remote;
  const credentials = await checkoutCredentials(config.repo.localPath);
  const cloned = await git(path.dirname(root), [...credentials.flatMap(([key, value]) => ['-c', `${key}=${value}`]), 'clone', '-q', '--', remote, root], ORIGIN);

  if (cloned.code !== 0) {
    const output = said(cloned).replaceAll(remote, redactGitCredentials(remote));

    return { code: 'workspace_base', message: `Step "${step}" could not clone the team repo ${config.repo.remote}: ${output}. Check this machine's access to it, then run the workflow again.` };
  }

  for (const [key, value] of credentials) await git(root, ['config', '--local', '--add', key, value]);

  const head = await git(root, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
  const target = head.code === 0 ? head.stdout.trim().replace(/^origin\//, '') : '';
  const base = target === '' ? undefined : await git(root, ['rev-parse', '--verify', '-q', `refs/remotes/origin/${target}^{commit}`]);

  if (base?.code !== 0) {
    return { code: 'workspace_base', message: `Step "${step}" found no default branch on the team repo's origin ${config.repo.remote}, so it has nothing to start ${branch} from. Push a default branch there, then run the workflow again.` };
  }

  if (branch === target) {
    return { code: 'workspace_base', message: `Step "${step}" would commit to ${branch}, the team repo's default branch, so its work would skip review. Give workspace team branch another name.` };
  }

  const found = await git(root, ['rev-parse', '--verify', '-q', `refs/remotes/origin/${branch}^{commit}`]);

  const started = found.code === 0
    ? await git(root, ['checkout', '-q', '-B', branch, `refs/remotes/origin/${branch}`])
    : await git(root, ['checkout', '-q', '-b', branch, `refs/remotes/origin/${target}`]);

  if (started.code !== 0) return { code: 'workspace_base', message: `Step "${step}" could not check out ${branch} in the team repo: ${said(started)}` };

  if (found.code === 0) {
    const merged = await git(root, [...TEAMAI, 'merge', '-q', '--no-edit', `refs/remotes/origin/${target}`]);

    if (merged.code !== 0) {
      const unmerged = await git(root, ['diff', '--name-only', '--diff-filter=U']);
      const files = unmerged.stdout.trim().split('\n').filter(Boolean).join(', ');

      return {
        code: 'merge_conflict',
        message: `${branch} conflicts with ${target} on the team repo's origin${files ? ` in ${files}` : ''}, so step "${step}" did not run. Merge ${target} into ${branch} and push it, or delete ${branch} to start over, then run the workflow again.`,
      };
    }
  }

  const start = await git(root, ['rev-parse', 'HEAD']);
  const dir = isSelfMode(config) ? path.join(root, '.teamai') : root;
  await fs.mkdir(dir, { recursive: true });

  return { root, dir, target, base: base.stdout.trim(), start: start.stdout.trim(), found: found.code === 0 ? found.stdout.trim() : undefined };
}

/**
 * The files the commit `to` changes against `base` in the clone at `root` that `teamai pull` would not place, each as
 * `<file>: <why>`: one outside `dir`, outside a directory pull places, a symlink or a submodule, or a benchmark file in
 * no suite.
 */
async function unplacedTeamFiles(input: { root: string; dir: string; base: string; to: string }): Promise<string[]> {
  const { root, dir, base, to } = input;
  const relative = path.relative(root, dir).split(path.sep).join('/');
  const under = relative === '' ? '' : `${relative}/`;
  const changed = await git(root, ['diff', '--no-renames', '--name-only', '-z', base, to, '--']);
  const listed = await git(root, ['ls-tree', '-r', '-z', '--full-tree', to]);
  const modes = new Map<string, string>();

  for (const entry of listed.stdout.split('\0').filter(Boolean)) {
    const tab = entry.indexOf('\t');
    modes.set(entry.slice(tab + 1), entry.slice(0, entry.indexOf(' ')));
  }

  // oxlint-disable-next-line teamai/workflow-boundaries -- a benchmark file goes only into a suite pull reads, which suite discovery owns
  const { suiteDirectories } = await import('../../benchmark/suite-cache.js');
  const suites = await suiteDirectories(LocalConfigSchema.parse({ repo: { localPath: dir, remote: 'local' }, username: 'team-files' }));
  const unplaced: string[] = [];

  for (const file of changed.stdout.split('\0').filter(Boolean)) {
    if (!file.startsWith(under)) {
      unplaced.push(`${file}: outside ${under}, where the team files are`);
      continue;
    }

    const teamPath = file.slice(under.length);
    const [top = '', ...below] = teamPath.split('/');
    const mode = modes.get(file);

    if (!isPlaceableType(top) || below.length === 0) unplaced.push(`${teamPath}: not in a directory teamai pulls, such as skills/, rules/, scorers/ or benchmarks/`);
    else if (mode === '120000') unplaced.push(`${teamPath}: a symlink, which teamai pull does not place`);
    else if (mode === '160000') unplaced.push(`${teamPath}: a submodule, which teamai pull does not place`);
    else if (top === 'benchmarks' && mode !== undefined && !suites.some((suite) => teamPath.startsWith(`${suite}/`))) {
      unplaced.push(`${teamPath}: in no suite teamai pull reads: a suite is benchmarks/<suite>/ or benchmarks/<namespace>/<suite>/ with a suite.yaml`);
    }
  }

  return unplaced;
}

/**
 * What `teamai pull` would reject in the team files at `dir` that it would not reject at `base`, each line starting with
 * its file: what `teamai review-branch` fails for each role, project and member assigned no role. Comparing the two
 * trees catches a deletion that breaks a file the step left alone, as a workflow whose scorer it deleted, without
 * failing the step for what the default branch already had, wherever the step moved it in its file.
 */
async function rejectedTeamFiles(input: { root: string; dir: string; base: string }): Promise<string[]> {
  const { root, dir, base } = input;
  // Inside .git, so the clone's status ignores it and removing the clone removes it.
  const before = path.join(root, '.git', 'teamai-base');
  await fs.rm(before, { recursive: true, force: true });
  await git(root, ['worktree', 'prune']);
  const added = await git(root, ['worktree', 'add', '-q', '--detach', '--', before, base]);

  if (added.code !== 0) return [`(base): could not check out ${base} to compare the team files against: ${said(added)}`];

  try {
    // A failure is the same one wherever its line now is; one more of the same is still new.
    const withoutLine = (failure: string): string => failure.replace(/^([^:\s]+):\d+: /, '$1: ');
    const had = new Map<string, number>();

    for (const failure of await teamFailures(path.join(before, path.relative(root, dir)))) had.set(withoutLine(failure), (had.get(withoutLine(failure)) ?? 0) + 1);

    return (await teamFailures(dir)).filter((failure) => {
      const left = had.get(withoutLine(failure)) ?? 0;
      had.set(withoutLine(failure), left - 1);

      return left <= 0;
    });
  } finally {
    await git(root, ['worktree', 'remove', '--force', '--', before]);
    await fs.rm(before, { recursive: true, force: true });
  }
}

/** What a review of the branch fails in the team files at `dir`, each line starting with its file. */
async function teamFailures(dir: string): Promise<string[]> {
  const { reviewBranchDir } = await import('../../review-branch.js');
  const review = await reviewBranchDir('team workspace', dir);

  return [...new Set(review.findings.flatMap(({ level, path: at, message }) => (level === 'fail' && at !== undefined ? [message.startsWith(at) ? message : `${at}: ${message}`] : [])))];
}

/**
 * Commits what `step` left in the clone at `root`, deletions included, and pushes it to `branch` while origin still has
 * the branch at `found`, or still has none, unless a file it changed is one `teamai pull` would not place or would reject. The
 * changes run from the commit the branch had, so they hold the merge of the default branch too. `dir` is where the
 * team files are: `root`, or its `.teamai/` in single-repo mode.
 */
export async function finishTeamClone(input: { root: string; dir: string; step: string; branch: string; base: string; start: string; found?: string }): Promise<{ changes: StepChanges } | WorkflowFailure> {
  const { root, dir, step, branch, base, found } = input;
  const committed = await commitWork(root, `teamai: ${step}`, input.start);

  if ('error' in committed) return { code: 'push_failed', message: `Step "${step}" could not commit its work in the team repo clone ${root}: ${committed.error}` };
  const from = found ?? base;
  const listed = committed.to === from ? { stdout: '' } : await git(root, ['rev-list', '--reverse', `${from}..${committed.to}`]);
  const changes: StepChanges = { branch, base, from, to: committed.to, commits: listed.stdout.split('\n').map((line) => line.trim()).filter(Boolean) };

  const trees = await git(root, ['rev-parse', `${committed.to}^{tree}`, `${base}^{tree}`]);
  const [tree, baseTree] = trees.stdout.split('\n');

  // The branch holds what the default branch holds, as once its proposal was squash-merged: nothing to push or propose.
  if (trees.code === 0 && tree === baseTree) return { changes: { branch, base, from: base, to: base, commits: [] } };

  // Nothing beyond what origin has: no push, and nothing to deliver unless the branch already holds work.
  if (committed.to === found) return { changes };
  const rejected = [...await unplacedTeamFiles({ root, dir, base, to: committed.to }), ...await rejectedTeamFiles({ root, dir, base })];

  if (rejected.length > 0) {
    return {
      code: 'push_failed',
      message: `Step "${step}" left team files teamai pull would reject, so nothing was pushed to ${branch}:\n${rejected.join('\n')}\nIts commit ${committed.to} stays in ${root}. Have the step fix them, then run the workflow again.`,
    };
  }

  const pushed = await git(root, ['push', '-q', `--force-with-lease=refs/heads/${branch}:${found ?? ''}`, 'origin', `HEAD:refs/heads/${branch}`], ORIGIN);

  if (pushed.code === 0) return { changes };
  const tip = await git(root, ['ls-remote', 'origin', `refs/heads/${branch}`], ORIGIN);
  const now = tip.code === 0 ? tip.stdout.split('\t')[0]?.trim() ?? '' : undefined;

  if (now !== undefined && now !== (found ?? '')) {
    return {
      code: 'push_failed',
      message: `${branch} moved on origin while step "${step}" ran, so nothing was pushed and origin keeps it. The step's commit ${committed.to} stays in ${root}. Run the workflow again to start from the branch as origin has it now.`,
    };
  }

  return { code: 'push_failed', message: `Step "${step}" could not push ${branch} to the team repo's origin: ${said(pushed)}. Its commit ${committed.to} stays in ${root}.` };
}
