/**
 * `teamai session list --suite <dir> [--sizes <spec>]` (#1793): the past sessions a benchmark suite could take a task
 * from, of this machine or pushed by the team. A session is offered with the commit it started at and the one it ended
 * on, both clean and different, both in the suite's repo, and no task of the suite already coming from it; how big its
 * change is, and, with sizes, the size that fits it. Every session left out is counted under why.
 */
import path from 'node:path';
import { listCachedSuites } from '../benchmark/suite-cache.js';
import type { Suite } from '../benchmark/suite.js';
import type { LocalConfig } from '../types.js';
import { commitCacheOf, firstUnreachable } from '../workflow/place/place.js';
import { git } from '../workflow/worktree.js';
import type { SessionCommits } from './sync.js';

type Refusal = { ok: false; code: string; message: string };

const BOUNDED = ['S', 'M', 'L'] as const;

type Bounded = (typeof BOUNDED)[number];

export type Size = Bounded | 'XL';

/** The largest change, in lines and files, each bounded size holds. */
export type Sizes = Readonly<Record<Bounded, { lines: number; files: number }>>;

const SIZES_EXAMPLE = 'S=40,3 M=200,10 L=800,30';

const SIZE_PART = /^(S|M|L)=(\d+),(\d+)$/;

/** `--sizes` as the workflow's `sizes` input gives it: S, M and L, each once, as `<name>=<lines>,<files>`. */
function parseSizes(text: string): { ok: true; sizes: Sizes } | Refusal {
  const refusal: Refusal = { ok: false, code: 'invalid_arguments', message: `--sizes "${text}" is not S, M and L, each as <name>=<lines>,<files>, such as "${SIZES_EXAMPLE}".` };
  const found = new Map<Bounded, { lines: number; files: number }>();

  for (const part of text.trim().split(/\s+/)) {
    const match = SIZE_PART.exec(part);
    const name = BOUNDED.find((one) => one === match?.[1]);

    if (!match || name === undefined || found.has(name)) return refusal;
    found.set(name, { lines: Number(match[2]), files: Number(match[3]) });
  }

  const [s, m, l] = BOUNDED.map((name) => found.get(name));

  return s && m && l ? { ok: true, sizes: { S: s, M: m, L: l } } : refusal;
}

/** The smallest of S, M and L whose limits both `lines` and `files` fit, else XL. */
function sizeOf(sizes: Sizes, change: { lines: number; files: number }): Size {
  return BOUNDED.find((name) => change.lines <= sizes[name].lines && change.files <= sizes[name].files) ?? 'XL';
}

/** The suite this member received in `dir`, as `benchmarks/fix-auth` or `benchmarks/web/fix-auth` names it. */
async function suiteIn(config: LocalConfig, dir: string): Promise<{ ok: true; suite: Suite } | Refusal> {
  const wanted = path.posix.normalize(dir.split(path.sep).join('/')).replace(/\/+$/, '');
  const suite = (await listCachedSuites(config)).find((one) => path.posix.dirname(one.relativePath) === wanted);

  if (suite) return { ok: true, suite };

  return { ok: false, code: 'suite_not_found', message: `No benchmark suite this checkout received is in ${dir}. Give a suite's directory, such as benchmarks/fix-auth, or run teamai pull for the team's newest suites.` };
}

/** Why a session is not offered. Each is a phrase the listing prints after a count. */
export const LEFT_OUT = {
  unrecorded: 'archived without recorded commits',
  noStart: 'no recorded start',
  noEnd: 'no recorded end',
  dirtyStart: 'started with tracked files modified',
  dirtyEnd: 'ended with tracked files modified',
  noCommit: 'ended on the commit it started at',
  taken: 'a task of the suite already comes from it',
  unreachable: 'commits not in the suite repo',
} as const;

export type LeftOutReason = (typeof LEFT_OUT)[keyof typeof LEFT_OUT];

/** How many sessions were left out for one reason. */
export interface LeftOut {
  reason: LeftOutReason;
  sessions: number;
}

/** What `--suite` adds to a listed session: its commits and how big its change is; with `--sizes`, its size. */
export interface TaskFields {
  start: string;
  solution: string;
  files: number;
  lines: number;
  size?: Size;
}

/** One session to weigh: `item`, the entry the listing prints, and what identifies and dates it. */
export interface Weighed<T> {
  item: T;
  session: string;
  source: string;
  /** Undefined when nothing recorded them, as for a session pushed before teamai did. */
  commits: SessionCommits | undefined;
}

/** The files and changed lines from `start` to `solution` in `dir`; a binary file counts as a file of no lines. */
async function changeOf(dir: string, start: string, solution: string): Promise<{ files: number; lines: number } | undefined> {
  const diff = await git(dir, ['diff', '--numstat', '--no-renames', start, solution]);

  if (diff.code !== 0) return undefined;
  const rows = diff.stdout.split('\n').filter((line) => line.trim() !== '');
  const lines = rows.reduce((sum, row) => sum + row.split('\t').slice(0, 2).reduce((part, count) => part + (Number(count) || 0), 0), 0);

  return { files: rows.length, lines };
}

/** The reason `weighed` is left out before its commits are fetched, or its start and solution. */
function recordedPair(commits: SessionCommits | undefined): { reason: LeftOutReason } | { start: string; solution: string } {
  if (commits === undefined) return { reason: LEFT_OUT.unrecorded };
  const { start, end } = commits;

  if (start === undefined) return { reason: LEFT_OUT.noStart };

  if (end === undefined) return { reason: LEFT_OUT.noEnd };

  if (start.dirty) return { reason: LEFT_OUT.dirtyStart };

  if (end.dirty) return { reason: LEFT_OUT.dirtyEnd };

  if (start.commit === end.commit) return { reason: LEFT_OUT.noCommit };

  return { start: start.commit, solution: end.commit };
}

/** Whether a task of `suite` already comes from session `session` of `source`, or names `solution` as its solution. */
function taken(suite: Suite, { session, source, solution }: { session: string; source: string; solution: string }): boolean {
  return suite.tasks.some((task) => task.solutionCommit === solution
    || (task.source !== undefined && 'sessionId' in task.source && task.source.sessionId === session && task.source.platform === source));
}

/**
 * Of `sessions`, those `suite` could take a task from, in their order, each with its task fields, sized by `sizes`
 * when given; and how many were left out, by reason, in the order the reasons are checked.
 */
async function weigh<T>(config: LocalConfig, { suite, sizes }: { suite: Suite; sizes?: Sizes }, sessions: readonly Weighed<T>[]): Promise<{ list: Array<{ item: T; fields: TaskFields }>; leftOut: LeftOut[] }> {
  const cache = commitCacheOf(config, suite.repo);
  const counts = new Map<LeftOutReason, number>();
  const list: Array<{ item: T; fields: TaskFields }> = [];

  const leave = (reason: LeftOutReason): void => {
    counts.set(reason, (counts.get(reason) ?? 0) + 1);
  };

  for (const one of sessions) {
    const pair = recordedPair(one.commits);

    if ('reason' in pair) {
      leave(pair.reason);
      continue;
    }

    if (taken(suite, { session: one.session, source: one.source, solution: pair.solution })) {
      leave(LEFT_OUT.taken);
      continue;
    }

    // The solution first: its fetch brings the start it descends from, so most sessions cost one fetch.
    const unreachable = await firstUnreachable({ cache, repo: suite.repo, commits: [pair.solution, pair.start] });
    const change = unreachable === undefined ? await changeOf(cache, pair.start, pair.solution) : undefined;

    if (!change) {
      leave(LEFT_OUT.unreachable);
      continue;
    }

    const fields: TaskFields = { ...pair, ...change };

    if (sizes) fields.size = sizeOf(sizes, change);
    list.push({ item: one.item, fields });
  }

  const leftOut = Object.values(LEFT_OUT).flatMap((reason) => {
    const count = counts.get(reason);

    return count === undefined ? [] : [{ reason, sessions: count }];
  });

  return { list, leftOut };
}

/** The line that says how many sessions `leftOut` left out and why, or none when it left out none. */
function leftOutLine(leftOut: readonly LeftOut[]): string | undefined {
  if (leftOut.length === 0) return undefined;
  const total = leftOut.reduce((sum, one) => sum + one.sessions, 0);

  return `Left out ${total} session${total === 1 ? '' : 's'}: ${leftOut.map((one) => `${one.reason} (${one.sessions})`).join(', ')}.`;
}

export const TaskCandidates = { parseSizes, suiteIn, weigh, leftOutLine } as const;
