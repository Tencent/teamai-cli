/**
 * Judged once: a mark per scorer and subject in `<dataHome>/scores/marks.jsonl` says whether automatic judging still
 * starts it. Each line is a whole mark as it was written, and the newest line of a key is its mark; a line that opens a
 * mark is also the launch the daily limit counts. Lines are only appended, under `scores/marks.lock`, so parallel
 * launches in one data home see each other's marks. A line that does not parse, such as a torn last one, is skipped.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { LocalConfig } from '../types.js';
import { readFileSafe } from '../utils/fs.js';
import { scoresDir, scoresLocked } from './home.js';
import { JUDGE_FAILURES, type JudgeFailureCode } from './label.js';
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
 * until the fourth. `expired`: a pass whose run last changed more than 14 days ago, or that long after it was asked for.
 */
export type MarkState =
  | { kind: 'unmarked' }
  | { kind: 'open'; at: string; run: string; group: string; demand: Demand }
  | { kind: 'waiting' }
  | { kind: 'lapsed'; lapses: number }
  | { kind: 'labelled' }
  | { kind: 'failed'; code: JudgeFailureCode }
  | { kind: 'expired' };

/** What a write or a settle of the launch says: a label, a failed attempt, or CI that has not finished. */
export type MarkOutcome = { kind: 'labelled' } | { kind: 'failed'; code: JudgeFailureCode } | { kind: 'waiting' };

/** What the store needs of a run: whether it ended, and when it last changed. */
export interface RunStatus {
  ended: boolean;
  changedAt: string;
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
const Restart = { lapses: z.number().int().min(0).max(MARK_LAPSES - 1), requestedAt: z.string().optional() };

const LineSchema = z.discriminatedUnion('state', [
  z.object({ ...Mark, ...Restart, state: z.literal('open'), run: z.string().min(1), group: z.string().min(1), demand: z.enum(DEMANDS) }),
  z.object({ ...Mark, ...Restart, state: z.literal('waiting') }),
  z.object({ ...Mark, state: z.literal('labelled') }),
  z.object({ ...Mark, state: z.literal('failed'), code: z.enum(JUDGE_FAILURES) }),
]);

type Line = z.infer<typeof LineSchema>;

type LineState = Line extends infer Each ? Each extends Line ? Omit<Each, keyof typeof Mark> : never : never;

/** What a next automatic launch carries on: the lapses so far, and when the mark was last asked for. */
interface Restart {
  lapses: number;
  requestedAt?: string;
}

/** A mark as its newest line leaves it. */
interface Derived {
  state: MarkState;
  restart: Restart;
}

function marksFile(config: LocalConfig): string {
  return path.join(scoresDir(config), 'marks.jsonl');
}

function idOf(key: MarkKey): string {
  return JSON.stringify([key.scorer, key.sourceHash ?? null, Subject.format(key.subject)]);
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
    const key = parsed.success ? keyOf(parsed.data) : undefined;

    return parsed.success && key ? { key, line: parsed.data } : undefined;
  } catch {
    return undefined;
  }
}

const localDay = (at: string) => new Date(at).toDateString();

/** Every mark of this data home: the newest line per key in the order keys first appear, and every launch. */
async function readLedger(config: LocalConfig) {
  const text = await readFileSafe(marksFile(config)) ?? '';
  const newest = new Map<string, { key: MarkKey; line: Line }>();
  const launches: Array<{ key: MarkKey; line: Extract<Line, { state: 'open' }> }> = [];

  for (const mark of text.split('\n').flatMap((one) => parsedLine(one) ?? [])) {
    newest.set(idOf(mark.key), mark);

    if (mark.line.state === 'open') launches.push({ key: mark.key, line: mark.line });
  }

  /** Session launches of `now`'s local day, by run and group: a group is one launch. */
  const slotsOn = (now: string) => new Set(launches.flatMap(({ key, line }) => (key.subject.kind !== 'run' && localDay(line.at) === localDay(now) ? [`${line.run}\n${line.group}`] : [])));

  return { newest, slotsOn, torn: text.length > 0 && !text.endsWith('\n') };
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

/** The mark `line` leaves, before its window: an open mark whose run ended or is gone is one more lapse. */
async function markOf(line: Line | undefined, { readRun }: MarkFacts): Promise<Derived> {
  switch (line?.state) {
    case undefined:
      return { state: { kind: 'unmarked' }, restart: { lapses: 0 } };
    case 'labelled':
      return { state: { kind: 'labelled' }, restart: { lapses: 0 } };
    case 'failed':
      return { state: { kind: 'failed', code: line.code }, restart: { lapses: 0 } };
    case 'waiting':
      return { state: { kind: 'waiting' }, restart: restartOf(line) };
    case 'open': {
      if ((await readRun(line.run))?.ended === false) return { state: { kind: 'open', at: line.at, run: line.run, group: line.group, demand: line.demand }, restart: restartOf(line) };
      const lapses = line.lapses + 1;

      return { state: { kind: 'lapsed', lapses }, restart: { ...restartOf(line), lapses } };
    }

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

  return restart;
}

function canLaunch({ state }: Derived, demand: Demand): boolean {
  return demand === 'named' ? state.kind !== 'open' : startsAgain(state);
}

function openLine(key: MarkKey, derived: Derived, launch: Launch, group: string, now: string): Line {
  const restart = launch.demand === 'named' ? { lapses: 0, requestedAt: now } : derived.restart;

  return lineOf(key, now, { state: 'open', run: launch.run, group, demand: launch.demand, ...restart });
}

function closeLine(key: MarkKey, current: Line | undefined, outcome: MarkOutcome, now: string): Line | undefined {
  switch (outcome.kind) {
    case 'labelled':
      return current?.state === 'labelled' ? undefined : lineOf(key, now, { state: 'labelled' });
    case 'failed':
      return current?.state === 'failed' && current.code === outcome.code ? undefined : lineOf(key, now, { state: 'failed', code: outcome.code });
    case 'waiting': {
      if (current?.state === 'waiting') return undefined;

      return lineOf(key, now, { state: 'waiting', ...current && 'lapses' in current ? restartOf(current) : { lapses: 0 } });
    }

    default: {
      const unhandled: never = outcome;

      return unhandled;
    }
  }
}

export const Marks = {
  /** The mark of each key, in the order given. */
  async states(config: LocalConfig, keys: readonly MarkKey[], facts: MarkFacts): Promise<MarkState[]> {
    const { newest } = await readLedger(config);

    return Promise.all(keys.map(async (key) => (await derive(key, newest.get(idOf(key))?.line, facts)).state));
  },

  /**
   * Opens the keys of each group a launch of `demand` may start, for `launch.run`; a key that run already holds counts as
   * opened again. An automatic launch starts an unmarked key, one waiting for CI and a lapse before the fourth; a named
   * one every key no live run holds, with its lapses and 14 days started again. A group with a session that would pass
   * the daily limit is refused when automatic, and counted when named.
   */
  async open(config: LocalConfig, launch: Launch, facts: MarkFacts): Promise<Opened> {
    const done = await scoresLocked(config, 'marks', async () => {
      const ledger = await readLedger(config);
      const slots = ledger.slotsOn(facts.now);
      const outcome: Extract<Opened, { status: 'done' }> = { status: 'done', opened: [], skipped: [], limited: false };
      const lines: Line[] = [];

      for (const { group, keys } of launch.groups) {
        const starts: Array<{ key: MarkKey; line?: Line }> = [];

        for (const key of keys) {
          const derived = await derive(key, ledger.newest.get(idOf(key))?.line, facts);

          if (derived.state.kind === 'open' && derived.state.run === launch.run) starts.push({ key });
          else if (canLaunch(derived, launch.demand)) starts.push({ key, line: openLine(key, derived, launch, group, facts.now) });
          else outcome.skipped.push({ key, state: derived.state });
        }

        if (starts.length === 0) continue;
        const slot = `${launch.run}\n${group}`;
        const spends = starts.some(({ key }) => key.subject.kind !== 'run') && !slots.has(slot);

        if (spends && launch.demand === 'auto' && launch.dailyLimit !== undefined && slots.size >= launch.dailyLimit) {
          outcome.limited = true;
          continue;
        }

        if (spends) slots.add(slot);

        for (const { key, line } of starts) {
          if (line) lines.push(line);

          if (line) ledger.newest.set(idOf(key), { key, line });
        }

        outcome.opened.push({ group, keys: starts.map(({ key }) => key) });
      }

      await append(config, ledger, lines);

      return outcome;
    });

    return done.status === 'busy' ? done : done.value;
  },

  /** Records what a write or a settle of the launch says of each key. Writing the same outcome again changes nothing. */
  async close(config: LocalConfig, keys: readonly MarkKey[], outcome: MarkOutcome, { now }: Pick<MarkFacts, 'now'>): Promise<{ status: 'done' } | { status: 'busy' }> {
    const done = await scoresLocked(config, 'marks', async () => {
      const ledger = await readLedger(config);
      await append(config, ledger, keys.flatMap((key) => closeLine(key, ledger.newest.get(idOf(key))?.line, outcome, now) ?? []));
    });

    return done.status === 'busy' ? done : { status: 'done' };
  },

  /** Session launches on `now`'s local day; a group of scorers judged in one launch counts once. */
  async launchesToday(config: LocalConfig, now: string): Promise<number> {
    return (await readLedger(config)).slotsOn(now).size;
  },

  /** The marks automatic judging starts again: lapses before the fourth, and marks waiting for CI, none expired. */
  async restartable(config: LocalConfig, facts: MarkFacts): Promise<Array<{ key: MarkKey; state: Extract<MarkState, { kind: 'lapsed' | 'waiting' }> }>> {
    const { newest } = await readLedger(config);
    const marks = await Promise.all([...newest.values()].map(async ({ key, line }) => ({ key, state: (await derive(key, line, facts)).state })));

    return marks.flatMap(({ key, state }) => ((state.kind === 'waiting' || state.kind === 'lapsed') && startsAgain(state) ? [{ key, state }] : []));
  },
} as const;
