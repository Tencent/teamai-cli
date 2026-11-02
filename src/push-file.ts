/**
 * `teamai push --file <local file> --path <team path>`: propose exactly one file, byte for byte, at exactly one team
 * path, as a pull request (#1402). teamai-session-to-task's propose step runs it with the task file its draft wrote.
 *
 *   validate flags and --path      → refuse before touching any repo
 *   fetch origin/<default>         → the base the pull request is built on
 *   tree checks at that base       → no symlink on the way, a benchmark task belongs to a suite, same bytes = no change
 *   blob → temp index → commit     → the base's tree with only the destination changed
 *   push <commit>:<branch> → PR    → push's provider and pull request code
 *
 * The commit is built with git's plumbing in a temporary index, so the clone's files, index and HEAD stay as they
 * were: a pending teamai.yaml or another edited resource in the clone never joins the pull request. In single-repo mode
 * the team root is `.teamai/` of the project repo, and the same commands act on that repo without touching the
 * checkout. No scanner, resource handler, namespace relocation or sweeper runs: the bytes land where `--path` says.
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { autoDetectInit } from './config.js';
import { createPrWithFallback } from './push.js';
import { isPlaceableType } from './push-namespaces.js';
import { assertNotReadOnly } from './read-only.js';
import { getDataHome, SYNC_LOCK_FILENAME, type GlobalOptions } from './types.js';
import { acquireLock, releaseLock } from './update.js';
import { createGit, generateBranchName, getDefaultBranch, isDedicatedRepoRoot } from './utils/git.js';
import { withoutGitRepositoryEnv } from './utils/git-env.js';
import { log, spinner } from './utils/logger.js';
import { assertWithinRoot } from './utils/path-safety.js';

export interface PushFileOptions {
  file?: string;
  path?: string;
  skill?: string;
  role?: string;
  project?: string;
  shared?: boolean;
  branch?: string;
}

/** Whether this push names one file and its destination, with either flag: the route this module owns. */
function isFilePush(options: PushFileOptions): boolean {
  return options.file !== undefined || options.path !== undefined;
}

/** `benchmarks/<suite>/tasks/<task>.yaml` or `benchmarks/<namespace>/<suite>/tasks/<task>.yaml`; group 1 is the suite directory. */
const TASK_PATH = /^(benchmarks\/(?:[A-Za-z0-9][A-Za-z0-9_-]*\/)?[A-Za-z0-9][A-Za-z0-9_-]*)\/tasks\/[A-Za-z0-9][A-Za-z0-9_-]*\.yaml$/;

/** Why `--path` names no place a team file can go, or undefined when it names one. Read without any repo. */
function pathRefusal(teamPath: string): string | undefined {
  const segments = teamPath.split('/');
  if (teamPath.includes('\\') || path.posix.isAbsolute(teamPath) || segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    return `${teamPath} is not a path inside the team repo. Give a relative path with "/" between its parts, such as benchmarks/frontend/tasks/pod-startup.yaml.`;
  }
  const [root] = segments;
  if (root === undefined || !isPlaceableType(root) || segments.length < 2) {
    return `${teamPath} is not under a team resource directory. Give a path under skills/, rules/, scorers/, benchmarks/ or another directory teamai pulls.`;
  }
  if (root === 'benchmarks' && !TASK_PATH.test(teamPath)) {
    return `${teamPath} is not a benchmark task path. A task goes in benchmarks/<suite>/tasks/<task>.yaml or benchmarks/<namespace>/<suite>/tasks/<task>.yaml.`;
  }
  return undefined;
}

/** A refusal: printed, with exit code 2 for a usage error and 1 otherwise. */
function refuse(message: string, code: 1 | 2 = 1): void {
  log.error(message);
  process.exitCode = code;
}

/**
 * The route `push` takes for `--file` and `--path`: true when it handled the command, whatever the outcome, and false
 * when neither flag is set, so `push` goes on with its scan.
 */
export async function pushFile(options: GlobalOptions & PushFileOptions, result?: { completed: boolean }): Promise<boolean> {
  if (!isFilePush(options)) return false;
  if (options.file === undefined || options.path === undefined) {
    refuse('--file and --path go together: --file names the local file, --path where it goes in the team repo.', 2);
    return true;
  }
  if (options.skill !== undefined || options.role !== undefined || options.project !== undefined || options.shared) {
    refuse('--path names the destination, so it cannot be combined with --skill, --role, --project or --shared.', 2);
    return true;
  }
  const teamPath = options.path;
  const refusal = pathRefusal(teamPath);
  if (refusal !== undefined) {
    refuse(refusal, 2);
    return true;
  }
  const source = path.resolve(options.file);
  const stat = await fs.stat(source).catch(() => undefined);
  if (!stat?.isFile()) {
    refuse(`${options.file} is not a file. Give the local file to push with --file.`, 2);
    return true;
  }
  const { localConfig, teamConfig } = await autoDetectInit(undefined, { dryRun: options.dryRun });
  assertNotReadOnly(localConfig, 'teamai push');
  const teamRoot = localConfig.repo.localPath;
  try {
    assertWithinRoot(teamRoot, path.join(teamRoot, ...teamPath.split('/')));
  } catch {
    refuse(`${teamPath} is not a path inside the team repo.`, 2);
    return true;
  }
  if (localConfig.repo.kind !== 'self' && !(await isDedicatedRepoRoot(teamRoot))) {
    refuse('Cannot push: team repo path is not a dedicated git root. Run `teamai init` to re-clone the team repo before pushing.');
    return true;
  }
  const lock = path.join(getDataHome(localConfig), SYNC_LOCK_FILENAME);
  if (!(await acquireLock(lock, { dryRun: options.dryRun }))) {
    refuse('Another teamai pull/push is in progress for this project. Re-run once it finishes.');
    return true;
  }
  try {
    await proposeFile({ source, teamPath, teamRoot, branch: options.branch, dryRun: options.dryRun === true, username: localConfig.username }, async (branch, title) => {
      const prUrl = await createPrWithFallback(teamConfig, localConfig, branch, title, `Adds ${teamPath} exactly as given, with teamai push --file --path.`);
      if (prUrl === null) process.exitCode = 1;
      else if (result) result.completed = true;
    });
  } finally {
    await releaseLock(lock);
  }
  return true;
}

/**
 * Builds and pushes the commit that changes only `teamPath` against the team repo's default branch on its remote, then
 * opens the pull request with `openPr`. Refuses a path that goes through a symlink or names a directory at that base,
 * and a benchmark task whose suite has no suite.yaml there.
 */
async function proposeFile(
  { source, teamPath, teamRoot, branch: requested, dryRun, username }: { source: string; teamPath: string; teamRoot: string; branch?: string; dryRun: boolean; username: string },
  openPr: (branch: string, title: string) => Promise<void>,
): Promise<void> {
  // In single-repo mode the team root is .teamai/ of the project repo, so a team path sits under that prefix in its
  // tree. Every command runs at the top level, where git reads a path as one from the root of the tree.
  const prefix = (await createGit(teamRoot).revparse(['--show-prefix'])).trim();
  const top = (await createGit(teamRoot).revparse(['--show-toplevel'])).trim();
  const git = createGit(top);
  const defaultBranch = await getDefaultBranch(teamRoot);
  const spin = (await spinner(`Fetching ${defaultBranch}...`)).start();
  try {
    await git.fetch(['origin', defaultBranch]);
    spin.succeed(`Up to date with origin/${defaultBranch}`);
  } catch (error) {
    spin.fail(`Could not fetch ${defaultBranch}: ${(error as Error).message}`);
    process.exitCode = 1;
    return;
  }
  const base = (await git.revparse([`refs/remotes/origin/${defaultBranch}`])).trim();
  const destination = `${prefix}${teamPath}`;
  const entryAt = async (at: string): Promise<{ mode: string; type: string; object: string } | undefined> => {
    const [mode, type, object] = (await git.raw(['ls-tree', base, '--', at])).trim().split(/\s+/);
    return mode !== undefined && type !== undefined && object !== undefined ? { mode, type, object } : undefined;
  };
  const segments = teamPath.split('/');
  for (let depth = 1; depth < segments.length; depth += 1) {
    const at = `${prefix}${segments.slice(0, depth).join('/')}`;
    if ((await entryAt(at))?.mode === '120000') {
      refuse(`${teamPath} goes through the symlink ${segments.slice(0, depth).join('/')} in the team repo, so it is not pushed. Give a path whose directories are real directories.`, 2);
      return;
    }
  }
  const existing = await entryAt(destination);
  if (existing !== undefined && existing.type !== 'blob') {
    refuse(`${teamPath} is a directory in the team repo. Give the path of a file.`, 2);
    return;
  }
  if (existing?.mode === '120000') {
    refuse(`${teamPath} is a symlink in the team repo, so it is not pushed. Give the path of a regular file.`, 2);
    return;
  }
  const suiteDir = /^(.+)\/tasks\/[^/]+$/.exec(teamPath)?.[1];
  if (teamPath.startsWith('benchmarks/') && suiteDir !== undefined && (await entryAt(`${prefix}${suiteDir}/suite.yaml`))?.type !== 'blob') {
    refuse(`${suiteDir}/suite.yaml does not exist, so ${teamPath} belongs to no suite. Pick a suite the team repo has under benchmarks/.`);
    return;
  }
  const blob = (await git.raw(['hash-object', '-w', '--no-filters', '--', source])).trim();
  if (existing?.object === blob) {
    log.info(`No changes to push: ${teamPath} already holds these bytes on ${defaultBranch}.`);
    return;
  }
  const title = `[teamai] ${existing ? 'Update' : 'Add'} ${teamPath} from ${username}`;
  if (dryRun) {
    log.info(`Would propose ${source} as ${teamPath}.`);
    log.info('Dry run — no changes made');
    return;
  }
  const index = await fs.mkdtemp(path.join(os.tmpdir(), 'teamai-push-file-'));
  try {
    const env = { ...withoutGitRepositoryEnv(), GIT_INDEX_FILE: path.join(index, 'index') };
    const indexed = (args: string[]): Promise<string> => new Promise((resolve, reject) => {
      execFile('git', args, { cwd: top, env }, (error, stdout) => (error ? reject(error) : resolve(stdout.trim())));
    });
    await indexed(['read-tree', base]);
    await indexed(['update-index', '--add', '--cacheinfo', `${existing?.mode ?? '100644'},${blob},${destination}`]);
    const tree = await indexed(['write-tree']);
    const commit = (await git.raw(['commit-tree', tree, '-p', base, '-m', title])).trim();
    const branch = requested ?? generateBranchName(username);
    const pushSpin = (await spinner(`Pushing ${teamPath}...`)).start();
    try {
      await git.push(['origin', `${commit}:refs/heads/${branch}`]);
      pushSpin.succeed(`Pushed branch ${branch}`);
    } catch (error) {
      pushSpin.fail(`Push failed: ${(error as Error).message}`);
      process.exitCode = 1;
      return;
    }
    await openPr(branch, title);
  } finally {
    await fs.rm(index, { recursive: true, force: true });
  }
}
