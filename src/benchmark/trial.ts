/**
 * The checks of a benchmark's tasks. `runCheckStep` is `teamai benchmark check`, the command of a baseline and a trial's
 * check, in the clone its step's place prepared: the files check.add writes, the protected paths as the starting commit
 * has them, and the check's verdict. `commitCheckFiles` commits the files a suite's checks write, before a plan is frozen.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { loadLocalConfigForScope } from '../config.js';
import { teamRefBlocker, type TeamRefBlock } from '../team-ref.js';
import { isSelfMode, type LocalConfig } from '../types.js';
import { sameEnvName } from '../resources/env-key.js';
import { log } from '../utils/logger.js';
import { leaseDeadline } from '../workflow/limits.js';
import { checkVerdict, type Added, type CheckResult } from '../scorers/check.js';
import { restoreProtected, writeAdded, type CheckRun } from '../scorers/check-run.js';
import { commitCacheOf } from '../workflow/place/place.js';
import { findAttemptRun } from '../workflow/run-location.js';
import { SANDBOX_WITHHELD_ENV } from '../workflow/requirements.js';
import { runShellCommand } from '../workflow/shell-command.js';
import type { WorkflowFailure } from '../workflow/types.js';
import { untrustedGit } from '../workflow/worktree.js';
import { BENCHMARK_PLAN_SCHEMA_VERSION, baselineStepOf, checkStepOf, type BenchmarkPlan, type PlannedArm } from './plan.js';
import type { CheckFile, Suite } from './suite.js';
import { planOfRun } from './run-plan.js';

const CommittedSuiteSchema = z.object({ suite: z.custom<Suite>(), files: z.custom<ReadonlyMap<string, Added>>() }).brand<'CommittedSuite'>();

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
 * writes them as `check.add` writes a solution commit's: a pull during the run changes none of them. A fixed author, committer and
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

  const failed = (step: string, stderr: string) => ({ failed: `git ${step} failed: ${stderr.trim()}.` });

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
    : { kind: 'check', verdict: checkVerdict((await runShellCommand({ command: judge.run, cwd, env, signal, expiresAt })).exit, process.platform) };

  if (at) progress(at, ran);
  else baselineProgress(task.id, ran);

  return ran.kind === 'check' ? { result: ran.verdict.verdict } : { failure: ran.failure };
}

/** The check task `step` checks in `mode`, its check, and for a trial's check, the trial as its lines name it. */
function checkedBy(plan: BenchmarkPlan, mode: CheckStepMode, step: string): { task: BenchmarkPlan['tasks'][number]; judge: Extract<BenchmarkPlan['tasks'][number]['judge'], { kind: 'check' }>; at?: TrialAt } | undefined {
  const trial = mode === 'trial' ? plan.trials.find((planned) => checkStepOf(planned) === step) : undefined;
  const task = plan.tasks.find((planned) => (mode === 'trial' ? planned.id === trial?.task : baselineStepOf(planned.id) === step));

  if (task?.judge.kind !== 'check') return undefined;

  return { task, judge: task.judge, at: trial ? { ...trial, total: plan.trials.length } : undefined };
}

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
