/**
 * `teamai benchmark report`: a `finally` step of a benchmark run. It reads the run it is a step of, classifies the trials
 * of the plan the run measured, and writes the run's benchmark record: always into the run's directory, which the
 * dashboard reads, and into the pending delivery when the member's recording allows publication. The record is keyed
 * by run id and built from the run alone, so a report that runs again writes the same record at the same key.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { getCurrentVersion } from '../package-info.js';
import { publishPendingRecords, queueBenchmarkRecord } from '../workflow/records.js';
import { findAttemptRun } from '../workflow/run-location.js';
import { runsDir } from '../workflow/store.js';
import type { RunState, WorkflowFailure } from '../workflow/types.js';
import { runComparisons, type ArmComparison } from './history.js';
import { benchmarkRecord, benchmarkRecordFile, unlaunchedTrial, type BenchmarkRunRecord } from './result.js';
import { planOfRun, trialsUnattended, type RunPlan } from './run-plan.js';
import { benchmarkTable, formatBenchmarkTable, type BenchmarkTable } from './table.js';
import { toolUnavailableNotice } from './trial.js';

/**
 * What `report` prints: the results as text, after a line when the trials ran with their tools' own permission settings
 * and a line for each arm whose tool the run's driver could not launch, and ending with `record: pending` while the
 * record waits; and as a table.
 */
export interface BenchmarkReport {
  text: string;
  table: BenchmarkTable & { pairs: ArmComparison[] };
}

/**
 * The report of the run whose attempt `env` marks: its record written, queued and, when it can be, published. Refused
 * when this process runs as no `finally` step of a benchmark run, or the run's plan is of an unknown schemaVersion.
 */
export async function reportBenchmark(env: NodeJS.ProcessEnv, secrets: Record<string, string>): Promise<{ report: BenchmarkReport } | { failure: WorkflowFailure }> {
  const found = await findAttemptRun(env);
  if ('error' in found) return { failure: found.error };
  const { config, run, step } = found;
  const finalizing = run.finalizing;
  if (!finalizing) {
    return { failure: { code: 'invalid_arguments', message: `Step "${step.id}" of run ${run.id} runs before the run's steps ended, so there is nothing to report yet. Run teamai benchmark report as a finally step.` } };
  }
  const planned = planOfRun(run);
  if ('failure' in planned) return planned;
  const record: BenchmarkRunRecord = {
    schemaVersion: 1,
    run: run.id,
    outcome: finalizing.outcome,
    teamaiVersion: getCurrentVersion(),
    startedAt: run.createdAt,
    finishedAt: finalizing.since,
    ...(config.username ? { username: config.username } : {}),
    workflow: { name: run.name, origin: run.origin ?? { source: 'team' }, sourceHash: run.sourceHash },
    ...benchmarkRecord(run, planned.found),
  };
  const file = benchmarkRecordFile(runsDir(config), run.id);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(`${file}.tmp`, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  await fs.rename(`${file}.tmp`, file);
  const queued = await queueBenchmarkRecord(config, record, secrets);
  const pending = queued && (await publishPendingRecords(config, { run: run.id }).catch(() => ({ state: 'pending' as const }))).state === 'pending';
  const table = benchmarkTable({ benchmark: record });
  const asked = trialsUnattended(run, planned.found.producer) ? [] : [ASKED_NOTICE];
  const text = [...asked, ...unlaunchedArms(run, planned.found), formatBenchmarkTable(table)].join('\n\n');
  return {
    report: {
      text: pending ? `${text}\n\nrecord: pending` : text,
      table: { ...table, pairs: runComparisons({ run: run.id, source: 'local', startedAt: run.createdAt, outcome: record.outcome, benchmark: record }) },
    },
  };
}

const ASKED_NOTICE = 'Each trial ran with its tool\'s own permission settings, since the step that runs the plan is not a strict sandbox: a tool that may not edit failed its trials. To run them with permissions: unattended, keep requires: { isolation: sandbox, strict: true } on that step.';

/** A line for each arm with a prompt that failed `tool_unavailable` before any lease: the driver could not launch its tool. */
function unlaunchedArms(run: RunState, { plan, prefix }: RunPlan): string[] {
  return plan.arms.filter((arm) => plan.trials.some((trial) => trial.arm === arm.name && unlaunchedTrial(run, `${prefix}${trial.step}`))).map(toolUnavailableNotice);
}
