/**
 * Judge calibration against the check. A task with a check and success criteria whose check failed has work that is not
 * done, so a correctness judge that labels it passing is wrong. A share of those trials, sampled by `calibration.rate`,
 * is labelled by their correctness judge too, through `teamai-score` with `store: false`. Nothing here decides a trial,
 * pairs trials or reaches the regression gate: a calibration label is never one of a trial's verdicts.
 */
import { CheckOutputSchema, type CheckOutput } from '../scorers/check.js';
import { isKeySampled } from '../scorers/sampling.js';
import { Subject } from '../scorers/subject.js';
import type { RunState } from '../workflow/types.js';
import { checkStepOf, correctnessScorerName, type PlannedTask } from './plan.js';
import type { RunPlan } from './run-plan.js';

/** Whether `task` has both a check and success criteria, so its check is ground truth for its correctness judge. */
export function isMixedTask(task: PlannedTask): boolean {
  return task.judge.kind === 'both';
}

/** Whether a trial of `task` is one a judge's label calibrates: the task has a check and success criteria, and its check failed. */
export function isCalibrationCandidate(task: PlannedTask, output: CheckOutput | undefined): boolean {
  return isMixedTask(task) && output?.result === 'failed';
}

/**
 * Whether the trial whose work step is `step`, in run `runId`, is sampled at `rate` percent: by those two alone, so a
 * resumed run samples the same trials.
 */
export function isCalibrationSampled({ runId, step }: { runId: string; step: string }, rate: number): boolean {
  return isKeySampled({ calibration: { runId, step } }, rate);
}

/** A trial pass to calibrate, and the correctness scorer whose judge labels it. */
export interface CalibrationSubject {
  subject: string;
  scorer: string;
}

/**
 * The sampled trials of `run`, with `within` only those whose work step is inside that step: each candidate's pass as a
 * subject, with its task's correctness scorer. None when the plan sets no rate.
 */
export function calibrationSubjects(run: RunState, { plan, prefix }: RunPlan, within?: string): CalibrationSubject[] {
  const rate = plan.calibration?.rate ?? 0;
  const stateOf = (id: string) => run.steps.find((state) => state.id === id);

  return plan.trials.flatMap((trial) => {
    const step = `${prefix}${trial.step}`;
    const task = plan.tasks.find(({ id }) => id === trial.task);
    const check = stateOf(`${prefix}${checkStepOf(trial)}`);
    const output = CheckOutputSchema.safeParse(check && 'outputs' in check ? check.outputs : undefined).data;

    if ((within !== undefined && !step.startsWith(`${within}.`)) || !task || !isCalibrationCandidate(task, output) || !isCalibrationSampled({ runId: run.id, step }, rate)) return [];

    return [{ subject: Subject.format({ kind: 'run', subject: { runId: run.id, step, pass: stateOf(step)?.pass ?? 1 } }), scorer: correctnessScorerName(task.id) }];
  });
}
