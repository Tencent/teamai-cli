/**
 * `teamai push --file <local file> --path <team path>`: propose exactly one file, byte for byte, at exactly one team
 * path, as a pull request (#1402). teamai-session-to-task's propose step runs it with the task file its draft wrote.
 *
 *   parse flags and --path         → refuse before touching any repo
 *   fetch origin/<default>         → the base the pull request is built on
 *   placementAt that base          → no symlink on the way, a benchmark task belongs to a suite; same bytes = no change
 *   blob → temp index → commit     → the base's tree with only the destination changed
 *   push <commit>:<branch>         → a new branch, or the --branch of an open pull request, force-pushed with a lease;
 *                                    any other branch origin has is refused
 *   open or update the PR          → push's pull request code; an open one of that branch is updated in place
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
import { BENCHMARK_NAME } from './benchmark/terms.js';
import { autoDetectInit } from './config.js';
import { providerForRemote } from './providers/registry.js';
import { createPrWithFallback } from './push.js';
import { isPlaceableType } from './push-namespaces.js';
import { assertNotReadOnly } from './read-only.js';
import { getDataHome, SYNC_LOCK_FILENAME, type GlobalOptions } from './types.js';
import { acquireLock, releaseLock } from './update.js';
import { createGit, generateBranchName, getConfiguredRemoteUrl, getDefaultBranch, isDedicatedRepoRoot } from './utils/git.js';
import { withoutGitRepositoryEnv } from './utils/git-env.js';
import { log, spinner } from './utils/logger.js';

export interface PushFileOptions {
  file?: string;
  path?: string;
  skill?: string;
  role?: string;
  project?: string;
  shared?: boolean;
  all?: boolean;
  carried?: string[];
  branch?: string;
}

/** Whether a push names one file or its destination: the route this module owns, not push's scan. */
export function isFilePush(options: PushFileOptions): boolean {
  return options.file !== undefined || options.path !== undefined;
}

/** A team path `--path` names, and for a benchmark task, the directory of its suite. */
interface Destination {
  teamPath: string;
  suiteDir?: string;
}

const NAME = BENCHMARK_NAME.source.slice(1, -1);

/** `benchmarks/<suite>/tasks/<task>.yaml` or `benchmarks/<namespace>/<suite>/tasks/<task>.yaml`; group 1 is the suite directory. */
const TASK_PATH = new RegExp(`^(benchmarks/(?:${NAME}/)?${NAME})/tasks/${NAME}\\.yaml$`);

/** `--path` as a destination, or why it names no place a team file can go. Read without any repo. */
function destinationOf(teamPath: string): Destination | { refusal: string } {
  const segments = teamPath.split('/');

  if (teamPath.includes('\\') || path.posix.isAbsolute(teamPath) || segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    return { refusal: `${teamPath} is not a path inside the team repo. Give a relative path with "/" between its parts, such as benchmarks/frontend/tasks/pod-startup.yaml.` };
  }

  const [root] = segments;

  if (root === undefined || !isPlaceableType(root) || segments.length < 2) {
    return { refusal: `${teamPath} is not under a team resource directory. Give a path under skills/, rules/, scorers/, benchmarks/ or another directory teamai pulls.` };
  }

  if (root !== 'benchmarks') return { teamPath };
  const suiteDir = TASK_PATH.exec(teamPath)?.[1];

  if (suiteDir === undefined) {
    return { refusal: `${teamPath} is not a benchmark task path. A task goes in benchmarks/<suite>/tasks/<task>.yaml or benchmarks/<namespace>/<suite>/tasks/<task>.yaml.` };
  }

  return { teamPath, suiteDir };
}

/** A refusal: printed, with exit code 2 for a usage error and 1 otherwise. */
function refuse(message: string, code: 1 | 2 = 1): void {
  log.error(message);
  process.exitCode = code;
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** What a push of one file reached: the branch it pushed and the title of its request, and the request it updated, when one was open. */
type Pushed = { kind: 'pushed'; branch: string; title: string; updated?: string } | { kind: 'stopped' };

/** The route `push` takes for `--file` and `--path`. `result.completed` is set once a pull request is open or updated. */
export async function pushFile(options: GlobalOptions & PushFileOptions, result?: { completed: boolean }): Promise<void> {
  if (options.file === undefined || options.path === undefined) {
    refuse('--file and --path go together: --file names the local file, --path where it goes in the team repo.', 2);

    return;
  }

  if (options.skill !== undefined || options.role !== undefined || options.project !== undefined || options.shared || options.all || (options.carried ?? []).length > 0) {
    refuse('--path names the destination, so it cannot be combined with --skill, --role, --project, --shared, --all or --carried.', 2);

    return;
  }

  const destination = destinationOf(options.path);

  if ('refusal' in destination) {
    refuse(destination.refusal, 2);

    return;
  }

  const source = path.resolve(options.file);
  const stat = await fs.stat(source).catch(() => undefined);

  if (!stat?.isFile()) {
    refuse(`${options.file} is not a file. Give the local file to push with --file.`, 2);

    return;
  }

  const { localConfig, teamConfig } = await autoDetectInit(undefined, { dryRun: options.dryRun });
  assertNotReadOnly(localConfig, 'teamai push');
  const teamRoot = localConfig.repo.localPath;

  if (localConfig.repo.kind !== 'self' && !(await isDedicatedRepoRoot(teamRoot))) {
    refuse('Cannot push: team repo path is not a dedicated git root. Run `teamai init` to re-clone the team repo before pushing.');

    return;
  }

  const lock = path.join(getDataHome(localConfig), SYNC_LOCK_FILENAME);

  if (!(await acquireLock(lock, { dryRun: options.dryRun }))) {
    refuse('Another teamai pull/push is in progress for this project. Re-run once it finishes.');

    return;
  }

  try {
    const pushed = await proposeFile({ source, isExecutable: (stat.mode & 0o111) !== 0, destination, teamRoot, branch: options.branch, dryRun: options.dryRun === true, username: localConfig.username });

    if (pushed.kind === 'stopped') return;

    if (pushed.updated !== undefined) {
      log.success(`Updated pull request ${pushed.updated}`);

      if (result) result.completed = true;

      return;
    }

    const prUrl = await createPrWithFallback(teamConfig, localConfig, pushed.branch, pushed.title, `Adds ${destination.teamPath} exactly as given, with teamai push --file --path.`);

    if (prUrl === null) process.exitCode = 1;
    else if (result) result.completed = true;
  } finally {
    await releaseLock(lock);
  }
}

/**
 * Builds and pushes the commit that changes only the destination against the team repo's default branch on its remote,
 * once `placementAt` accepts the destination in that branch's tree. A `branch` that origin already has is rebuilt only
 * when it has an open pull request, force-pushed with a lease on the tip it had, so that request shows the new file. A new
 * file is executable when the local file is.
 */
async function proposeFile({ source, isExecutable, destination, teamRoot, branch: requested, dryRun, username }: {
  source: string; isExecutable: boolean; destination: Destination; teamRoot: string; branch?: string; dryRun: boolean; username: string;
}): Promise<Pushed> {
  const { teamPath } = destination;
  // In single-repo mode the team root is .teamai/ of the project repo, so a team path sits under that prefix in its
  // tree. Every command runs at the top level, where git reads a path as one from the root of the tree.
  const prefix = (await createGit(teamRoot).revparse(['--show-prefix'])).trim();
  const top = (await createGit(teamRoot).revparse(['--show-toplevel'])).trim();
  const git = createGit(top);
  const defaultBranch = await getDefaultBranch(teamRoot);

  if (requested === defaultBranch) {
    refuse(`--branch ${defaultBranch} is the team repo's default branch, so the file would skip review. Name the pull request's branch, or leave --branch out.`, 2);

    return { kind: 'stopped' };
  }

  const spin = (await spinner(`Fetching ${defaultBranch}...`)).start();

  try {
    await git.fetch(['origin', defaultBranch]);
    spin.succeed(`Up to date with origin/${defaultBranch}`);
  } catch (error) {
    spin.fail(`Could not fetch ${defaultBranch}: ${messageOf(error)}`);
    process.exitCode = 1;

    return { kind: 'stopped' };
  }

  const base = (await git.revparse([`refs/remotes/origin/${defaultBranch}`])).trim();
  const placement = await placementAt(git, { base, prefix, destination });

  if (placement.kind === 'refused') {
    refuse(placement.message, placement.code);

    return { kind: 'stopped' };
  }

  const { existing } = placement;
  // A dry run hashes without writing the object.
  const blob = (await git.raw(['hash-object', '--no-filters', ...(dryRun ? [] : ['-w']), '--', source])).trim();

  if (existing?.object === blob) {
    log.info(`No changes to push: ${teamPath} already holds these bytes on ${defaultBranch}.`);

    return { kind: 'stopped' };
  }

  if (dryRun) {
    log.info(`Would propose ${source} as ${teamPath}.`);
    log.info('Dry run — no changes made');

    return { kind: 'stopped' };
  }

  const title = `[teamai] ${existing ? 'Update' : 'Add'} ${teamPath} from ${username}`;
  const branch = requested ?? generateBranchName(username);
  // Rebuilding a branch replaces its commits, so only the branch of an open pull request is rebuilt: that request is
  // what the rebuild updates. When the host cannot say, the branch is left alone too.
  const [tip] = (await git.raw(['ls-remote', 'origin', `refs/heads/${branch}`])).trim().split(/\s+/);
  const updated = tip ? await openRequestOf(top, { branch, target: defaultBranch }) : undefined;

  if (tip && updated === undefined) {
    refuse(`--branch ${branch} already exists on origin and teamai found no open pull request of it, so it is not rebuilt. Name a new branch, or the branch of your open pull request.`, 2);

    return { kind: 'stopped' };
  }

  const index = await fs.mkdtemp(path.join(os.tmpdir(), 'teamai-push-file-'));

  try {
    const env = { ...withoutGitRepositoryEnv(), GIT_INDEX_FILE: path.join(index, 'index') };

    const indexed = (args: string[]): Promise<string> => new Promise((resolve, reject) => {
      execFile('git', args, { cwd: top, env }, (error, stdout) => (error ? reject(error) : resolve(stdout.trim())));
    });

    await indexed(['read-tree', base]);
    await indexed(['update-index', '--add', '--cacheinfo', `${existing?.mode ?? (isExecutable ? '100755' : '100644')},${blob},${prefix}${teamPath}`]);
    const commit = (await git.raw(['commit-tree', await indexed(['write-tree']), '-p', base, '-m', title])).trim();
    const pushSpin = (await spinner(`Pushing ${teamPath}...`)).start();

    try {
      const lease = tip ? [`--force-with-lease=refs/heads/${branch}:${tip}`] : [];
      await git.push([...lease, 'origin', `${commit}:refs/heads/${branch}`]);
      pushSpin.succeed(`Pushed branch ${branch}`);

      return { kind: 'pushed', branch, title, updated };
    } catch (error) {
      pushSpin.fail(`Push failed: ${messageOf(error)}`);
      process.exitCode = 1;

      return { kind: 'stopped' };
    }
  } finally {
    await fs.rm(index, { recursive: true, force: true });
  }
}

/** A tree entry, as `git ls-tree` prints it. */
interface TreeEntry {
  mode: string;
  type: string;
  object: string;
}

/** Whether the destination can take the file in the tree of `base`, and the entry it replaces, when there is one. */
type Placement = { kind: 'placeable'; existing?: TreeEntry } | { kind: 'refused'; message: string; code: 1 | 2 };

/**
 * Checks the destination against the tree of `base`, whose paths sit under `prefix`: refuses a path that goes through a
 * symlink or a file, or names no regular file, and a benchmark task whose suite has no suite.yaml. Every check that needs the team
 * repo's tree lives here; `destinationOf` holds the ones that need no repo.
 */
async function placementAt(git: ReturnType<typeof createGit>, { base, prefix, destination: { teamPath, suiteDir } }: { base: string; prefix: string; destination: Destination }): Promise<Placement> {
  const entryAt = async (at: string): Promise<TreeEntry | undefined> => {
    const [mode, type, object] = (await git.raw(['ls-tree', base, '--', `${prefix}${at}`])).trim().split(/\s+/);

    return mode !== undefined && type !== undefined && object !== undefined ? { mode, type, object } : undefined;
  };

  const segments = teamPath.split('/');

  for (let depth = 1; depth < segments.length; depth += 1) {
    const directory = segments.slice(0, depth).join('/');
    const entry = await entryAt(directory);

    if (entry?.mode === '120000') {
      return { kind: 'refused', message: `${teamPath} goes through the symlink ${directory} in the team repo, so it is not pushed. Give a path whose directories are real directories.`, code: 2 };
    }

    if (entry !== undefined && entry.type !== 'tree') {
      return { kind: 'refused', message: `${teamPath} goes through the file ${directory} in the team repo, so it is not pushed. Give a path whose directories are real directories.`, code: 2 };
    }
  }

  const existing = await entryAt(teamPath);

  if (existing !== undefined && (existing.type !== 'blob' || existing.mode === '120000')) {
    return { kind: 'refused', message: `${teamPath} is not a regular file in the team repo, so it is not pushed. Give the path of a file.`, code: 2 };
  }

  if (suiteDir !== undefined && (await entryAt(`${suiteDir}/suite.yaml`))?.type !== 'blob') {
    return { kind: 'refused', message: `${suiteDir}/suite.yaml does not exist, so ${teamPath} belongs to no suite. Pick a suite the team repo has under benchmarks/.`, code: 1 };
  }

  return existing !== undefined ? { kind: 'placeable', existing } : { kind: 'placeable' };
}

/** How long the host may take to say which pull request of a branch is open. */
const LOOKUP_TIMEOUT_MS = 30_000;

/** The open pull request of `branch` into `target` on the origin of the repo at `top`, or undefined when there is none or the host cannot say. */
async function openRequestOf(top: string, { branch, target }: { branch: string; target: string }): Promise<string | undefined> {
  const origin = providerForRemote(await getConfiguredRemoteUrl(top) ?? '');

  if (origin.kind !== 'provider') return undefined;

  return origin.pullRequests.findOpen({ repo: origin.repo, source: branch, target, timeoutMs: LOOKUP_TIMEOUT_MS }).catch(() => undefined);
}
