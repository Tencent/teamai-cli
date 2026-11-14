/**
 * The checks of a benchmark's tasks. A baseline's or a trial's check step runs the task's own check, where its runtime
 * runs it, such as in a sandbox with no teamai. teamai owns the rest of it, on this machine: `prepareCheckPlace` writes
 * the files check.add names, and for a trial puts the protected paths back as the starting commit has them, in the
 * clone it prepared for the step; `decideCheckReport` turns the step's exit code into its output, the check's verdict,
 * and stores a trial's correctness label. `outdatedBenchmarkPlan` refuses every lease and resume of a run whose plan
 * another schemaVersion froze. `commitCheckFiles` commits the files a suite's checks write, before a plan is frozen.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { loadLocalConfigForScope } from '../config.js';
import { teamRefBlocker, type TeamRefBlock } from '../team-ref.js';
import { isSelfMode, type LocalConfig } from '../types.js';
import { sameEnvName } from '../resources/env-key.js';
import { log } from '@teamai/shared/log';
import { checkLabel, checkVerdict, type Added, type CheckOutput } from '../scorers/check.js';
import { restoreProtected, writeAdded, type CheckRun } from '../scorers/check-run.js';
import { labelVersion, type RunSubject, type ScoreLabel } from '../scorers/label.js';
import { LabelStore } from '../scorers/label-store.js';
import { keepsLabelsLocal } from '../scorers/score-labels.js';
import { judgedFacts } from '../scorers/scoring-evidence.js';
import { leaseDeadline } from '../workflow/limits.js';
import { commitCacheOf } from '../workflow/place/place.js';
import { SANDBOX_WITHHELD_ENV } from '../workflow/requirements.js';
import type { ReportInput } from '../workflow/engine.js';
import type { LeasedStep } from '../workflow/step-state.js';
import type { RunState, StepOutcome, WorkflowFailure } from '../workflow/types.js';
import { untrustedGit } from '../workflow/worktree.js';
import { baselineStepOf, checkStepOf, correctnessScorerName, type BenchmarkPlan, type PlannedArm, type PlannedCheck, type PlannedTrial } from './plan.js';
import { TaskJudge, type CheckFile, type Suite } from './suite.js';
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
    const written = TaskJudge.checkOf(task.judge)?.files;

    if (!written) continue;
    const [first, ...rest] = written;
    const committed = await commitFiles(cache, written);

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

const SELF_MODE = "Benchmarks do not run in self mode: the project's own commit decides which team resources a checkout has, so no arm can run on a team revision of its own. Start the benchmark from a checkout whose team has a team repo of its own.";

/** Why a benchmark cannot run here, for each reason `teamai pull --team-ref` cannot pin a workspace. */
const BLOCKED: Record<TeamRefBlock, string> = {
  no_workspace: 'A benchmark gives each trial the team revision it plans, and that needs a teamai workspace here. Run teamai init --scope workspace here, run teamai pull, and run the benchmark again.',
  user_scope: 'A benchmark gives each trial the team revision it plans, but this team also reaches this checkout through user scope, where every workspace shares one copy, so a trial could read team resources that revision does not have. Remove the user-scope install, or turn off inheritUserScope in this workspace, and run the benchmark again.',
  self: SELF_MODE,
  http: "A benchmark installs each trial's team resources from a commit of the team repo, and this team is served over HTTP, which has no commits to install from. Run the benchmark from a workspace whose team is a git repo.",
};

/**
 * Why this machine cannot pin the team a trial runs, or undefined: the team is in self mode, also reaches the trial
 * through user scope, or is served over HTTP. The check `teamai pull --team-ref` makes, in a benchmark's words, and
 * self mode first, where no other setting of this machine would let a benchmark run.
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

/**
 * Why no driver may lease a step of `run`, and `teamai workflow resume` refuses it: a benchmark run whose plan a teamai
 * before an upgrade froze in another schemaVersion, which this one cannot measure. Undefined for any other run, and for
 * a benchmark run before its plan step printed the plan.
 */
export function outdatedBenchmarkPlan(run: RunState): WorkflowFailure | undefined {
  const planned = planOfRun(run);

  return 'failure' in planned && planned.failure.code === 'benchmark_plan_outdated' ? planned.failure : undefined;
}

/**
 * The check step `step` is in the benchmark plan of `run`: a task's baseline, or a trial's check, with the task's check
 * and, for a trial's check, the trial as its lines name it. Undefined for any other step, and in a run with no plan this
 * teamai reads, which never runs a check here: `outdatedBenchmarkPlan` refuses its leases and its resume.
 */
function plannedCheckOf(run: RunState, step: string): (Checked & { plan: BenchmarkPlan; prefix: string }) | undefined {
  const planned = planOfRun(run, step);

  if (!('found' in planned)) return undefined;
  const { plan, prefix } = planned.found;

  if (!step.startsWith(prefix)) return undefined;
  const checked = checkedBy(plan, step.slice(prefix.length));

  return checked && { ...checked, plan, prefix };
}

/** The env git gets on this machine for a check step: teamai's own, without the names a strict sandbox withholds. */
function checkGitEnv(): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(process.env).filter(([key]) => sameEnvName(SANDBOX_WITHHELD_ENV, key) === undefined));
}

/** The leased step of `run` whose attempt is `attempt`. */
function leasedStep(run: RunState, attempt: string): LeasedStep | undefined {
  return run.steps.find((state): state is LeasedStep => state.status === 'leased' && state.attempt === attempt);
}

/**
 * What teamai does on this machine in the place `dir` it prepared for attempt `attempt` of `run`, before the step's
 * command, the task's own check, runs there on the step's runtime, when the step is a benchmark check step; nothing for
 * any other step. A trial's check first gets the protected paths back as the starting commit has them, then both write
 * the files check.add names, from the run's checkout or the commit cache, neither of which the step's runtime may see.
 * Git starts nothing the clone configures, runs without the names a strict sandbox withholds, and stops at the lease's
 * deadline. Repeating it repeats the same writes, so a prepare that runs again leaves the same place. Answers why it
 * could not, as `trial_prepare_failed`, after the check's progress line.
 */
export async function prepareCheckPlace({ config, run, attempt, dir }: { config: LocalConfig; run: RunState; attempt: string; dir: string }): Promise<WorkflowFailure | undefined> {
  const step = leasedStep(run, attempt);
  const checked = step && plannedCheckOf(run, step.id);

  if (!checked) return undefined;
  const { task, judge, at, plan } = checked;
  const env = checkGitEnv();
  const sources = [...(run.checkout !== undefined ? [run.checkout] : []), commitCacheOf(config, plan.suite.repo)];
  const expiresAt = leaseDeadline(run, step);

  const failure = (at ? await restoreProtected({ clone: dir, startingCommit: task.startingCommit, protect: judge.protect, sources, env, expiresAt }) : undefined)
    ?? (judge.add ? await writeAdded({ clone: dir, add: judge.add, sources, env, expiresAt }) : undefined);

  if (failure) progressOf(checked, { kind: 'error', failure });

  return failure;
}

/** The report of an attempt that ran to an end, rather than one its driver handed back. */
type EndedReport = ReportInput & { outcome: Exclude<StepOutcome, 'released'> };

/** The report codes of a check command that ran to an exit: the command's own failure, or a step that exited 0. */
const RAN_TO_EXIT: ReadonlySet<WorkflowFailure['code'] | undefined> = new Set([undefined, 'command_failed', 'input_rejected']);

/**
 * `report`, the report of the attempt of a step of `run`, with what teamai decides when the step is a benchmark check
 * step whose command, the task's own check, ran to an exit: the step succeeds with output `{ result, cause, label }`,
 * the check's verdict classified here, once, from the exit code alone, whatever the command printed. A trial's check
 * that ran stores the trial's correctness label, decided by the check, through the store `teamai score write` writes to,
 * but not one that passed a task with success criteria, whose judge then decides. A report of any other step, or one
 * that failed for a cause of its own, such as a runtime lost, is answered as it came. A check reported with no exit code
 * fails `invalid_report`, whatever outputs it carries; a check whose label could not
 * be stored fails with why.
 */
export async function decideCheckReport({ config, run, report }: { config: LocalConfig; run: RunState; report: EndedReport }): Promise<EndedReport> {
  if (report.outcome === 'failed' && !RAN_TO_EXIT.has(report.failure?.code)) return report;
  const step = leasedStep(run, report.attempt);
  const checked = step && plannedCheckOf(run, step.id);

  if (!checked) return report;

  if (report.exitCode === undefined) {
    const { outputs, ...unreported } = report;
    const failure: WorkflowFailure = { code: 'invalid_report', message: `Step "${step.id}" of run ${run.id} is a benchmark check step, whose output teamai decides from the check's exit status, and its report carries none. Have the driver report its exitCode.` };

    return { ...unreported, outcome: 'failed', message: failure.message, failure };
  }

  // What the command printed and how the report named its exit are not the step's: its output is the verdict.
  const { message, failure, outputs, ...ran } = report;
  const verdict = checkVerdict({ kind: 'exited', code: report.exitCode }, process.platform);
  progressOf(checked, { kind: 'check', verdict });

  switch (verdict.verdict) {
    case 'could_not_run':
      return { ...ran, outcome: 'success', outputs: { result: 'could_not_run', cause: verdict.cause, label: '' } satisfies CheckOutput };
    case 'passed':
    case 'failed': {
      const { at, task, plan, prefix } = checked;

      // A check that passes a task with success criteria leaves its trial to the judge, so it writes no label.
      if (!at || (verdict.verdict === 'passed' && task.judge.kind === 'both')) return { ...ran, outcome: 'success', outputs: { result: verdict.verdict, cause: '', label: '' } satisfies CheckOutput };
      const work = `${prefix}${at.step}`;
      const stored = await storeCheckLabel({ config, run, plan, subject: { runId: run.id, step: work, pass: workPass(run, work) }, task: task.id, result: verdict.verdict });

      if ('failure' in stored) return { ...ran, outcome: 'failed', message: stored.failure.message, failure: stored.failure };

      return { ...ran, outcome: 'success', outputs: { result: verdict.verdict, cause: '', label: stored.version } satisfies CheckOutput };
    }

    default: {
      const unhandled: never = verdict;

      return unhandled;
    }
  }
}

/** The pass of work step `step` its check follows: the one the step is on. */
function workPass(run: RunState, step: string): number {
  return run.steps.find(({ id }) => id === step)?.pass ?? 1;
}

/**
 * Stores the correctness label of `task` on the trial's work pass that its check decided: `checkLabel` of the scorer's
 * labels as the plan pinned them, judge kind `stage`, decided by `check`, kept on this machine as every label of an
 * isolated run is. Answers the label's version, as `teamai score write` answers it, or why it was not stored.
 */
async function storeCheckLabel({ config, run, plan, subject, task, result }: { config: LocalConfig; run: RunState; plan: BenchmarkPlan; subject: RunSubject; task: string; result: 'passed' | 'failed' }): Promise<{ version: string } | { failure: WorkflowFailure }> {
  const name = correctnessScorerName(task);
  const scorer = plan.scorers.find((pinned) => pinned.name === name);

  if (!scorer) return { failure: { code: 'run_unreadable', message: `The plan of run ${run.id} pins no ${name}, so the check of task "${task}" has no label to write. Start the benchmark again.` } };
  const chosen = checkLabel(result, scorer.labels);

  const label: ScoreLabel = {
    ...judgedFacts(run, subject), source: 'workflow', scorer: name, rubric: { sourceHash: scorer.rubric.sourceHash }, label: chosen.value, score: chosen.score,
    passed: chosen.score >= scorer.passingScore, judge: { kind: 'stage' }, decidedBy: 'check', subject, scoredAt: new Date().toISOString(),
  };

  const written = await LabelStore.append(config, [{ label }], { outbox: !keepsLabelsLocal(run, subject.step) });

  if (written.status === 'busy') return { failure: { code: 'busy', message: `Another teamai process holds the label store, so the label the check of task "${task}" decided was not written. Run the step again.` } };

  return { version: labelVersion(label) };
}

/** A check step of a plan: its task and the task's check, and for a trial's check, the trial as its lines name it. */
interface Checked {
  task: BenchmarkPlan['tasks'][number];
  judge: PlannedCheck;
  at?: TrialAt & Pick<PlannedTrial, 'step'>;
}

/** The check `step`, a step path under the plan's workflow, runs: a trial's check, or a task's baseline. */
function checkedBy(plan: BenchmarkPlan, step: string): Checked | undefined {
  const trial = plan.trials.find((planned) => checkStepOf(planned) === step);
  const task = plan.tasks.find((planned) => (trial ? planned.id === trial.task : baselineStepOf(planned.id) === step));

  if (task === undefined || task.judge.kind === 'criteria') return undefined;

  return { task, judge: task.judge.check, at: trial ? { ...trial, total: plan.trials.length } : undefined };
}

/** The progress line of check step `checked`: a trial's, or a baseline's. */
function progressOf({ task, at }: Checked, event: CheckRun): void {
  if (at) progress(at, event);
  else baselineProgress(task.id, event);
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
      log.info(`Trial ${order}/${total} ${task} ${arm}: check could not run (${event.failure.code}: ${event.failure.message})`);

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
