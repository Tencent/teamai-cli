/**
 * Judged once: a mark per scorer and subject in `<dataHome>/scores/marks.jsonl` says whether automatic judging still
 * starts it. Each line is a whole mark as it was written, and the newest line of a key is its mark; a line that opens a
 * mark is also the launch the daily limit counts. Lines are only appended, under `scores/marks.lock`, so parallel
 * launches in one data home see each other's marks. A line that does not parse, such as a torn last one, is skipped.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { ConfinedUsageSchema, type ConfinedUsage } from '../tool-launch/confined-level.js';
import type { LocalConfig } from '../types.js';
import { pathExists, readFileSafe, writeFileAtomic } from '../utils/fs.js';
import { carriedMarks, type CarriedMark } from './attempts-upgrade.js';
import { scoresDir, scoresLocked } from './home.js';
import { JUDGE_FAILURES, type JudgeFailureCode, type RunSubject } from './label.js';
import { Subject } from './subject.js';

/** The fourth lapse closes a mark. */
export const MARK_LAPSES = 4;

/** A pass is not judged automatically once its run has not changed for this long, nor this long after it was asked for. */
export const MARK_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

export const DEMANDS = ['auto', 'named'] as const;

/** `named`: someone asked for this subject, so a closed mark opens again and the daily limit counts it but never refuses it. */
export type Demand = (typeof DEMANDS)[number];

/** A pass is keyed by scorer and subject; a session by its rubric too, so a new rubric of the scorer is judged of its own. */
export type MarkKey =
  | { scorer: string; subject: Extract<Subject, { kind: 'run' }>; sourceHash?: never }
  | { scorer: string; subject: Exclude<Subject, { kind: 'run' }>; sourceHash: string };

/**
 * `open`: the `teamai-score` run `run` launched it and has not ended. `waiting`: its group waits for CI, which is no
 * lapse. `lapsed`: the run that launched it ended with it still open, `lapses` times; automatic judging starts it again
 * until the fourth. A run that ended before a judge attempt of its group ran counts no lapse, until 14 days after the
 * mark first opened. `expired`: a pass whose run last changed more than 14 days ago, or that long after it was asked for.
 */
export type MarkState =
  | { kind: 'unmarked' }
  | { kind: 'open'; at: string; run: string; group: string; demand: Demand }
  | { kind: 'waiting' }
  | { kind: 'lapsed'; lapses: number }
  | { kind: 'labelled' }
  /** `usage`: what the judge call spent, when a judge ran and its tool reported it. */
  | { kind: 'failed'; code: JudgeFailureCode; usage?: ConfinedUsage }
  | { kind: 'expired' };

/** What a write or a settle of the launch says: a label, a failed attempt, or CI that has not finished. */
export type MarkOutcome = { kind: 'labelled' } | { kind: 'failed'; code: JudgeFailureCode; usage?: ConfinedUsage } | { kind: 'waiting' };

/** What the store needs of a run: whether it ended, when it last changed, and which groups it ran a judge attempt of. */
export interface RunStatus {
  ended: boolean;
  changedAt: string;
  /** Whether the run leased a judge attempt of a group with `scorer` on `subject`, the formatted subject, whatever became of it after. */
  judgeRan: (subject: string, scorer: string) => boolean;
}

/** A run of this machine by id, or undefined when it is gone. */
export type ReadRun = (runId: string) => Promise<RunStatus | undefined>;

export interface MarkFacts {
  now: string;
  readRun: ReadRun;
}

export interface Launch {
  /** The `teamai-score` run that launches the groups: its end without a write or a settle is a lapse. */
  run: string;
  demand: Demand;
  /** Each group is one judge launch, so it counts once toward the daily limit. */
  groups: ReadonlyArray<{ group: string; keys: readonly MarkKey[] }>;
  /** Session launches a local day may start. */
  dailyLimit?: number;
}

export type Opened =
  | { status: 'done'; opened: Array<{ group: string; keys: MarkKey[] }>; skipped: Array<{ key: MarkKey; state: MarkState }>; limited: boolean }
  | { status: 'busy' };

const Mark = { scorer: z.string().min(1), subject: z.string().min(1), sourceHash: z.string().min(1).optional(), at: z.string().min(1) };
const Restart = { lapses: z.number().int().min(0).max(MARK_LAPSES - 1), requestedAt: z.string().optional(), firstOpenedAt: z.string().optional() };

const LineSchema = z.discriminatedUnion('state', [
  /** `uncounted`: it starts again a mark whose run ended before its judge ran, so it spends no daily-limit slot. */
  z.object({ ...Mark, ...Restart, state: z.literal('open'), run: z.string().min(1), group: z.string().min(1), demand: z.enum(DEMANDS), uncounted: z.literal(true).optional() }),
  z.object({ ...Mark, ...Restart, state: z.literal('waiting') }),
  /** Open judge work an earlier teamai's attempts left, carried over on the upgrade: started again as a lapse. */
  z.object({ ...Mark, ...Restart, state: z.literal('carried') }),
  z.object({ ...Mark, state: z.literal('labelled') }),
  z.object({ ...Mark, state: z.literal('failed'), code: z.enum(JUDGE_FAILURES), usage: ConfinedUsageSchema.optional() }),
]);

type Line = z.infer<typeof LineSchema>;

type StateOf<TLine> = TLine extends unknown ? Omit<TLine, keyof typeof Mark> : never;

/** A line without the key and time every line has: what one state adds. */
type LineState = StateOf<Line>;

/**
 * What a next automatic launch carries on: the lapses so far, when the mark was last asked for, and when it first opened
 * since it was fresh or asked for. Absent on a mark opened before teamai kept it.
 */
interface Restart {
  lapses: number;
  requestedAt?: string;
  firstOpenedAt?: string;
}

/** Where a mark that never lapsed, or whose lapses a label or a failure ended, starts again from. */
const FRESH: Restart = { lapses: 0 };

/** A mark as its newest line leaves it; `uncounted` when it lapsed without a lapse counted, so its next start spends no slot. */
interface Derived {
  state: MarkState;
  restart: Restart & { uncounted?: true };
}

function marksFile(config: LocalConfig): string {
  return path.join(scoresDir(config), 'marks.jsonl');
}

/** The marks the judge attempts of an earlier teamai left, written once; it being there says the upgrade ran. */
function carriedFile(config: LocalConfig): string {
  return path.join(scoresDir(config), 'marks-carried.jsonl');
}

/** A session launch's slot of the day: a group of one subject in one root run, so a batch counts once and each session once. */
function slotOf(run: string, group: string, key: MarkKey): string {
  return `${run}\n${group}\n${Subject.format(key.subject)}`;
}

function idOf(key: MarkKey): string {
  return JSON.stringify([key.scorer, key.sourceHash ?? null, Subject.format(key.subject)]);
}

/** A scorer's marks of one subject, whatever rubric each is for: the newest of them is the one automatic judging goes on with. */
function scorerOf(key: MarkKey): string {
  return JSON.stringify([key.scorer, Subject.format(key.subject)]);
}

function keyOf(line: Line): MarkKey | undefined {
  const subject = Subject.parse(line.subject);

  if (!subject.ok) return undefined;

  if (subject.subject.kind === 'run') return line.sourceHash === undefined ? { scorer: line.scorer, subject: subject.subject } : undefined;

  return line.sourceHash === undefined ? undefined : { scorer: line.scorer, sourceHash: line.sourceHash, subject: subject.subject };
}

function lineOf(key: MarkKey, at: string, state: LineState): Line {
  const subject = Subject.format(key.subject);

  return key.sourceHash === undefined ? { scorer: key.scorer, subject, at, ...state } : { scorer: key.scorer, subject, sourceHash: key.sourceHash, at, ...state };
}

function parsedLine(text: string): { key: MarkKey; line: Line } | undefined {
  try {
    const parsed = LineSchema.safeParse(JSON.parse(text));

    if (!parsed.success) return undefined;
    const key = keyOf(parsed.data);

    return key ? { key, line: parsed.data } : undefined;
  } catch {
    return undefined;
  }
}

const localDay = (at: string) => new Date(at).toDateString();

function carriedLine(key: MarkKey, mark: CarriedMark, at: string): Line {
  switch (mark.kind) {
    case 'labelled':
      return lineOf(key, at, { state: 'labelled' });
    case 'failed':
      return lineOf(key, at, { state: 'failed', code: mark.code });
    case 'open': {
      const restart: Restart = { lapses: Math.min(mark.lapses, MARK_LAPSES - 1) };

      if (mark.requestedAt !== undefined) restart.requestedAt = mark.requestedAt;

      return lineOf(key, at, { state: 'carried', ...restart });
    }

    default: {
      const unhandled: never = mark;

      return unhandled;
    }
  }
}

/**
 * The marks carried over from judge attempts, carried at `now` on the first read. Undefined where nothing was ever
 * scored: there is nothing to carry, and nothing is written.
 */
async function readCarried(config: LocalConfig, now: string): Promise<string | undefined> {
  const kept = await readFileSafe(carriedFile(config));

  if (kept !== null) return kept;

  if (!await pathExists(scoresDir(config))) return undefined;
  const text = (await carriedMarks(config, now)).map(({ key, mark }) => `${JSON.stringify(carriedLine(key, mark, now))}\n`).join('');
  await writeFileAtomic(carriedFile(config), text);

  return text;
}

/** Every mark of this data home: the newest line per key in the order keys first appear, and every launch. */
async function readLedger(config: LocalConfig, now: string) {
  const carried = await readCarried(config, now) ?? '';
  const text = await readFileSafe(marksFile(config)) ?? '';
  const newest = new Map<string, { key: MarkKey; line: Line }>();
  const latest = new Map<string, { key: MarkKey; line: Line }>();
  const launches: Array<{ key: MarkKey; line: Extract<Line, { state: 'open' }> }> = [];

  for (const mark of [...carried.split('\n'), ...text.split('\n')].flatMap((one) => parsedLine(one) ?? [])) {
    newest.set(idOf(mark.key), mark);
    latest.set(scorerOf(mark.key), mark);

    if (mark.line.state === 'open') launches.push({ key: mark.key, line: mark.line });
  }

  /** Session launches of `now`'s local day, by run, group and subject: a group of one subject is one launch, and an uncounted start none. */
  const slotsOn = (today: string) => new Set(launches.flatMap(({ key, line }) => (key.subject.kind !== 'run' && line.uncounted !== true && localDay(line.at) === localDay(today) ? [slotOf(line.run, line.group, key)] : [])));

  return { newest, latest, slotsOn, torn: text !== '' && !text.endsWith('\n') };
}

type Ledger = Awaited<ReturnType<typeof readLedger>>;

async function append(config: LocalConfig, ledger: Ledger, lines: readonly Line[]): Promise<void> {
  if (lines.length === 0) return;
  await fs.mkdir(scoresDir(config), { recursive: true });
  await fs.appendFile(marksFile(config), `${ledger.torn ? '\n' : ''}${lines.map((line) => `${JSON.stringify(line)}\n`).join('')}`, 'utf8');
}

/** Whether automatic judging of `key` is past its window: a pass whose run, and its last request, are 14 days old. */
async function isExpired(key: MarkKey, requestedAt: string | undefined, { now, readRun }: MarkFacts): Promise<boolean> {
  if (key.subject.kind !== 'run') return false;
  const changedAt = (await readRun(key.subject.subject.runId))?.changedAt;
  const since = Math.max(changedAt === undefined ? -Infinity : Date.parse(changedAt), requestedAt === undefined ? -Infinity : Date.parse(requestedAt));

  return since + MARK_WINDOW_MS <= Date.parse(now);
}

/**
 * An open mark while its run goes on. Once the run ended before a judge attempt of the scorer ran, and while `now` is within
 * 14 days of when the mark first opened, a lapse that counts none; once it ended otherwise or is gone, one more lapse.
 */
async function openOrLapsed(line: Extract<Line, { state: 'open' }>, { now, readRun }: MarkFacts): Promise<Derived> {
  const run = await readRun(line.run);

  if (run?.ended === false) return { state: { kind: 'open', at: line.at, run: line.run, group: line.group, demand: line.demand }, restart: restartOf(line) };
  const firstOpenedAt = line.firstOpenedAt ?? line.at;

  if (run !== undefined && !run.judgeRan(line.subject, line.scorer) && Date.parse(now) < Date.parse(firstOpenedAt) + MARK_WINDOW_MS) {
    return { state: { kind: 'lapsed', lapses: line.lapses }, restart: { ...restartOf(line), firstOpenedAt, uncounted: true } };
  }

  const lapses = line.lapses + 1;

  return { state: { kind: 'lapsed', lapses }, restart: { ...restartOf(line), lapses, firstOpenedAt } };
}

/** A failed mark's code, and what its judge call spent when its tool reported that. */
type FailedFields = Omit<Extract<MarkOutcome, { kind: 'failed' }>, 'kind'>;

function failedFields({ code, usage }: { code: JudgeFailureCode; usage?: ConfinedUsage | undefined }): FailedFields {
  const fields: FailedFields = { code };

  if (usage) fields.usage = usage;

  return fields;
}

/** The mark `line` leaves, before its window. */
async function markOf(line: Line | undefined, facts: MarkFacts): Promise<Derived> {
  switch (line?.state) {
    case undefined:
      return { state: { kind: 'unmarked' }, restart: FRESH };
    case 'labelled':
      return { state: { kind: 'labelled' }, restart: FRESH };
    case 'failed':
      return { state: { kind: 'failed', ...failedFields(line) }, restart: FRESH };
    case 'waiting':
      return { state: { kind: 'waiting' }, restart: restartOf(line) };
    case 'carried':
      return { state: { kind: 'lapsed', lapses: line.lapses }, restart: restartOf(line) };
    case 'open':
      return openOrLapsed(line, facts);

    default: {
      const unhandled: never = line;

      return unhandled;
    }
  }
}

/** Whether automatic judging starts a mark in `state`: never marked, waiting for CI, or a lapse before the fourth. */
function startsAgain(state: MarkState): boolean {
  return state.kind === 'unmarked' || state.kind === 'waiting' || (state.kind === 'lapsed' && state.lapses < MARK_LAPSES);
}

async function derive(key: MarkKey, line: Line | undefined, facts: MarkFacts): Promise<Derived> {
  const derived = await markOf(line, facts);

  return startsAgain(derived.state) && await isExpired(key, derived.restart.requestedAt, facts) ? { ...derived, state: { kind: 'expired' } } : derived;
}

function restartOf(line: Extract<Line, { lapses: number }>): Restart {
  const restart: Restart = { lapses: line.lapses };

  if (line.requestedAt !== undefined) restart.requestedAt = line.requestedAt;

  if (line.firstOpenedAt !== undefined) restart.firstOpenedAt = line.firstOpenedAt;

  return restart;
}

/**
 * The mark of `key` in `ledger`. A session key no line opened yet goes on with the lapses of its scorer's newest mark of
 * the subject under an older rubric, while that one starts again, so a rubric changed since counts no lapse twice.
 */
async function derivedIn(ledger: Ledger, key: MarkKey, facts: MarkFacts): Promise<Derived> {
  const own = ledger.newest.get(idOf(key))?.line;
  const derived = await derive(key, own, facts);
  const latest = ledger.latest.get(scorerOf(key));

  if (own !== undefined || latest === undefined) return derived;
  const earlier = await derive(latest.key, latest.line, facts);

  return earlier.state.kind === 'lapsed' && startsAgain(earlier.state) ? { ...derived, restart: earlier.restart } : derived;
}

function canLaunch({ state }: Derived, demand: Demand): boolean {
  return demand === 'named' ? state.kind !== 'open' : startsAgain(state);
}

/** The line that opens `key`: a named launch starts its lapses and 14 days again, an automatic one goes on with them. */
function openLine(key: MarkKey, derived: Derived, launch: Launch, group: string, now: string): Line {
  const restart = launch.demand === 'named' ? { lapses: 0, requestedAt: now, firstOpenedAt: now } : { ...derived.restart, firstOpenedAt: derived.restart.firstOpenedAt ?? now };

  return lineOf(key, now, { state: 'open', run: launch.run, group, demand: launch.demand, ...restart });
}

/** Whether `line` starts a mark again without spending a daily-limit slot. */
function startsUncounted(line: Line | undefined): boolean {
  return line?.state === 'open' && line.uncounted === true;
}

function closeLine(key: MarkKey, current: Line | undefined, outcome: MarkOutcome, now: string): Line {
  switch (outcome.kind) {
    case 'labelled':
      return lineOf(key, now, { state: 'labelled' });
    case 'failed':
      return lineOf(key, now, { state: 'failed', ...failedFields(outcome) });
    case 'waiting':
      return lineOf(key, now, { state: 'waiting', ...current && 'lapses' in current ? restartOf(current) : FRESH });
    default: {
      const unhandled: never = outcome;

      return unhandled;
    }
  }
}

export const Marks = {
  /** The mark of each key, in the order given. */
  async states(config: LocalConfig, keys: readonly MarkKey[], facts: MarkFacts): Promise<MarkState[]> {
    const { newest } = await readLedger(config, facts.now);

    return Promise.all(keys.map(async (key) => (await derive(key, newest.get(idOf(key))?.line, facts)).state));
  },

  /**
   * Opens the keys of each group a launch of `demand` may start, for `launch.run`; a key that run already holds counts as
   * opened again. An automatic launch starts an unmarked key, one waiting for CI and a lapse before the fourth; a named
   * one every key no live run holds, with its lapses and 14 days started again. A group with a session that would pass
   * the daily limit is refused when automatic, and counted when named or when it starts again a mark someone asked for.
   */
  async open(config: LocalConfig, launch: Launch, facts: MarkFacts): Promise<Opened> {
    const done = await scoresLocked(config, 'marks', async () => {
      const ledger = await readLedger(config, facts.now);
      const slots = ledger.slotsOn(facts.now);
      const outcome: Extract<Opened, { status: 'done' }> = { status: 'done', opened: [], skipped: [], limited: false };
      const lines: Line[] = [];

      for (const { group, keys } of launch.groups) {
        const starts: Array<{ key: MarkKey; line?: Line; isUncounted: boolean }> = [];
        let isAsked = launch.demand === 'named';

        for (const key of keys) {
          const derived = await derivedIn(ledger, key, facts);

          if (derived.state.kind === 'open' && derived.state.run === launch.run) starts.push({ key, isUncounted: startsUncounted(ledger.newest.get(idOf(key))?.line) });
          else if (canLaunch(derived, launch.demand)) {
            const line = openLine(key, derived, launch, group, facts.now);
            starts.push({ key, line, isUncounted: startsUncounted(line) });
            // A mark someone asked for keeps that when automatic judging starts it again.
            isAsked ||= derived.restart.requestedAt !== undefined;
          } else outcome.skipped.push({ key, state: derived.state });
        }

        if (starts.length === 0) continue;
        const counted = starts.find(({ key, isUncounted }) => key.subject.kind !== 'run' && !isUncounted);
        const slot = counted && slotOf(launch.run, group, counted.key);
        const spends = slot !== undefined && !slots.has(slot);

        if (spends && !isAsked && launch.dailyLimit !== undefined && slots.size >= launch.dailyLimit) {
          outcome.limited = true;
          continue;
        }

        if (spends) slots.add(slot);

        for (const { key, line } of starts) {
          if (!line) continue;
          lines.push(line);
          ledger.newest.set(idOf(key), { key, line });
          ledger.latest.set(scorerOf(key), { key, line });
        }

        outcome.opened.push({ group, keys: starts.map(({ key }) => key) });
      }

      await append(config, ledger, lines);

      return outcome;
    });

    return done.status === 'busy' ? done : done.value;
  },

  /** Records what a write or a settle of the launch says of each key; recording it again leaves the same mark. */
  async close(config: LocalConfig, keys: readonly MarkKey[], outcome: MarkOutcome, { now }: Pick<MarkFacts, 'now'>): Promise<{ status: 'done' } | { status: 'busy' }> {
    const done = await scoresLocked(config, 'marks', async () => {
      const ledger = await readLedger(config, now);
      await append(config, ledger, keys.map((key) => closeLine(key, ledger.newest.get(idOf(key))?.line, outcome, now)));
    });

    return done.status === 'busy' ? done : { status: 'done' };
  },

  /** Session launches on `now`'s local day; a group of scorers judged in one launch counts once. */
  async launchesToday(config: LocalConfig, now: string): Promise<number> {
    return (await readLedger(config, now)).slotsOn(now).size;
  },

  /** How many open passes and sessions the upgrade carried over from judge attempts; undefined before it ran. */
  async carriedOver(config: LocalConfig, { now }: Pick<MarkFacts, 'now'>): Promise<{ passes: number; sessions: number } | undefined> {
    const carried = await readCarried(config, now);

    if (carried === undefined) return undefined;

    const open = carried.split('\n').flatMap((one) => {
      const mark = parsedLine(one);

      return mark?.line.state === 'carried' ? [mark.key.subject.kind] : [];
    });

    return { passes: open.filter((kind) => kind === 'run').length, sessions: open.filter((kind) => kind !== 'run').length };
  },

  /** Whether automatic judging starts a mark in `state`: never marked, waiting for CI, or a lapse before the fourth. */
  startsAgain,

  /**
   * The passes with a mark, `closed` those each of whose marks is closed or expired, and `live` the formatted subject of
   * every pass with a mark still open, waiting for CI or to start again, whichever scorer it is for.
   */
  async passes(config: LocalConfig, facts: MarkFacts): Promise<{ closed: RunSubject[]; live: ReadonlySet<string> }> {
    const { newest } = await readLedger(config, facts.now);
    const passes = [...newest.values()].flatMap(({ key, line }) => (key.subject.kind === 'run' ? [{ key, line, pass: key.subject.subject }] : []));
    const states = await Promise.all(passes.map(async ({ key, line }) => (await derive(key, line, facts)).state));
    const isLive = (state: MarkState | undefined) => state !== undefined && (state.kind === 'open' || startsAgain(state));
    const live = new Set(passes.flatMap(({ key }, at) => (isLive(states[at]) ? [Subject.format(key.subject)] : [])));
    const byId = new Map(passes.map(({ key, pass }) => [Subject.format(key.subject), pass]));

    return { closed: [...byId].flatMap(([id, pass]) => (live.has(id) ? [] : [pass])), live };
  },

  /**
   * The marks automatic judging starts again: lapses before the fourth, and marks waiting for CI, none expired, and of a
   * session only its scorer's newest mark, so a lapse a later rubric took up is not started again.
   */
  async restartable(config: LocalConfig, facts: MarkFacts): Promise<Array<{ key: MarkKey; state: Extract<MarkState, { kind: 'lapsed' | 'waiting' }> }>> {
    const { latest } = await readLedger(config, facts.now);
    const marks = await Promise.all([...latest.values()].map(async ({ key, line }) => ({ key, state: (await derive(key, line, facts)).state })));

    return marks.flatMap(({ key, state }) => ((state.kind === 'waiting' || state.kind === 'lapsed') && startsAgain(state) ? [{ key, state }] : []));
  },
} as const;
