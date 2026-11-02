/**
 * Running a check in a clone the agent's work never touched: `runCheckAt` checks one commit with no run, for
 * `teamai benchmark try` and a scorer's check (#1247). `restoreProtected` puts the protected paths back as the starting
 * commit has them, and `writeAdded` writes the files check.add names; a benchmark's check step calls both in the clone its
 * place prepared.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { stepEnvironment } from '../env-exec.js';
import type { WorkflowEnv } from '../env-resolution.js';
import { checkVerdict, type Added, type CheckVerdict } from './check.js';
import { freshClone, scratchCloneRoot } from './place/place.js';
import { runSetup } from './place/setup.js';
import { SANDBOX_WITHHELD_ENV, type EnvScope, type LeaseSetup, type Setup } from './requirements.js';
import { runShellCommand } from './shell-command.js';
import type { WorkflowFailure } from './types.js';
import { untrustedGit, type Git } from './worktree.js';

/** Setup with only its own keys, as the lease scopes them. */
async function setupIn(trial: Runner, dir: string, setup: LeaseSetup, expiresAt: string | undefined): Promise<WorkflowFailure | undefined> {
  const scope = setup.envScope ?? NO_ENV;
  const scoped = await stepEnvironment(trial.env, scope);

  if (!scoped.ok) return scoped.failure;

  return runSetup({ command: setup.command, dir, env: scoped.env, keys: scope.provide, signal: trial.signal, expiresAt });
}

/** How a check went: its verdict, or why it never ran. */
export type CheckRun =
  | { kind: 'check'; verdict: CheckVerdict }
  | { kind: 'error'; failure: WorkflowFailure };

/** What running setup or a check reads of a call: the env values it gives and the signal that stops it. */
type Runner = { env: Pick<WorkflowEnv, 'values' | 'facts'>; signal: AbortSignal | undefined };

/**
 * `prepare`, then the check command in the clone it answers, with the lease's env, bounded by the run's deadline.
 * `prepare` gets that env too, which is all the agent's code gets once the check runs it. A caller tells a stopped call from its verdict by
 * its signal.
 */
async function checkIn(trial: Runner, lease: { command: string; envScope: EnvScope; expiresAt: string | undefined }, prepare: (env: NodeJS.ProcessEnv) => Promise<{ dir: string } | { failure: WorkflowFailure }>): Promise<CheckRun> {
  const scoped = await stepEnvironment(trial.env, lease.envScope);

  if (!scoped.ok) return { kind: 'error', failure: scoped.failure };
  const prepared = await prepare(scoped.env);

  if ('failure' in prepared) return { kind: 'error', failure: prepared.failure };

  const { exit } = await runShellCommand({
    command: lease.command, cwd: prepared.dir, env: scoped.env, signal: trial.signal, expiresAt: lease.expiresAt,
  });

  return { kind: 'check', verdict: checkVerdict(exit, process.platform) };
}

/**
 * One check at `commit` with no run: `teamai benchmark try` runs a task's, and a scorer runs its own on a delivered commit.
 * A fresh clone of `commit` from the first of `sources` that has it, then setup. With `protect`, `restoreProtected` then
 * puts those paths back as `startingCommit` has them; without it, a baseline's, nothing is put back. Then the files `add`
 * names are written, and the check runs. Setup, the tool's strip list and `expiresAt` apply as they do to a trial. The
 * clone is removed.
 */
export async function runCheckAt(input: {
  commit: string; startingCommit: string; command: string; protect?: readonly string[]; add?: readonly Added[]; setup?: Setup;
  sources: readonly string[]; expiresAt: string; signal?: AbortSignal;
}): Promise<CheckRun> {
  const { commit, startingCommit, protect, add, setup, sources, expiresAt } = input;
  const values = new Map(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  const runner: Runner = { env: { values, facts: { declared: new Set(), secrets: new Set(), present: new Set(values.keys()) } }, signal: input.signal };
  const withhold = [...SANDBOX_WITHHELD_ENV];
  const leaseSetup = setup ? { command: setup.command, envScope: { provide: setup.requires?.env ?? [], withhold } } : undefined;
  const root = scratchCloneRoot();
  const clone = path.join(root, 'r');

  try {
    return await checkIn(runner, { command: input.command, envScope: { provide: [], withhold }, expiresAt }, async (env) => {
      const failure = await freshClone(root, commit, sources, expiresAt, env)
        ?? (leaseSetup ? await setupIn(runner, clone, leaseSetup, expiresAt) : undefined)
        ?? (protect ? await restoreProtected({ clone, startingCommit, protect, sources, env, expiresAt }) : undefined)
        ?? (add ? await writeAdded({ clone, add, sources, env, expiresAt }) : undefined);

      return failure ? { failure } : { dir: clone };
    });
  } finally {
    await fs.rm(root, { recursive: true, force: true, maxRetries: 3 });
  }
}

/**
 * Puts every protected path back as `startingCommit` has it, so the check reads only the agent's product code: tracked
 * files the agent edited, deleted or added, commits included, then untracked and ignored files it left there, and git
 * repositories it made there. Each path in `protect` is a glob pathspec, one argv element each: no shell string. A file
 * setup wrote under a protected path goes too. The commit is read from the first of `sources` that has it, where the
 * agent never ran, into an index of its own, so no index flag, filter, replacement or object the agent left in the clone
 * decides what is put back. Then every protected file on disk must be that commit's, byte for byte, of the same kind and
 * executable bit, with nothing else there. A path that reaches into a submodule is refused: git puts none of its files
 * back. Git gets `env`, starts nothing the clone configures, and is stopped at `expiresAt`. Undefined once restored.
 */
export async function restoreProtected({ clone, startingCommit, protect, sources, env, expiresAt }: {
  clone: string; startingCommit: string; protect: readonly string[]; sources: readonly string[]; env: NodeJS.ProcessEnv; expiresAt?: string | undefined;
}): Promise<WorkflowFailure | undefined> {
  const specs = protect.map((entry) => `:(glob)${entry}`);
  const failed = (step: string, stderr: string): WorkflowFailure => ({ code: 'trial_prepare_failed', message: `The protected paths of the clone in ${clone} could not be put back as ${startingCommit} has them (git ${step}): ${stderr.trim()}` });
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'teamai-protect-'));
  // A source's own hooks stay off too: writing an index starts its post-index-change hook.
  const starting = untrustedGit({ ...env, GIT_INDEX_FILE: path.join(dir, 'index') }, expiresAt);

  try {
    const read = await readStarting(starting, sources, startingCommit);

    if ('stderr' in read) return failed('read-tree', read.stderr);
    // Git puts back none of the files inside a submodule, so a protected path that reaches into one is refused.
    const all = await starting(read.source, ['ls-files', '-s', '-z']);

    if (all.code !== 0) return failed('ls-files', all.stderr);
    const gitlinks = all.stdout.split('\0').filter((line) => line.startsWith('160000 ')).map((line) => line.slice(line.indexOf('\t') + 1));

    for (const entry of protect) {
      const gitlink = gitlinks.find((link) => reachesInto(entry, link));

      if (gitlink !== undefined) return { code: 'trial_prepare_failed', message: `Protected path "${entry}" reaches into submodule ${gitlink}, whose files teamai cannot put back as ${startingCommit} has them. List paths outside submodules in protect, or judge the task by successCriteria.` };
    }

    const listed = await stagedEntries(starting, read.source, specs);

    if ('stderr' in listed) return failed('ls-files', listed.stderr);
    const { entries } = listed;
    // The second -f also removes a git repository the agent made there, which git clean otherwise keeps.
    const cleaned = await starting(clone, ['clean', '-f', '-f', '-d', '-x', '-q', '--', ...specs]);

    if (cleaned.code !== 0) return failed('clean', cleaned.stderr);

    if (entries.length > 0) {
      // Bytes as the commit stores them, whatever this machine's line-ending settings would write.
      const restored = await starting(clone, ['-c', 'core.autocrlf=false', '-c', 'core.eol=lf', 'checkout-index', '-f', '-z', '--stdin'], { input: entries.map((entry) => `${entry.path}\0`).join('') });

      if (restored.code !== 0) return failed('checkout-index', restored.stderr);
    }

    // The clone's own index agrees, for a check that runs git.
    const cloneGit = untrustedGit(env, expiresAt);
    const dropped = await cloneGit(clone, ['rm', '--cached', '-r', '-f', '-q', '--ignore-unmatch', '--', ...specs]);

    if (dropped.code !== 0) return failed('rm', dropped.stderr);

    if (entries.length > 0) {
      const staged = await cloneGit(clone, ['update-index', '-z', '--index-info'], { input: entries.map((entry) => `${entry.mode} ${entry.oid}\t${entry.path}\0`).join('') });

      if (staged.code !== 0) return failed('update-index', staged.stderr);
    }

    // A filter the agent configured ran while the files were written, and could have changed the index they came from.
    const reread = await readStarting(starting, sources, startingCommit);

    if ('stderr' in reread) return failed('read-tree', reread.stderr);
    const added = await starting(clone, ['ls-files', '--others', '-z', '--', ...specs]);

    if (added.code !== 0) return failed('ls-files', added.stderr);
    const differing: string[] = [];

    for (const entry of entries) if (!await holds(clone, entry)) differing.push(entry.path);
    const left = [...differing, ...added.stdout.split('\0').filter((entry) => entry !== '')];

    return left.length === 0
      ? undefined
      : { code: 'trial_prepare_failed', message: `The protected paths of the clone in ${clone} still differ from ${startingCommit} after they were put back: ${left.join(', ')}` };
  } finally {
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 3 });
  }
}

/**
 * Whether glob pathspec `spec` can name submodule `gitlink` or a path inside it. A segment with a character class
 * counts as matching, so a doubtful spec is refused rather than missed.
 */
function reachesInto(spec: string, gitlink: string): boolean {
  const names = gitlink.split('/');

  for (const [at, part] of spec.split('/').entries()) {
    const name = names[at];

    if (name === undefined || part === '**') return true;

    if (part.includes('[')) continue;
    const pattern = part.replace(/[.+^${}()|\\\]]/g, (char) => `\\${char}`).replace(/\*/g, '[^/]*').replace(/\?/g, '.');

    if (!new RegExp(`^${pattern}$`).test(name)) return false;
  }

  return true;
}

/** A protected path of the starting commit: the mode and object git checks out there. */
interface StartingEntry {
  mode: string;
  oid: string;
  path: string;
}

/** `<mode> <object> <stage>\t<path>`, one entry of `git ls-files -s -z`. */
const STAGED_ENTRY = /^(\d{6}) ([0-9a-f]+) \d\t([\s\S]+)$/;

/** The entries of the index `git` writes that `specs` name, read in `cwd`. */
async function stagedEntries(git: Git, cwd: string, specs: readonly string[]): Promise<{ entries: StartingEntry[] } | { stderr: string }> {
  const listed = await git(cwd, ['ls-files', '-s', '-z', '--', ...specs]);

  if (listed.code !== 0) return { stderr: listed.stderr };
  const entries: StartingEntry[] = [];

  for (const line of listed.stdout.split('\0').filter((entry) => entry !== '')) {
    const [, mode, oid, file] = STAGED_ENTRY.exec(line) ?? [];

    if (mode === undefined || oid === undefined || file === undefined) return { stderr: `unreadable entry ${line}` };
    entries.push({ mode, oid, path: file });
  }

  return { entries };
}

/**
 * Writes the files each entry of `add` names into `clone` as its commit has them, whether or not the clone has them, so
 * the check reads the solution's test, or the suite's, and the agent never did. Each must be a file at that commit. The
 * commit is read from the first of `sources` that has it into an index of its own, and its files are written from that
 * source's objects, so nothing the clone holds decides what is written. Then each must hold that commit's bytes, as
 * `restoreProtected` checks its own, git stopped at `expiresAt` as there. Undefined once every entry is written.
 */
export async function writeAdded({ clone, add, sources, env, expiresAt }: {
  clone: string; add: readonly Added[]; sources: readonly string[]; env: NodeJS.ProcessEnv; expiresAt?: string | undefined;
}): Promise<WorkflowFailure | undefined> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'teamai-add-'));
  const fixed = untrustedGit({ ...env, GIT_INDEX_FILE: path.join(dir, 'index') }, expiresAt);

  try {
    for (const { kind, commit, paths } of add) {
      const failed = (message: string): WorkflowFailure => ({ code: 'trial_prepare_failed', message: `The files check.add names could not be written into the clone in ${clone} as ${commit} has them: ${message}` });
      const read = await readStarting(fixed, sources, commit);

      if ('stderr' in read) return failed(`git read-tree: ${read.stderr.trim()}`);
      const listed = await stagedEntries(fixed, read.source, paths.map((entry) => `:(literal)${entry}`));

      if ('stderr' in listed) return failed(`git ls-files: ${listed.stderr.trim()}`);
      // A literal pathspec also names what is under a directory, and a submodule has no bytes to write: only files count.
      const entries = listed.entries.filter((entry) => entry.mode !== '160000' && paths.includes(entry.path));
      const missing = paths.find((entry) => !entries.some((staged) => staged.path === entry));

      if (missing !== undefined) {
        return {
          code: 'trial_prepare_failed',
          message: kind === 'solution'
            ? `check.add path ${missing} is not a file at the solutionCommit ${commit}. List files the solution has in check.add, or fix solutionCommit.`
            : `check.add path ${missing} is not a file at ${commit}, the commit start made of the suite directory's files. Start a new run, which commits them again.`,
        };
      }

      // Bytes as the commit stores them, whatever this machine's line-ending settings would write.
      const written = await fixed(read.source, ['-c', 'core.autocrlf=false', '-c', 'core.eol=lf', `--work-tree=${clone}`, 'checkout-index', '-f', '-z', '--stdin'], { input: entries.map((entry) => `${entry.path}\0`).join('') });

      if (written.code !== 0) return failed(`git checkout-index: ${written.stderr.trim()}`);
      const differing: string[] = [];

      for (const entry of entries) if (!await holds(clone, entry)) differing.push(entry.path);

      if (differing.length > 0) return failed(`${differing.join(', ')} still differ from it after they were written.`);
    }

    return undefined;
  } finally {
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 3 });
  }
}

/** Reads `commit` into the index `git` writes, from the first of `sources` that has it, and answers that source. */
async function readStarting(git: Git, sources: readonly string[], commit: string): Promise<{ source: string } | { stderr: string }> {
  const said: string[] = [];

  for (const source of sources) {
    const read = await git(source, ['read-tree', commit]);

    if (read.code === 0) return { source };
    said.push(`${source}: ${read.stderr.trim()}`);
  }

  return { stderr: said.join('; ') || 'no checkout to read it from' };
}

/**
 * Whether what is at `entry.path` in `clone` is what git checks out for it, below directories only, so no link shows
 * the check another directory: a link or a file whose bytes hash to its object, a file of the same executable bit.
 */
async function holds(clone: string, entry: StartingEntry): Promise<boolean> {
  const parts = entry.path.split('/');

  for (let depth = 1; depth < parts.length; depth += 1) {
    if ((await fs.lstat(path.join(clone, ...parts.slice(0, depth))).catch(() => undefined))?.isDirectory() !== true) return false;
  }

  const at = path.join(clone, ...parts);
  const stats = await fs.lstat(at).catch(() => undefined);

  if (stats === undefined) return false;
  // Windows keeps no executable bit, and git writes a link it cannot make there as a file that holds its target.
  const kind = stats.isSymbolicLink() ? '120000' : !stats.isFile() ? undefined : process.platform === 'win32' ? entry.mode : (stats.mode & 0o100) !== 0 ? '100755' : '100644';

  if (kind !== entry.mode) return false;
  const bytes = stats.isSymbolicLink() ? await fs.readlink(at, { encoding: 'buffer' }) : await fs.readFile(at);

  return createHash(entry.oid.length === 64 ? 'sha256' : 'sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex') === entry.oid;
}

const NO_ENV: EnvScope = { provide: [], withhold: [] };
