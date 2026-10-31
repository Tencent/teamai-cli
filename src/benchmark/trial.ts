/**
 * The checks of a benchmark's tasks. `runCheckStep` is `teamai benchmark check`, the command of a baseline and a trial's
 * check, in the clone its step's place prepared: the files check.add writes, the protected paths as the starting commit
 * has them, and the check's verdict. `tryCheckAt` runs one check with no run, for `teamai benchmark try`, and
 * `commitCheckFiles` commits the files a suite's checks write, before a plan is frozen.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { loadLocalConfigForScope } from '../config.js';
import { stepEnvironment } from '../env-exec.js';
import type { WorkflowEnv } from '../env-resolution.js';
import { teamRefBlocker, type TeamRefBlock } from '../team-ref.js';
import { isSelfMode, type LocalConfig } from '../types.js';
import { sameEnvName } from '../resources/env-key.js';
import { log } from '../utils/logger.js';
import { leaseDeadline } from '../workflow/limits.js';
import { commitCacheOf, freshClone, scratchCloneRoot } from '../workflow/place/place.js';
import { findAttemptRun } from '../workflow/run-location.js';
import { runSetup } from '../workflow/place/setup.js';
import { SANDBOX_WITHHELD_ENV, type EnvScope, type LeaseSetup, type Setup } from '../workflow/requirements.js';
import { runShellCommand } from '../workflow/shell-command.js';
import type { WorkflowFailure } from '../workflow/types.js';
import { untrustedGit, type Git } from '../workflow/worktree.js';
import { checkVerdict, type CheckResult, type CheckVerdict } from './check.js';
import { BENCHMARK_PLAN_SCHEMA_VERSION, baselineStepOf, checkStepOf, type BenchmarkPlan, type PlannedArm } from './plan.js';
import type { CheckFile, Suite } from './suite.js';
import { planOfRun } from './run-plan.js';
import type { Added } from './terms.js';

const CommittedSuiteSchema = z.custom<{ suite: Suite; files: ReadonlyMap<string, Added> }>((value) => typeof value === 'object' && value !== null)
  .brand<'CommittedSuite'>();
/**
 * A suite whose check files are each a commit in a commit cache: `files` holds, by task, the check.add entry that writes
 * them. Only `commitCheckFiles` makes one, so a task's check files never reach a plan without their commit.
 */
export type CommittedSuite = z.infer<typeof CommittedSuiteSchema>;

/** Commits the check files of every task of `suite` that has them into `cache`, or names the first task that failed. */
export async function commitCheckFiles(cache: string, suite: Suite): Promise<{ ok: true; suite: CommittedSuite } | { ok: false; task: string; failed: string }> {
  const files = new Map<string, Added>();
  for (const task of suite.tasks) {
    if (task.judge.kind !== 'check' || !task.judge.files) continue;
    const [first, ...rest] = task.judge.files;
    const committed = await commitFiles(cache, task.judge.files);
    if ('failed' in committed) return { ok: false, task: task.id, failed: committed.failed };
    files.set(task.id, { kind: 'suite', commit: committed.commit, paths: [first.path, ...rest.map((file) => file.path)] });
  }
  return { ok: true, suite: CommittedSuiteSchema.parse({ suite, files }) };
}

/**
 * Writes `files` into the bare repo `cache` as a commit of their own, each at its path with its mode, so a trial's check
 * writes them as `check.add` writes a fix's: a pull during the run changes none of them. A fixed author, committer and
 * date make the same files the same commit. A ref keeps it from gc while runs read it.
 */
async function commitFiles(cache: string, files: readonly CheckFile[]): Promise<{ commit: string } | { failed: string }> {
  await fs.mkdir(cache, { recursive: true });
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'teamai-check-files-'));
  // untrustedGit is the git that takes an env with stdin, which the index of its own needs.
  const written = untrustedGit({
    ...process.env, GIT_INDEX_FILE: path.join(dir, 'index'),
    GIT_AUTHOR_NAME: 'teamai', GIT_AUTHOR_EMAIL: 'teamai@localhost', GIT_AUTHOR_DATE: '946684800 +0000',
    GIT_COMMITTER_NAME: 'teamai', GIT_COMMITTER_EMAIL: 'teamai@localhost', GIT_COMMITTER_DATE: '946684800 +0000',
  });
  const failed = (step: string, stderr: string): { failed: string } => ({ failed: `git ${step} failed: ${stderr.trim()}.` });
  try {
    const made = await written(cache, ['init', '-q', '--bare']);
    if (made.code !== 0) return failed('init', made.stderr);
    const blobs = files.map((file, index) => ({ at: path.join(dir, `${index}.blob`), file }));
    for (const { at, file } of blobs) await fs.writeFile(at, Buffer.from(file.base64, 'base64'));
    const hashed = await written(cache, ['hash-object', '-w', '--no-filters', '--stdin-paths'], { input: blobs.map(({ at }) => at).join('\n') });
    const objects = hashed.stdout.trim().split('\n');
    if (hashed.code !== 0 || objects.length !== files.length) return failed('hash-object', hashed.stderr);
    const staged = await written(cache, ['update-index', '--add', '-z', '--index-info'], { input: files.map((file, index) => `${file.mode} ${objects[index]}\t${file.path}\0`).join('') });
    if (staged.code !== 0) return failed('update-index', staged.stderr);
    const tree = await written(cache, ['write-tree']);
    if (tree.code !== 0) return failed('write-tree', tree.stderr);
    const commit = await written(cache, ['commit-tree', tree.stdout.trim(), '-m', 'teamai: check files']);
    if (commit.code !== 0) return failed('commit-tree', commit.stderr);
    const sha = commit.stdout.trim();
    const kept = await written(cache, ['update-ref', `refs/benchmark/${sha}`, sha]);
    return kept.code === 0 ? { commit: sha } : failed('update-ref', kept.stderr);
  } finally {
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 3 });
  }
}

const SELF_MODE = "Benchmarks do not run in single-repo mode: the project's own commit decides which team assets a checkout has, so no arm can run on a team revision of its own. Start the benchmark from a checkout whose team has a team repo of its own.";

/** Why a benchmark cannot run here, for each reason `teamai pull --team-ref` cannot pin a workspace. */
const BLOCKED: Record<TeamRefBlock, string> = {
  no_workspace: 'A benchmark gives each trial the team revision it plans, and that needs a teamai workspace here. Run teamai init --scope workspace here, run teamai pull, and run the benchmark again.',
  user_scope: 'A benchmark gives each trial the team revision it plans, but this team also reaches this checkout through user scope, where every workspace shares one copy, so a trial could read team assets that revision does not have. Remove the user-scope install, or turn off inheritUserScope in this workspace, and run the benchmark again.',
  self: SELF_MODE,
  http: "A benchmark installs each trial's team assets from a commit of the team repo, and this team is served over HTTP, which has no commits to install from. Run the benchmark from a workspace whose team is a git repo.",
};

/**
 * Why this machine cannot pin the team a trial runs, or undefined: the team is single-repo, also reaches the trial
 * through user scope, or is served over HTTP. The check `teamai pull --team-ref` makes, in a benchmark's words, and
 * single-repo mode first, where no other setting of this machine would let a benchmark run.
 */
export async function trialBlocker(config: LocalConfig): Promise<string | undefined> {
  if (isSelfMode(config)) return SELF_MODE;
  const blocked = teamRefBlocker(config, await loadLocalConfigForScope('user', undefined, { dryRun: true }));
  return blocked ? BLOCKED[blocked.block] : undefined;
}

/** The line that says why the trials of `arm` did not run: the local driver cannot launch its tool. */
export function toolUnavailableNotice(arm: Pick<PlannedArm, 'name' | 'tool'>): string {
  return `Arm "${arm.name}" uses ${arm.tool}, which the local driver cannot run, so its trials did not run.`;
}

/** Setup with only its own keys, as the lease scopes them. */
async function setupIn(trial: Runner, dir: string, setup: LeaseSetup, expiresAt: string | undefined): Promise<WorkflowFailure | undefined> {
  const scope = setup.envScope ?? NO_ENV;
  const scoped = await stepEnvironment(trial.env, scope);
  if (!scoped.ok) return scoped.failure;
  return runSetup({ command: setup.command, dir, env: scoped.env, keys: scope.provide, ...(trial.signal ? { signal: trial.signal } : {}), ...(expiresAt !== undefined ? { expiresAt } : {}) });
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
    command: lease.command, cwd: prepared.dir, env: scoped.env,
    ...(trial.signal ? { signal: trial.signal } : {}), ...(lease.expiresAt !== undefined ? { expiresAt: lease.expiresAt } : {}),
  });
  return { kind: 'check', verdict: checkVerdict(exit, process.platform) };
}

/** Which check `teamai benchmark check` runs: a check task's baseline, or a trial's check. */
export type CheckStepMode = 'baseline' | 'trial';

/**
 * `teamai benchmark check --baseline|--trial`: the check of the step whose attempt `env` marks, in `cwd`, the clone that
 * step's place prepared and set up. It reads what it checks from the run's plan, by the step's id: a trial's check first
 * puts the protected paths back as the starting commit has them; both then write the files check.add names, from the
 * run's checkout or the commit cache. Git and the check run with `env` without the names a strict sandbox withholds, which this
 * process may have set itself, until `signal` or the lease's deadline stops them, and the verdict is classified here, once. Answers its result, or why the check did not run, with one progress line either way.
 */
export async function runCheckStep({ mode, env: given, cwd, signal }: { mode: CheckStepMode; env: NodeJS.ProcessEnv; cwd: string; signal?: AbortSignal }): Promise<{ result: CheckResult } | { failure: WorkflowFailure }> {
  const found = await findAttemptRun(given);
  if ('error' in found) {
    if (found.error.code !== 'run_unreadable') return { failure: found.error };
    return { failure: { ...found.error, message: `${found.error.message}: its file, or the benchmark plan in it, is not in a form this teamai reads, whose plans are schemaVersion ${BENCHMARK_PLAN_SCHEMA_VERSION}. Run the benchmark with the teamai that started it, or start it again.` } };
  }
  const { config, run, step } = found;
  const planned = planOfRun(run, step.id);
  if ('failure' in planned) return planned;
  const { plan, prefix } = planned.found;
  const checked = step.id.startsWith(prefix) ? checkedBy(plan, mode, step.id.slice(prefix.length)) : undefined;
  if (!checked) {
    return { failure: { code: 'invalid_arguments', message: `Step "${step.id}" of run ${run.id} is not ${mode === 'baseline' ? 'the baseline of a check task' : 'the check of a trial'} of a benchmark run, so teamai benchmark check --${mode} has nothing to check there.` } };
  }
  const { task, judge, at } = checked;
  const env = Object.fromEntries(Object.entries(given).filter(([key]) => sameEnvName(SANDBOX_WITHHELD_ENV, key) === undefined));
  const sources = [...(run.checkout !== undefined ? [run.checkout] : []), commitCacheOf(config, plan.suite.repo)];
  const expiresAt = leaseDeadline(run, step);
  const prepared = (mode === 'trial' ? await restoreProtected({ clone: cwd, startingCommit: task.startingCommit, protect: judge.protect, sources, env, expiresAt }) : undefined)
    ?? (judge.add ? await writeAdded({ clone: cwd, add: judge.add, sources, env, expiresAt }) : undefined);
  const ran: CheckRun = prepared
    ? { kind: 'error', failure: prepared }
    : { kind: 'check', verdict: checkVerdict((await runShellCommand({ command: judge.run, cwd, env, ...(signal ? { signal } : {}), ...(expiresAt !== undefined ? { expiresAt } : {}) })).exit, process.platform) };
  if (at) progress(at, ran);
  else baselineProgress(task.id, ran);
  return ran.kind === 'check' ? { result: ran.verdict.verdict } : { failure: ran.failure };
}

/** The check task `step` checks in `mode`, its check, and for a trial's check, the trial as its lines name it. */
function checkedBy(plan: BenchmarkPlan, mode: CheckStepMode, step: string): { task: BenchmarkPlan['tasks'][number]; judge: Extract<BenchmarkPlan['tasks'][number]['judge'], { kind: 'check' }>; at?: TrialAt } | undefined {
  const trial = mode === 'trial' ? plan.trials.find((planned) => checkStepOf(planned) === step) : undefined;
  const task = plan.tasks.find((planned) => (mode === 'trial' ? planned.id === trial?.task : baselineStepOf(planned.id) === step));
  if (task?.judge.kind !== 'check') return undefined;
  return { task, judge: task.judge, ...(trial ? { at: { ...trial, total: plan.trials.length } } : {}) };
}

/**
 * One check of a task at `commit`, as its steps run it but with no run: a fresh clone of `commit` from the first of
 * `sources` that has it, then setup. With `protect`, a trial check's, `restoreProtected` then puts those paths back as
 * `startingCommit` has them; without it, a baseline's, nothing is put back. Then the files `add` names are written, and
 * the check runs. Setup, the tool's strip list and `expiresAt` apply as they do to a trial. The clone is removed.
 */
export async function tryCheckAt(input: {
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
 * the check reads the fix's test, or the suite's, and the agent never did. Each must be a file at that commit. The
 * commit is read from the first of `sources` that has it into an index of its own, and its files are written from that
 * source's objects, so nothing the clone holds decides what is written. Then each must hold that commit's bytes, as
 * `restoreProtected` checks its own, git stopped at `expiresAt` as there. Undefined once every entry is written.
 */
async function writeAdded({ clone, add, sources, env, expiresAt }: {
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
          message: kind === 'fix'
            ? `check.add path ${missing} is not a file at the fix ${commit}. List files the fix has in check.add, or fix source.fix.`
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

/** A trial, as its progress lines name it: its place in the plan's trial list of `total`. */
interface TrialAt {
  order: number;
  total: number;
  task: string;
  arm: string;
}

/** One line on stderr per trial check, one whole literal, so an operator can search for it. */
function progress({ order, total, task, arm }: TrialAt, event: CheckRun): void {
  switch (event.kind) {
    case 'check':
      switch (event.verdict.verdict) {
        case 'passed':
          log.info(`Trial ${order}/${total} ${task} ${arm}: check passed`);
          return;
        case 'failed':
          log.info(`Trial ${order}/${total} ${task} ${arm}: check failed (exit ${event.verdict.exitCode})`);
          return;
        case 'could_not_run':
          log.info(`Trial ${order}/${total} ${task} ${arm}: check could not run (${event.verdict.cause})`);
          return;
        default: {
          const unhandled: never = event.verdict;
          return unhandled;
        }
      }
    case 'error':
      log.info(`Trial ${order}/${total} ${task} ${arm}: error (${event.failure.code}: ${event.failure.message})`);
      return;
    default: {
      const unhandled: never = event;
      return unhandled;
    }
  }
}

/** One line on stderr per baseline, each one whole literal, like the trials' lines. */
function baselineProgress(task: string, event: CheckRun): void {
  switch (event.kind) {
    case 'check':
      switch (event.verdict.verdict) {
        case 'passed':
          log.info(`Baseline ${task}: check passes without changes, so the task is invalid`);
          return;
        case 'failed':
          log.info(`Baseline ${task}: check fails on the starting commit, as the task expects`);
          return;
        case 'could_not_run':
          log.info(`Baseline ${task}: check could not run (${event.verdict.cause})`);
          return;
        default: {
          const unhandled: never = event.verdict;
          return unhandled;
        }
      }
    case 'error':
      log.info(`Baseline ${task}: check could not run (${event.failure.code}: ${event.failure.message})`);
      return;
    default: {
      const unhandled: never = event;
      return unhandled;
    }
  }
}
