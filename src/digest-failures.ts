/**
 * `teamai digest --json` (#1249): what an improvement starts from. The failing score labels of the last 30 days, each
 * with the subject it judges and the commit its work started at, and each scorer's cohorts with, for a model judge,
 * how it agrees with hand labels. It reads labels as the dashboard's Scorers page does, so a benchmark's labels are
 * left out, and it never reads a judge's reasoning, a prompt or a transcript.
 */
import { detectProjectConfig, requireInit } from './config.js';
import { readScorerLabels, rubricLabelsOf } from './dashboard/scorers.js';
import { FailureLinks, type LinkedLearning } from './scorers/failure-links.js';
import { ScorerResults, type Failure, type ScorerFailures } from './scorers/results.js';
import type { LocalConfig } from './types.js';

/**
 * A failing session lists the learnings whose `session` names it, `[]` when none does; a workflow pass lists none.
 * `task`: the benchmark task this checkout pulled whose `source` is the failure's subject, so it is a regression already.
 */
export type DigestFailure = Failure & { task?: string; learnings?: LinkedLearning[] };

export type DigestFailuresView = Omit<ScorerFailures, 'failures'> & { failures: DigestFailure[] };

/** The window failures are read over, in days of `scoredAt`: the dashboard's default. */
/** The window the failures are read over. */
const WINDOW_DAYS = 30;

/**
 * The failures of the last 30 days, as `digest --json` prints them. `refresh` refreshes the reports checkout from origin
 * first, as every reader of it.
 */
async function read(config: LocalConfig, { now = new Date(), refresh = true }: { now?: Date; refresh?: boolean } = {}): Promise<DigestFailuresView> {
  const labels = await readScorerLabels(config, { refresh });
  const [rubricLabels, links] = await Promise.all([rubricLabelsOf(config, labels.map(({ label }) => label)), FailureLinks.read(config)]);
  const view = ScorerResults.failures({ labels, windowDays: WINDOW_DAYS, now, rubricLabels });

  return {
    ...view,
    failures: view.failures.map((entry) => {
      const task = links.taskOf(entry.failure.subject);
      const linked = { ...entry, task: task || undefined };

      return entry.failure.source === 'session' ? { ...linked, learnings: links.learningsOf(entry.failure.subject) } : linked;
    }),
  };
}

/**
 * Prints the digest's JSON envelope on stdout, and only that. With `improvement`, its data also holds what a
 * self-improvement of that scorer starts from; a suite or scorer it cannot read prints an error envelope, its message on
 * stderr, and exits 1.
 */
async function print({ improvement }: { improvement?: { scorer: string; suite: string; proposal?: string } } = {}): Promise<void> {
  const config = await detectProjectConfig(undefined, undefined, { dryRun: true }) ?? (await requireInit({ dryRun: true })).localConfig;
  const view = await read(config);

  if (improvement === undefined) {
    console.log(JSON.stringify({ data: view }));

    return;
  }

  const { SelfImprovement } = await import('./self-improvement.js');
  const planned = await SelfImprovement.plan(config, { failures: view.failures, ...improvement });

  if ('code' in planned) {
    console.log(JSON.stringify({ error: planned }));
    // A workflow step that fails shows only its stderr.
    console.error(planned.message);
    process.exitCode = 1;

    return;
  }

  console.log(JSON.stringify({ data: { ...view, improvement: planned } }));
}

export const DigestFailures = { WINDOW_DAYS, read, print } as const;
