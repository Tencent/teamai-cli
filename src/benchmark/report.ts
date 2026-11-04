/**
 * `teamai benchmark report`: a `finally` step of a benchmark run. It reads the run it is a step of, classifies the trials
 * of the plan the run measured, and writes the run's benchmark record: always into the run's directory, which the
 * dashboard reads, and into the pending delivery when the member's recording allows publication. The record is keyed
 * by run id and built from the run alone, so a report that runs again writes the same record at the same key. With
 * `COMPARE=true` it also compares the record with the published ones, for the workflow's `regression` step.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { getCurrentVersion } from '../package-info.js';
import { definedFields } from '../utils/defined-fields.js';
import { publishPendingRecords, queueBenchmarkRecord } from '../workflow/records.js';
import { findAttemptRun } from '../workflow/run-location.js';
import { runsDir } from '../workflow/store.js';
import type { LocalConfig } from '../types.js';
import type { RunState, WorkflowFailure } from '../workflow/types.js';
import { regressionOf, runComparisons, type ArmComparison, type BenchmarkRunInput, type Regression } from './history.js';
import { benchmarkRecord, benchmarkRecordFile, unlaunchedTrial, type BenchmarkRunRecord } from './result.js';
import { planOfRun, trialsUnattended, type RunPlan } from './run-plan.js';
import { benchmarkTable, formatBenchmarkTable, type AssetEffect, type BenchmarkTable } from './table.js';
import { toolUnavailableNotice } from './trial.js';
import { TrialVerdicts, type EntryVerdict } from './verdicts.js';

/**
 * What `report` prints: the results as text, after a line when the trials ran with their tools' own permission settings
 * and a line for each arm whose tool the run's driver could not launch, followed by `record: pending` while the
 * record waits and by what the comparison found; as a table, with how each scorer of each trial ended; and the
 * comparison's finding.
 */
export interface BenchmarkReport {
  text: string;
  table: BenchmarkTable & { pairs: ArmComparison[]; verdicts: EntryVerdict[]; assets: AssetEffect[] };
  /** Against the newest earlier comparable record on teamai-reports; `off` when `COMPARE` did not ask for the comparison. */
  regression: Regression['kind'] | 'off';
}

/** `COMPARE`, as `{{ inputs.fail_on_regression }}` renders it; unset compares nothing. */
const CompareSchema = z.enum(['true', 'false']).optional();

/**
 * The report of the run whose attempt `env` marks: its record written, queued and, when it can be, published. Refused
 * when this process runs as no `finally` step of a benchmark run, or the run's plan is of an unknown schemaVersion.
 */
export async function reportBenchmark(env: NodeJS.ProcessEnv, secrets: Record<string, string>): Promise<{ report: BenchmarkReport } | { failure: WorkflowFailure }> {
  const found = await findAttemptRun(env);

  if ('error' in found) return { failure: found.error };
  const { config, run, step } = found;
  const compare = CompareSchema.safeParse(env.COMPARE);

  if (!compare.success) {
    return { failure: { code: 'invalid_arguments', message: `Step "${step.id}" of run ${run.id} sets COMPARE to ${env.COMPARE}, and teamai benchmark report takes true or false. Set it to "{{ inputs.fail_on_regression }}" with input fail_on_regression: boolean.` } };
  }

  const finalizing = run.finalizing;

  if (!finalizing) {
    return { failure: { code: 'invalid_arguments', message: `Step "${step.id}" of run ${run.id} runs before the run's steps ended, so there is nothing to report yet. Run teamai benchmark report as a finally step.` } };
  }

  const planned = planOfRun(run);

  if ('failure' in planned) return planned;
  const verdicts = await TrialVerdicts.of(config, run, planned.found);

  const record = definedFields<BenchmarkRunRecord>({
    schemaVersion: 1,
    run: run.id,
    outcome: finalizing.outcome,
    teamaiVersion: getCurrentVersion(),
    startedAt: run.createdAt,
    finishedAt: finalizing.since,
    username: config.username || undefined,
    workflow: { name: run.name, origin: run.origin ?? { source: 'team' }, sourceHash: run.sourceHash },
    ...benchmarkRecord(run, planned.found, verdicts),
  });

  const file = benchmarkRecordFile(runsDir(config), run.id);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(`${file}.tmp`, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  await fs.rename(`${file}.tmp`, file);
  const queued = await queueBenchmarkRecord(config, record, secrets);
  const pending = queued && (await publishPendingRecords(config, { run: run.id }).catch(() => ({ state: 'pending' as const }))).state === 'pending';
  const table = benchmarkTable({ benchmark: record });
  const asked = trialsUnattended(run, planned.found.producer) ? [] : [ASKED_NOTICE];
  const current: BenchmarkRunInput = { run: run.id, source: 'local', startedAt: run.createdAt, outcome: record.outcome, benchmark: record };
  const regression = compare.data === 'true' ? await regressionAgainstPublished(config, current) : undefined;

  const text = [
    ...asked, ...unlaunchedArms(run, planned.found), formatBenchmarkTable(table), ...(pending ? ['record: pending'] : []),
    ...(regression === undefined ? [] : [regressionLines(regression, record.suite.name).join('\n')]),
  ].join('\n\n');

  return { report: { text, table: { ...table, pairs: runComparisons(current), verdicts }, regression: regression?.kind ?? 'off' } };
}

/**
 * `current` against the published records Compare reads, refreshed from origin. Its own record counts though still
 * pending; those of other runs pending on this machine do not.
 */
async function regressionAgainstPublished(config: LocalConfig, current: BenchmarkRunInput): Promise<Regression> {
  const { publishedBenchmarkRuns } = await import('../dashboard/benchmarks.js');

  return regressionOf(current, await publishedBenchmarkRuns(config, { refresh: true }));
}

function regressionLines(regression: Regression, suite: string): string[] {
  const points = (fraction: number): number => Math.round(fraction * 100);

  switch (regression.kind) {
    case 'no_comparable':
      return [`No earlier succeeded run of suite ${suite} ran the same tasks on the same arms on teamai-reports: recording is off, or nothing comparable has been published yet. --fail-on-regression has nothing to compare with.`];
    case 'held':
      return [`No arm's pass rate dropped by more than chance against run ${regression.against}.`];
    case 'dropped':
      return regression.arms.map(({ arm, pairs, rates, difference }) => `Arm "${arm}" passed ${rates.to.passed}/${pairs} paired trials, against ${rates.from.passed}/${pairs} in run ${regression.against}: a drop of ${points(-difference.value)} points, with a 95% interval of ${points(difference.low)} to ${points(difference.high)} points.`);
    default: {
      const unhandled: never = regression;

      return unhandled;
    }
  }
}

const ASKED_NOTICE = 'Each trial ran with its tool\'s own permission settings, since the step that runs the plan is not a strict sandbox: a tool that may not edit failed its trials. To run them with permissions: unattended, keep requires: { isolation: sandbox, strict: true } on that step.';

/** A line for each arm with a prompt that failed `tool_unavailable` before any lease: the driver could not launch its tool. */
function unlaunchedArms(run: RunState, { plan, prefix }: RunPlan): string[] {
  return plan.arms.filter((arm) => plan.trials.some((trial) => trial.arm === arm.name && unlaunchedTrial(run, `${prefix}${trial.step}`))).map(toolUnavailableNotice);
}
