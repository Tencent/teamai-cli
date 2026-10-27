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
  | { kind: 'model'; tool: string; model?: { id: string; isReported: boolean; alias?: string } };

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

/** A group's value as the label recorded it. `isReported` is false for a model the tool did not report, only requested. */
type GroupValue = { value: string; isReported?: boolean; localChanges?: boolean };

const observed = (agent: RecordedAgent | undefined): AgentObservation | undefined => (agent && 'v' in agent ? agent : undefined);
const one = (value: string | undefined): GroupValue[] | undefined => (value === undefined ? undefined : [{ value }]);
const many = (values: readonly string[] | undefined): GroupValue[] | undefined => values?.map((value) => ({ value }));

/** The dimensions a cohort can be grouped by, in the order the page offers them. */
export const DIMENSIONS_OFFERED = ['tool', 'model', 'teamRevision', 'definition', 'role', 'project', 'tag', 'fingerprint', 'skill'] as const;
export type Dimension = (typeof DIMENSIONS_OFFERED)[number];

/**
 * The recorded configuration a cohort can be grouped by. Each reads the values a label counts under: undefined when
 * the label did not record that part, so it is `not recorded` and never guessed; [] when it recorded none, as a session
 * that loaded no team skill. A label listing two values counts under both.
 */
const DIMENSIONS: Record<Dimension, (entry: ViewedLabel) => GroupValue[] | undefined> = {
  tool: ({ agent }) => one(observed(agent)?.tool.name),
  model: ({ agent }) => {
    const model = observed(agent)?.model;
    if (model?.reported) return [{ value: model.reported, isReported: true }];
    return model?.requested ? [{ value: model.requested, isReported: false }] : undefined;
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
  /** Which failing labels to list: only those of the group with key `group`, the newest `limit` of them. */
  failing?: { group?: string; limit?: number };
};

/** How many failing labels a view lists unless asked for more. */
export const FAILING_PAGE = 25;

/** The most failing labels one answer lists, however many the page asks for. */
export const FAILING_MAX = 1000;

/** A failing label as the view lists it: never its subject's native session id, reasoning or prompt. */
export type FailingLabel = { author: string; scoredAt: string; label: string; skills?: string[] } & (
  | { source: 'session'; platform: string; sessionName?: string }
  | { source: 'workflow'; run: { id: string; step: string; pass: number; source?: 'local' | 'reported' } }
);

/**
 * The friction reminder per session run on this machine (#1182): `hinted` from the member's contribute state, by
 * session id, for the member's sessions that started in the last `days`. A session missing from `hinted` has no state
 * here.
 */
export type ReminderInput = { days: number; sessions: readonly string[]; hinted: ReadonlyMap<string, boolean> };

/** One row of the reminder table. `rate` is over `labelled` sessions only. */
export type ReminderRow = { reminder: 'yes' | 'no' | 'not recorded'; sessions: number; labelled: number; passed: number; rate: number | null };

/** The labels of a measurement that stored one value, with the score the value stood for. */
export type ValueCount = { label: string; score: number; n: number };

/** One UTC week of the trend, named by its Monday. */
export type TrendWeek = Stats & { week: string };

export type SelectedCohort = {
  /**
   * The cohort with its counts and weekly trend over the window, and its labels by stored value, highest score first:
   * what a pass rate folds together.
   */
  cohort: CohortSummary & { values: ValueCount[] };
  groupBy?: Dimension;
  groups?: Group[];
  split?: Split;
  /** The newest failing labels the query asked for, and how many it matches. */
  failing: { labels: FailingLabel[]; total: number };
  /** Only for a session cohort on a dashboard that read this machine's reminder state: the sessions of the last `days`. */
  reminders?: { days: number; rows: ReminderRow[] };
};

export type ScorerResultsView = {
  window: { days: number; from: string; to: string };
  scorers: ScorerSummary[];
  selected?: SelectedCohort;
};

const DAY_MS = 24 * 60 * 60 * 1000;

/** The windows a view offers, in days of `scoredAt`. */
export const SCORER_WINDOWS = [7, 30, 90, 180] as const;

function judgeCohort(judge: ScoreLabel['judge']): JudgeCohort {
  switch (judge.kind) {
    case 'human':
      return { kind: 'human' };
    case 'model': {
      const id = judge.model?.reported ?? judge.model?.requested;
      return { kind: 'model', tool: judge.tool, ...(id ? { model: { id, isReported: judge.model?.reported !== undefined } } : {}) };
    }
    default: {
      const unhandled: never = judge;
      return unhandled;
    }
  }
}

/** A model judge with the team alias its newest label named it by, which a cohort shows but never tells judges apart by. */
function withAlias(judge: JudgeCohort, newestFirst: readonly ViewedLabel[]): JudgeCohort {
  if (judge.kind !== 'model' || !judge.model) return judge;
  const newest = newestFirst[0]?.label.judge;
  const alias = newest?.kind === 'model' ? newest.model?.alias : undefined;
  return alias ? { ...judge, model: { ...judge.model, alias } } : judge;
}

type CohortIdentity = Omit<Cohort, 'rubric'> & { rubric: { sourceHash: string } };

/** Each label's cohort and key, kept for as long as the label is: a caller that keeps its labels between views reuses them. */
const identities = new WeakMap<ScoreLabel, { cohort: CohortIdentity; key: string }>();

function identityOf(label: ScoreLabel): { cohort: CohortIdentity; key: string } {
  const kept = identities.get(label);
  if (kept) return kept;
  const identity = { cohort: cohortOf(label), key: labelId(label) };
  identities.set(label, identity);
  return identity;
}

function cohortOf(label: ScoreLabel): CohortIdentity {
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
    const { key } = identityOf(entry.label);
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
function trend({ labels, from, to }: { labels: readonly ViewedLabel[]; from: string; to: string }): TrendWeek[] {
  const byWeek = new Map<string, ViewedLabel[]>();
  for (const entry of labels) {
    const week = weekOf(entry.label.scoredAt);
    const members = byWeek.get(week) ?? [];
    members.push(entry);
    byWeek.set(week, members);
  }
  const weeks: TrendWeek[] = [];
  for (let week = weekOf(from); week <= to.slice(0, 10); week = new Date(Date.parse(`${week}T00:00:00Z`) + 7 * DAY_MS).toISOString().slice(0, 10)) {
    weeks.push({ week, ...stats(byWeek.get(week) ?? []) });
  }
  return weeks;
}

/** Group keys, built from the group's parts so a recorded value can never read as another value or as `none`. */
function groupKey(value: GroupValue): string {
  return JSON.stringify(['value', value.value, value.isReported ?? null, value.localChanges ?? false]);
}
const NONE_KEY = JSON.stringify(['none']);
const NOT_RECORDED_KEY = JSON.stringify(['not recorded']);

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
  if (recorded === undefined) return [NOT_RECORDED_KEY];
  return recorded.length === 0 ? [NONE_KEY] : recorded.map(groupKey);
}

function failingLabel(entry: ViewedLabel): FailingLabel {
  const { label } = entry;
  const shared = {
    author: entry.author,
    scoredAt: label.scoredAt,
    label: label.label,
    ...label.used?.skills.length ? { skills: label.used.skills } : {},
  };
  switch (label.source) {
    case 'session':
      return { ...shared, source: 'session', platform: label.subject.platform, ...entry.sessionName ? { sessionName: entry.sessionName } : {} };
    case 'workflow':
      return { ...shared, source: 'workflow', run: { id: label.subject.runId, step: label.subject.step, pass: label.subject.pass, ...entry.runSource ? { source: entry.runSource } : {} } };
    default: {
      const unhandled: never = label;
      return unhandled;
    }
  }
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
  if (none.length > 0) counted.push({ key: NONE_KEY, kind: 'none', ...counts(none) });
  if (notRecorded.length > 0) counted.push({ key: NOT_RECORDED_KEY, kind: 'not recorded', ...counts(notRecorded) });
  return counted;
}

/** The values `labels` stored, as stored: the scorer file is never read to rename, add or reorder them. */
function valueCounts(labels: readonly ViewedLabel[]): ValueCount[] {
  const counts = new Map<string, ValueCount>();
  for (const { label } of labels) {
    const key = JSON.stringify([label.label, label.score]);
    const count = counts.get(key) ?? { label: label.label, score: label.score, n: 0 };
    count.n += 1;
    counts.set(key, count);
  }
  return [...counts.values()].sort((left, right) => right.score - left.score || left.label.localeCompare(right.label));
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

  /** The team revisions `labels` record their work ran on: what a split at a team commit asks the team clone about. */
  revisions(labels: readonly ViewedLabel[]): Set<string> {
    return new Set(labels.flatMap(({ agent }) => {
      const revision = observed(agent)?.team?.revision;
      return revision === undefined ? [] : [revision];
    }));
  },

  /** The results of every scorer in `labels`, with the selected scorer's cohort counted over the window. */
  of({ labels, query, now, reminders }: { labels: readonly ViewedLabel[]; query: ScorerResultsQuery; now: Date; reminders?: ReminderInput }): ScorerResultsView {
    const window = ScorerResults.window(query.windowDays, now);
    const { from, to } = window;
    const inWindow = (entry: ViewedLabel) => entry.label.scoredAt >= from && entry.label.scoredAt <= to;

    const byCohort = new Map<string, { cohort: CohortIdentity; all: ViewedLabel[] }>();
    for (const entry of current(labels)) {
      const { cohort } = identityOf(entry.label);
      const group = byCohort.get(cohort.id) ?? { cohort, all: [] };
      group.all.push(entry);
      byCohort.set(cohort.id, group);
    }

    const byScorer = new Map<string, Array<{ summary: CohortSummary; all: ViewedLabel[] }>>();
    for (const { cohort, all } of byCohort.values()) {
      const newestFirst = [...all].sort((left, right) => right.label.scoredAt.localeCompare(left.label.scoredAt));
      const teamRevision = newestFirst.find(({ label }) => label.rubric.teamRevision)?.label.rubric.teamRevision;
      const summary: CohortSummary = {
        ...cohort,
        rubric: { sourceHash: cohort.rubric.sourceHash, ...(teamRevision ? { teamRevision } : {}) },
        judge: withAlias(cohort.judge, newestFirst),
        stats: stats(all.filter(inWindow)),
        trend: trend({ labels: all.filter(inWindow), from, to }),
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
    const group = query.failing?.group;
    const inGroup = (entry: ViewedLabel) => !groupBy || group === undefined || groupKeys(entry, groupBy).includes(group);
    const failing = counted.filter((entry) => !entry.label.passed && inGroup(entry))
      .sort((left, right) => right.label.scoredAt.localeCompare(left.label.scoredAt));
    return {
      window,
      scorers,
      selected: {
        cohort: { ...summary, values: valueCounts(counted) },
        ...(groupBy ? { groupBy, groups: groups(counted, groupBy, split?.sideOf) } : {}),
        ...(split ? { split: { commit: split.commit, ...splitStats(counted, split.sideOf) } } : {}),
        failing: { labels: failing.slice(0, query.failing?.limit ?? FAILING_PAGE).map(failingLabel), total: failing.length },
        ...(reminders && summary.source === 'session' ? { reminders: { days: reminders.days, rows: reminderRows(chosen.all, reminders) } } : {}),
      },
    };
  },
} as const;
