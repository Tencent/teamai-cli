/**
 * The Judging health panel of Workflow Runs: whether judging on this machine keeps up. It reads this machine's labels of
 * the last seven days, the marks of the passes of the runs Local runs lists, and the session launches the daily limit
 * counts. It opens or closes no mark.
 */
import type { Decider, JudgeFailureCode, ScoreLabel } from '../scorers/label.js';
import { LabelStore } from '../scorers/label-store.js';
import { Marks } from '../scorers/marks.js';
import { RunJudging, type RunJudgingState, type Unlabelled } from '../scorers/run-judging.js';
import { scopeScoring } from '../scorers/settings.js';
import type { LocalConfig } from '../types.js';
import type { RunState } from '../workflow/types.js';
import { listedRuns } from './workflow-runs.js';

const DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

/** The missing labels the panel lists, newest run first. */
const MISSING_LIMIT = 25;

/** A scorer of a listed pass without a label, and why; a scorer that sampling left out is not missing. */
export interface MissingLabel {
  run: string;
  workflow: string;
  alias?: string;
  step: string;
  pass: number;
  scorer: string;
  state: Exclude<Unlabelled, { kind: 'not_sampled' }>;
}

export interface JudgingHealth {
  /** Every label this machine wrote in the last seven days, by what decided it, and the judge tokens they record. */
  labels: { total: number; passed: number; byDecider: Partial<Record<Decider | 'hand', number>>; inputTokens: number; outputTokens: number };
  /** The scorers of the listed passes without a label, by why. */
  states: Record<Unlabelled['kind'], number>;
  /** The failed ones by code, the most first. */
  failures: Array<{ code: JudgeFailureCode; count: number }>;
  missing: MissingLabel[];
  /** Session launches on each of the last seven local days, oldest first, and the daily limit when the settings read. */
  sessions: { dailyLimit?: number; days: Array<{ day: string; launches: number }> };
}

function deciderOf(label: ScoreLabel): Decider | 'hand' {
  if (label.judge.kind === 'human') return 'hand';

  return label.source === 'workflow' ? label.decidedBy ?? 'judge' : 'judge';
}

function weekOf(labels: readonly ScoreLabel[], since: number): JudgingHealth['labels'] {
  const week: JudgingHealth['labels'] = { total: 0, passed: 0, byDecider: {}, inputTokens: 0, outputTokens: 0 };

  for (const label of labels.filter((one) => Date.parse(one.scoredAt) >= since)) {
    const by = deciderOf(label);
    week.total += 1;
    week.passed += label.passed ? 1 : 0;
    week.byDecider[by] = (week.byDecider[by] ?? 0) + 1;

    if (label.judge.kind === 'model') {
      week.inputTokens += label.judge.usage?.inputTokens ?? 0;
      week.outputTokens += label.judge.usage?.outputTokens ?? 0;
    }
  }

  return week;
}

const localDay = (at: Date): string => `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}-${String(at.getDate()).padStart(2, '0')}`;

/** Noon of each of the last seven local days, oldest first, so a launch counts in the day the daily limit counts it in. */
function lastDays(now: string): Date[] {
  return Array.from({ length: DAYS }, (_, index) => {
    const day = new Date(now);
    day.setDate(day.getDate() - (DAYS - 1 - index));
    day.setHours(12, 0, 0, 0);

    return day;
  });
}

/** A listed pass's scorer, keyed `step#pass` in its run's judging, as the missing labels list it. */
function missingLabel(run: RunState, key: string, scorer: string, state: MissingLabel['state']): MissingLabel {
  const at = key.lastIndexOf('#');
  const row: MissingLabel = { run: run.id, workflow: run.definition.name, step: key.slice(0, at), pass: Number(key.slice(at + 1)), scorer, state };

  if (run.definition.alias !== undefined) row.alias = run.definition.alias;

  return row;
}

/** The scorers of the passes of `runs` without a label: by why, the failed ones by code, and the first that sampling did not leave out. */
function unlabelledOfRuns(runs: readonly RunState[], judging: ReadonlyMap<string, RunJudgingState>): Pick<JudgingHealth, 'states' | 'failures' | 'missing'> {
  const states: JudgingHealth['states'] = { queued: 0, not_sampled: 0, judging: 0, waiting_ci: 0, lapsed: 0, failed: 0, expired: 0 };
  const failures = new Map<JudgeFailureCode, number>();
  const missing: MissingLabel[] = [];

  for (const run of runs) {
    for (const [key, pass] of judging.get(run.id)?.passes ?? []) {
      for (const { scorer, state } of pass.unlabelled) {
        states[state.kind] += 1;

        if (state.kind === 'failed') failures.set(state.code, (failures.get(state.code) ?? 0) + 1);

        if (state.kind !== 'not_sampled') missing.push(missingLabel(run, key, scorer, state));
      }
    }
  }

  return {
    states,
    failures: [...failures].map(([code, count]) => ({ code, count })).sort((left, right) => right.count - left.count),
    missing: missing.slice(0, MISSING_LIMIT),
  };
}

export async function judgingHealth(config: LocalConfig, now: string): Promise<JudgingHealth> {
  const runs = await listedRuns(config);

  const [labels, judging, scoring, days] = await Promise.all([
    LabelStore.local(config),
    RunJudging.of(config, runs, now),
    scopeScoring(config),
    Promise.all(lastDays(now).map(async (day) => ({ day: localDay(day), launches: await Marks.launchesToday(config, day.toISOString()) }))),
  ]);

  const sessions: JudgingHealth['sessions'] = { days };

  if (scoring.ok) sessions.dailyLimit = scoring.sessions.dailyLimit;

  return { labels: weekOf(labels, Date.parse(now) - DAYS * DAY_MS), ...unlabelledOfRuns(runs, judging), sessions };
}
