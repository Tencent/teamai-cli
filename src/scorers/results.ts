/**
 * Scorer results (#1182): pass rates of score labels, one measurement at a time. A measurement, the cohort, fixes the
 * scorer, the rubric version, the source, the run mode and the judge, so labels that differ in any of these are never
 * summed. Pure: callers read the labels and what their subjects ran as, and this module only counts them.
 */
import { createHash } from 'node:crypto';
import type { AgentObservation, RecordedAgent } from '../agent-observation.js';
import type { RunMode } from '../launch-context.js';
import { canonicalJson } from '../utils/canonical-json.js';
import { labelId, type ScoreLabel } from './label.js';

/** A label as the view reads it: who published it, and what the judged work ran as when that was recorded. */
export type ViewedLabel = {
  label: ScoreLabel;
  /** The member whose label file holds it. */
  author: string;
  /** A session label's own `agent`, or the `agent` of the pass a workflow label judges. */
  agent?: RecordedAgent;
  /** The name of the pushed session a session label judges, when the team archive holds it. */
  sessionName?: string;
  /** Where the run a workflow label judges is listed: this machine's runs, or the team's records. */
  runSource?: 'local' | 'reported';
};

/** A judge as a cohort tells judges apart: a model judge by its tool and the model it recorded. */
export type JudgeCohort =
  | { kind: 'human' }
  | { kind: 'model'; tool: string; model?: { id: string; reported: boolean; alias?: string } };

/** One measurement. `runMode` is null for labels that recorded none. */
export type Cohort = {
  id: string;
  scorer: string;
  rubric: { sourceHash: string; teamRevision?: string };
  source: ScoreLabel['source'];
  runMode: RunMode | null;
  judge: JudgeCohort;
};

/** Labels counted together. `rate` is null when there are none: no labels is a gap, never 0%. */
export type Stats = { n: number; passed: number; failed: number; rate: number | null };

/** A cohort with its counts over the window and its weekly trend. */
export type CohortSummary = Cohort & { stats: Stats; trend: TrendWeek[]; lastScoredAt: string };

export type ScorerSummary = { scorer: string; defaultCohort: string; cohorts: CohortSummary[] };

/** A group's value as the label recorded it. `reported` is false for a model the tool did not report, only requested. */
type GroupValue = { value: string; reported?: boolean; localChanges?: boolean };

const observed = (agent: RecordedAgent | undefined): AgentObservation | undefined => (agent && 'v' in agent ? agent : undefined);
const one = (value: string | undefined): GroupValue[] | undefined => (value === undefined ? undefined : [{ value }]);
const many = (values: readonly string[] | undefined): GroupValue[] | undefined => values?.map((value) => ({ value }));

/**
 * The recorded configuration a cohort can be grouped by. Each reads the values a label counts under: undefined when
 * the label did not record that part, so it is `not recorded` and never guessed; [] when it recorded none, as a session
 * that loaded no team skill. A label listing two values counts under both.
 */
/** The dimensions a cohort can be grouped by, in the order the page offers them. */
export const DIMENSIONS_OFFERED = ['tool', 'model', 'teamRevision', 'definition', 'role', 'project', 'tag', 'fingerprint', 'skill'] as const;
export type Dimension = (typeof DIMENSIONS_OFFERED)[number];

export function isDimension(name: string): name is Dimension {
  return DIMENSIONS_OFFERED.some((dimension) => dimension === name);
}

const DIMENSIONS: Record<Dimension, (entry: ViewedLabel) => GroupValue[] | undefined> = {
  tool: ({ agent }) => one(observed(agent)?.tool.name),
  model: ({ agent }) => {
    const model = observed(agent)?.model;
    if (model?.reported) return [{ value: model.reported, reported: true }];
    return model?.requested ? [{ value: model.requested, reported: false }] : undefined;
  },
  teamRevision: ({ agent }) => {
    const team = observed(agent)?.team;
    return team ? [{ value: team.revision, ...(team.localChanges ? { localChanges: true } : {}) }] : undefined;
  },
  definition: ({ agent }) => one(agent?.definition?.name),
  role: ({ agent }) => {
    const selection = observed(agent)?.team?.selection;
    return selection ? many(selection.primaryRole ? [selection.primaryRole] : []) : undefined;
  },
  project: ({ agent }) => {
    const selection = observed(agent)?.team?.selection;
    return selection ? many(selection.projects ?? []) : undefined;
  },
  tag: ({ agent }) => {
    const selection = observed(agent)?.team?.selection;
    return selection ? many(selection.subscribedTags ?? []) : undefined;
  },
  fingerprint: ({ agent }) => one(observed(agent)?.fingerprint),
  skill: ({ label }) => many(label.used?.skills),
};

/** Which side of a team commit a label's team revision is on: whether that revision contains the commit. */
export type Side = 'before' | 'after';

/** A cohort's labels split at a team commit. Labels on no revision this clone has are `notRecorded`. */
export type Split = { commit: string; before: Stats; after: Stats; notRecorded: Stats };

/** The labels of a cohort that recorded one value of a dimension, or none, or did not record it. */
export type Group = { key: string; stats: Stats; split?: Omit<Split, 'commit'> } & (
  | ({ kind: 'value' } & GroupValue)
  | { kind: 'none' }
  | { kind: 'not recorded' }
);

export type ScorerResultsQuery = {
  windowDays: number;
  scorer?: string;
  cohort?: string;
  groupBy?: Dimension;
  /** The side of `commit` each team revision is on, as the caller's team clone answers it. */
  split?: { commit: string; sideOf: ReadonlyMap<string, Side> };
};

/**
 * A failing label as the view lists it: never its subject's native session id, reasoning or prompt. `groups` are the
 * keys of the groups it counts under, when the view is grouped.
 */
export type FailingLabel = {
  author: string;
  scoredAt: string;
  label: string;
  source: ScoreLabel['source'];
  platform?: string;
  skills?: string[];
  sessionName?: string;
  run?: { id: string; step: string; pass: number; source: 'local' | 'reported' };
  groups?: string[];
};

/**
 * The friction reminder per session run on this machine (#1182): `hinted` from the member's contribute state, by
 * session id, for the member's sessions that started in the window. A session missing from `hinted` has no state here.
 */
export type ReminderInput = { sessions: readonly string[]; hinted: ReadonlyMap<string, boolean> };

/** One row of the reminder table. `rate` is over `labelled` sessions only. */
export type ReminderRow = { reminder: 'yes' | 'no' | 'not recorded'; sessions: number; labelled: number; passed: number; rate: number | null };

/** The most failing labels a view lists. */
const FAILING_LIMIT = 100;

/** One UTC week of the trend, named by its Monday. */
export type TrendWeek = Stats & { week: string };

export type SelectedCohort = {
  cohort: CohortSummary;
  headline: Stats;
  trend: TrendWeek[];
  groupBy?: Dimension;
  groups?: Group[];
  split?: Split;
  failing: FailingLabel[];
  /** Only for a session cohort on a dashboard that read this machine's reminder state. */
  reminders?: ReminderRow[];
};

export type ScorerResultsView = {
  window: { days: number; from: string; to: string };
  scorers: ScorerSummary[];
  selected?: SelectedCohort;
};

const DAY_MS = 24 * 60 * 60 * 1000;

function judgeCohort(judge: ScoreLabel['judge']): JudgeCohort {
  if (judge.kind === 'human') return { kind: 'human' };
  const id = judge.model?.reported ?? judge.model?.requested;
  const alias = judge.model?.alias;
  return {
    kind: 'model',
    tool: judge.tool,
    ...(id ? { model: { id, reported: judge.model?.reported !== undefined, ...(alias ? { alias } : {}) } } : {}),
  };
}

function cohortOf(label: ScoreLabel): Omit<Cohort, 'rubric'> & { rubric: { sourceHash: string } } {
  const identity = {
    scorer: label.scorer,
    rubric: { sourceHash: label.rubric.sourceHash },
    source: label.source,
    runMode: label.runMode ?? null,
    judge: judgeCohort(label.judge),
  };
  return { id: createHash('sha256').update(canonicalJson(identity)).digest('hex').slice(0, 16), ...identity };
}

/**
 * The newest `scoredAt` per label key, kept before any window applies, so a label rescored in a later month counts once,
 * when it was rescored.
 */
function current(labels: readonly ViewedLabel[]): ViewedLabel[] {
  const kept = new Map<string, ViewedLabel>();
  for (const entry of labels) {
    const key = labelId(entry.label);
    const other = kept.get(key);
    if (!other || entry.label.scoredAt > other.label.scoredAt) kept.set(key, entry);
  }
  return [...kept.values()];
}

/** The Monday, as YYYY-MM-DD, of the UTC week holding `iso`. */
function weekOf(iso: string): string {
  const day = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
  day.setUTCDate(day.getUTCDate() - ((day.getUTCDay() + 6) % 7));
  return day.toISOString().slice(0, 10);
}

/** Every week the window touches, oldest first, each with its own labels. */
function trend(labels: readonly ViewedLabel[], from: string, to: string): TrendWeek[] {
  const weeks: TrendWeek[] = [];
  for (let week = weekOf(from); week <= to.slice(0, 10); week = new Date(Date.parse(`${week}T00:00:00Z`) + 7 * DAY_MS).toISOString().slice(0, 10)) {
    weeks.push({ week, ...stats(labels.filter(({ label }) => weekOf(label.scoredAt) === week)) });
  }
  return weeks;
}

function groupKey(value: GroupValue): string {
  return `${value.reported === false ? 'requested:' : ''}${value.value}${value.localChanges ? '+local' : ''}`;
}

function splitStats(labels: readonly ViewedLabel[], sideOf: ReadonlyMap<string, Side>): Omit<Split, 'commit'> {
  const side = (entry: ViewedLabel) => {
    const revision = observed(entry.agent)?.team?.revision;
    return revision === undefined ? undefined : sideOf.get(revision);
  };
  return {
    before: stats(labels.filter((entry) => side(entry) === 'before')),
    after: stats(labels.filter((entry) => side(entry) === 'after')),
    notRecorded: stats(labels.filter((entry) => side(entry) === undefined)),
  };
}

function groupKeys(entry: ViewedLabel, dimension: Dimension): string[] {
  const recorded = DIMENSIONS[dimension](entry);
  if (recorded === undefined) return ['not recorded'];
  return recorded.length === 0 ? ['none'] : recorded.map(groupKey);
}

function failingLabel(entry: ViewedLabel, groupBy: Dimension | undefined): FailingLabel {
  const { label } = entry;
  const shared = {
    author: entry.author,
    scoredAt: label.scoredAt,
    label: label.label,
    source: label.source,
    ...label.used?.skills.length ? { skills: label.used.skills } : {},
    ...groupBy ? { groups: groupKeys(entry, groupBy) } : {},
  };
  if (label.source === 'session') return { ...shared, platform: label.subject.platform, ...entry.sessionName ? { sessionName: entry.sessionName } : {} };
  return { ...shared, run: { id: label.subject.runId, step: label.subject.step, pass: label.subject.pass, source: entry.runSource ?? 'reported' } };
}

/** The reminder table of a session cohort: each session counts once, under the label of this cohort it has. */
function reminderRows(labels: readonly ViewedLabel[], input: ReminderInput): ReminderRow[] {
  const verdicts = new Map(labels.flatMap(({ label }) => (label.source === 'session' ? [[label.subject.sessionId, label.passed] as const] : [])));
  const empty = (reminder: ReminderRow['reminder']) => ({ reminder, sessions: 0, labelled: 0, passed: 0 });
  const rows = { yes: empty('yes'), no: empty('no'), 'not recorded': empty('not recorded') };
  for (const session of new Set(input.sessions)) {
    const hinted = input.hinted.get(session);
    const row = rows[hinted === undefined ? 'not recorded' : hinted ? 'yes' : 'no'];
    row.sessions += 1;
    const passed = verdicts.get(session);
    if (passed === undefined) continue;
    row.labelled += 1;
    if (passed) row.passed += 1;
  }
  return Object.values(rows).map((row) => ({ ...row, rate: row.labelled === 0 ? null : row.passed / row.labelled }));
}

/** The groups of `labels` by `dimension`: values with the most labels first, then `none`, then `not recorded`. */
function groups(labels: readonly ViewedLabel[], dimension: Dimension, sideOf: ReadonlyMap<string, Side> | undefined): Group[] {
  const values = new Map<string, { value: GroupValue; labels: ViewedLabel[] }>();
  const none: ViewedLabel[] = [];
  const notRecorded: ViewedLabel[] = [];
  for (const entry of labels) {
    const recorded = DIMENSIONS[dimension](entry);
    if (recorded === undefined) notRecorded.push(entry);
    else if (recorded.length === 0) none.push(entry);
    for (const value of recorded ?? []) {
      const key = groupKey(value);
      const group = values.get(key) ?? { value, labels: [] };
      group.labels.push(entry);
      values.set(key, group);
    }
  }
  const counts = (members: readonly ViewedLabel[]) => ({ stats: stats(members), ...sideOf ? { split: splitStats(members, sideOf) } : {} });
  const counted: Group[] = [...values].map(([key, { value, labels: members }]) => ({ key, kind: 'value' as const, ...value, ...counts(members) }))
    .sort((left, right) => right.stats.n - left.stats.n || left.key.localeCompare(right.key));
  if (none.length > 0) counted.push({ key: 'none', kind: 'none', ...counts(none) });
  if (notRecorded.length > 0) counted.push({ key: 'not recorded', kind: 'not recorded', ...counts(notRecorded) });
  return counted;
}

function stats(labels: readonly ViewedLabel[]): Stats {
  const passed = labels.filter(({ label }) => label.passed).length;
  return { n: labels.length, passed, failed: labels.length - passed, rate: labels.length === 0 ? null : passed / labels.length };
}

function newest(labels: readonly ViewedLabel[]): string {
  return labels.reduce((latest, { label }) => (label.scoredAt > latest ? label.scoredAt : latest), '');
}

/**
 * The cohort a scorer opens on: the newest rubric whose labels carry `rubric.teamRevision`, so a member's uncommitted
 * draft does not become the team's view, else the rubric scored last. Within it, the cohort with the most labels in the
 * window, then the one scored last.
 */
function defaultCohort(cohorts: ReadonlyArray<{ summary: CohortSummary; all: ViewedLabel[] }>): CohortSummary | undefined {
  const committed = cohorts.flatMap(({ summary, all }) => all.filter(({ label }) => label.rubric.teamRevision).map(({ label }) => ({ hash: summary.rubric.sourceHash, at: label.scoredAt })));
  const anyLabel = cohorts.map(({ summary }) => ({ hash: summary.rubric.sourceHash, at: summary.lastScoredAt }));
  const rubric = (committed.length > 0 ? committed : anyLabel).reduce<{ hash: string; at: string } | undefined>((best, entry) => (!best || entry.at > best.at ? entry : best), undefined);
  return cohorts.map(({ summary }) => summary)
    .filter((summary) => summary.rubric.sourceHash === rubric?.hash)
    .sort((left, right) => right.stats.n - left.stats.n || right.lastScoredAt.localeCompare(left.lastScoredAt))[0];
}

export const ScorerResults = {
  /** The `days` before `now`, as the view counts them: by when labels were scored, not when the work happened. */
  window(days: number, now: Date): ScorerResultsView['window'] {
    return { days, from: new Date(now.getTime() - days * DAY_MS).toISOString(), to: now.toISOString() };
  },

  /** The results of every scorer in `labels`, with the selected scorer's cohort counted over the window. */
  of({ labels, query, now, reminders }: { labels: readonly ViewedLabel[]; query: ScorerResultsQuery; now: Date; reminders?: ReminderInput }): ScorerResultsView {
    const window = ScorerResults.window(query.windowDays, now);
    const { from, to } = window;
    const inWindow = (entry: ViewedLabel) => entry.label.scoredAt >= from && entry.label.scoredAt <= to;

    const byCohort = new Map<string, { cohort: ReturnType<typeof cohortOf>; all: ViewedLabel[] }>();
    for (const entry of current(labels)) {
      const cohort = cohortOf(entry.label);
      const group = byCohort.get(cohort.id) ?? { cohort, all: [] };
      group.all.push(entry);
      byCohort.set(cohort.id, group);
    }

    const byScorer = new Map<string, Array<{ summary: CohortSummary; all: ViewedLabel[] }>>();
    for (const { cohort, all } of byCohort.values()) {
      const teamRevision = all.filter(({ label }) => label.rubric.teamRevision)
        .sort((left, right) => right.label.scoredAt.localeCompare(left.label.scoredAt))[0]?.label.rubric.teamRevision;
      const summary: CohortSummary = {
        ...cohort,
        rubric: { sourceHash: cohort.rubric.sourceHash, ...(teamRevision ? { teamRevision } : {}) },
        stats: stats(all.filter(inWindow)),
        trend: trend(all.filter(inWindow), from, to),
        lastScoredAt: newest(all),
      };
      byScorer.set(cohort.scorer, [...byScorer.get(cohort.scorer) ?? [], { summary, all }]);
    }

    const scorers: ScorerSummary[] = [];
    for (const [scorer, cohorts] of [...byScorer].sort(([left], [right]) => left.localeCompare(right))) {
      const opened = defaultCohort(cohorts);
      if (!opened) continue;
      const ordered = cohorts.map(({ summary }) => summary)
        .sort((left, right) => Number(right.id === opened.id) - Number(left.id === opened.id) || right.lastScoredAt.localeCompare(left.lastScoredAt));
      scorers.push({ scorer, defaultCohort: opened.id, cohorts: ordered });
    }

    const scorer = scorers.find((summary) => summary.scorer === query.scorer) ?? scorers[0];
    const cohortId = scorer?.cohorts.some((cohort) => cohort.id === query.cohort) ? query.cohort : scorer?.defaultCohort;
    const chosen = cohortId ? byCohort.get(cohortId) : undefined;
    const summary = scorer?.cohorts.find((cohort) => cohort.id === cohortId);
    if (!chosen || !summary) return { window, scorers };
    const counted = chosen.all.filter(inWindow);
    const { groupBy, split } = query;
    const failing = counted.filter(({ label }) => !label.passed)
      .sort((left, right) => right.label.scoredAt.localeCompare(left.label.scoredAt))
      .slice(0, FAILING_LIMIT)
      .map((entry) => failingLabel(entry, groupBy));
    return {
      window,
      scorers,
      selected: {
        cohort: summary,
        headline: stats(counted),
        trend: trend(counted, from, to),
        ...(groupBy ? { groupBy, groups: groups(counted, groupBy, split?.sideOf) } : {}),
        ...(split ? { split: { commit: split.commit, ...splitStats(counted, split.sideOf) } } : {}),
        failing,
        ...(reminders && summary.source === 'session' ? { reminders: reminderRows(chosen.all, reminders) } : {}),
      },
    };
  },
} as const;
