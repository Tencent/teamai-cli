/**
 * The dashboard's Benchmarks page (#1180): the ended benchmark runs of a workspace, through `BenchmarkHistory`. It reads
 * the benchmark record `teamai benchmark report` wrote into each run directory of this machine, and the team's on
 * `teamai-reports`: a file is parsed once, and again only when its size or modification time changed, so a page of
 * hundreds of records re-reads nothing it read before. A run this machine has a record for is read from it, not from
 * its published copy.
 *
 * Each team revision the selected suite's runs installed is named from this machine's team clone, with the asset files
 * each tool and model's revision changed since the one it ran on before: a commit never changes, so each is read once.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { getReportsDir, usesBranchWorktree, type LocalConfig } from '../types.js';
import { BENCHMARK_WINDOWS, BenchmarkHistory, type BenchmarkHistoryQuery, type BenchmarkHistoryView, type BenchmarkRunInput } from '../benchmark/history.js';
import { benchmarkRecordFile, BenchmarkRunRecordSchema } from '../benchmark/result.js';
import { BENCHMARK_RECORDS_DIR, pendingBenchmarkRuns } from '../workflow/records.js';
import { isRunId, runsDir } from '../workflow/store.js';
import { git } from '../workflow/worktree.js';
import { HttpError } from './http.js';

const QuerySchema = z.object({
  window: z.coerce.number().refine((days) => BENCHMARK_WINDOWS.some((offered) => offered === days)).optional(),
  suite: z.string().min(1).max(256).optional(),
});

/** The page's query string as a query. Throws an HttpError the page shows for a window it does not offer. */
export function parseBenchmarkQuery(params: URLSearchParams): BenchmarkHistoryQuery {
  const parsed = QuerySchema.safeParse(Object.fromEntries(['window', 'suite'].flatMap((key) => {
    const value = params.get(key);
    return value ? [[key, value]] : [];
  })));
  if (!parsed.success) throw new HttpError(400, `Benchmark history takes window ${BENCHMARK_WINDOWS.join(', ')} and a suite name.`);
  return { windowDays: parsed.data.window ?? 90, ...(parsed.data.suite ? { suite: parsed.data.suite } : {}) };
}

/** A file read, by path: what it held at the size and modification time `stamp` names. Undefined: not a benchmark record. */
const reads = new Map<string, { stamp: string; input: BenchmarkRunInput | undefined }>();

/** The benchmark record in `file`, as `teamai benchmark report` writes it on this machine and publishes it. Throws when `file` cannot be read. */
async function readRecord(file: string, source: BenchmarkRunInput['source']): Promise<BenchmarkRunInput | undefined> {
  const text = await fs.readFile(file, 'utf8');
  try {
    const parsed = BenchmarkRunRecordSchema.safeParse(JSON.parse(text));
    if (!parsed.success || !isRunId(parsed.data.run)) return undefined;
    const record = parsed.data;
    return { run: record.run, source, startedAt: record.startedAt, outcome: record.outcome, ...(record.username ? { username: record.username } : {}), benchmark: record };
  } catch {
    return undefined;
  }
}

/**
 * The benchmark runs of `files`, all under `dir`, each parsed only when it changed since the last read. A file that
 * could not be read, such as one another process holds open on Windows, is read again next time.
 */
async function readFiles(dir: string, files: readonly string[], source: BenchmarkRunInput['source']): Promise<BenchmarkRunInput[]> {
  const present = new Set(files);
  for (const file of reads.keys()) if (file.startsWith(`${dir}${path.sep}`) && !present.has(file)) reads.delete(file);
  const inputs = await Promise.all(files.map(async (file) => {
    const stat = await fs.stat(file).catch(() => undefined);
    if (!stat) return undefined;
    const stamp = `${stat.mtimeMs}:${stat.size}`;
    const kept = reads.get(file);
    if (kept?.stamp === stamp) return kept.input;
    try {
      const input = await readRecord(file, source);
      reads.set(file, { stamp, input });
      return input;
    } catch {
      return undefined;
    }
  }));
  return inputs.filter((input) => input !== undefined);
}

/** This machine's benchmark records, one in the directory of each run that reported. */
async function readLocal(config: LocalConfig): Promise<BenchmarkRunInput[]> {
  const root = runsDir(config);
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
  return readFiles(root, entries.filter((entry) => entry.isDirectory() && isRunId(entry.name)).map((entry) => benchmarkRecordFile(root, entry.name)), 'local');
}

/**
 * The team's benchmark records on `teamai-reports`, which Compare and `--fail-on-regression` read, without those still
 * pending on this machine: the reports checkout keeps a record whose push was refused. `refresh` refreshes the checkout
 * from origin first.
 */
export async function publishedBenchmarkRuns(config: LocalConfig, { refresh }: { refresh: boolean }): Promise<BenchmarkRunInput[]> {
  await refreshReports(config, refresh);
  const [reported, pending] = await Promise.all([readReported(config), pendingBenchmarkRuns(config)]);
  return reported.filter(({ run }) => !pending.has(run));
}

async function refreshReports(config: LocalConfig, refresh: boolean): Promise<void> {
  if (!usesBranchWorktree(config)) return;
  const { readableReportsWorktree } = await import('../utils/reports-branch.js');
  await readableReportsWorktree(config, { dryRun: !refresh });
}

/** The team's benchmark records on `teamai-reports`. */
async function readReported(config: LocalConfig): Promise<BenchmarkRunInput[]> {
  const dir = path.join(getReportsDir(config), BENCHMARK_RECORDS_DIR);
  const files = (await fs.readdir(dir).catch(() => [])).filter((file) => file.endsWith('.json')).map((file) => path.join(dir, file));
  return readFiles(dir, files, 'reported');
}

/** A team revision as this machine's team clone has it. */
export interface TeamCommit {
  committedAt: string;
  subject: string;
}

/** The files outside benchmarks/ that changed from one team revision to another: at most `CHANGES_SHOWN`, in path order. */
export interface TeamDiff {
  files: Array<{ path: string; added: number; removed: number }>;
  more: number;
}

/**
 * `teamCommits` by revision, for each the clone has. `teamDiffs` by `<before>..<after>`, for each two revisions a tool and
 * model ran on in turn and the clone has both of.
 */
export type BenchmarkPage = BenchmarkHistoryView & { teamCommits: Record<string, TeamCommit>; teamDiffs: Record<string, TeamDiff> };

const CHANGES_SHOWN = 40;
const GIT_TIMEOUT_MS = 10_000;
/** By team clone and commit, or commit pair: what git said, which never changes. One the clone lacked is asked again, as a pull may bring it. */
const commits = new Map<string, Promise<TeamCommit | undefined>>();
const diffs = new Map<string, Promise<TeamDiff | undefined>>();

function commitOf(clone: string, revision: string): Promise<TeamCommit | undefined> {
  const key = `${clone}\0${revision}`;
  const known = commits.get(key) ?? git(clone, ['log', '-1', '--format=%cI%x00%s', revision, '--'], { timeoutMs: GIT_TIMEOUT_MS }).then(({ code, stdout }) => {
    const [committedAt, subject] = stdout.trim().split('\0');
    return code === 0 && committedAt && subject !== undefined ? { committedAt: new Date(committedAt).toISOString(), subject } : undefined;
  });
  commits.set(key, known);
  void known.then((commit) => commit ?? commits.delete(key));
  return known;
}

function diffOf(clone: string, before: string, after: string): Promise<TeamDiff | undefined> {
  const key = `${clone}\0${before}\0${after}`;
  const known = diffs.get(key) ?? git(clone, ['diff', '--numstat', '--no-renames', '--relative', before, after, '--', '.', ':(exclude)benchmarks'], { timeoutMs: GIT_TIMEOUT_MS }).then(({ code, stdout }) => {
    if (code !== 0) return undefined;
    const files = stdout.split('\n').filter(Boolean).map((line) => {
      const [added = '-', removed = '-', ...rest] = line.split('\t');
      return { path: rest.join('\t'), added: Number(added) || 0, removed: Number(removed) || 0 };
    }).sort((left, right) => left.path.localeCompare(right.path));
    return { files: files.slice(0, CHANGES_SHOWN), more: Math.max(0, files.length - CHANGES_SHOWN) };
  });
  diffs.set(key, known);
  void known.then((changes) => changes ?? diffs.delete(key));
  return known;
}

/**
 * `view` with its team revisions in commit order when the team clone has every one, each named, and what changed between
 * each two revisions a tool and model ran on in turn.
 */
async function withTeamCommits(config: LocalConfig, view: BenchmarkHistoryView): Promise<BenchmarkPage> {
  const revisions = view.selected?.teamChanges.revisions ?? [];
  if (!view.selected || revisions.length === 0) return { ...view, teamCommits: {}, teamDiffs: {} };
  const clone = config.repo.localPath;
  const named = await Promise.all(revisions.map(async (revision) => ({ revision, commit: await commitOf(clone, revision.revision) })));
  const ordered = named.every(({ commit }) => commit) ? named.toSorted((left, right) => (left.commit?.committedAt ?? '').localeCompare(right.commit?.committedAt ?? '')) : named;
  const teamCommits = Object.fromEntries(ordered.flatMap(({ revision, commit }) => (commit ? [[revision.revision, commit]] : [])));
  const pairs = new Set(view.selected.teamChanges.configs.flatMap(({ key }) => {
    const ran = ordered.map(({ revision }) => revision).filter(({ configs }) => configs.some((one) => one.key === key)).map(({ revision }) => revision);
    return ran.slice(1).map((after, index) => `${ran[index]}..${after}`);
  }));
  const diffed = await Promise.all([...pairs].map(async (pair) => {
    const [before = '', after = ''] = pair.split('..');
    return [pair, await diffOf(clone, before, after)] as const;
  }));
  return {
    ...view,
    selected: { ...view.selected, teamChanges: { ...view.selected.teamChanges, revisions: ordered.map(({ revision }) => revision) } },
    teamCommits,
    teamDiffs: Object.fromEntries(diffed.flatMap(([pair, diff]) => (diff ? [[pair, diff]] : []))),
  };
}

/**
 * The Benchmarks page's answer for one workspace. `refresh` refreshes the reports checkout from origin first, as every
 * reader of it.
 */
export async function benchmarkHistory({ config, query, now = new Date(), refresh = true }: {
  config: LocalConfig;
  query: BenchmarkHistoryQuery;
  now?: Date;
  refresh?: boolean;
}): Promise<BenchmarkPage> {
  const [local, reported] = await Promise.all([
    readLocal(config),
    publishedBenchmarkRuns(config, { refresh }),
  ]);
  const localIds = new Set(local.map(({ run }) => run));
  return withTeamCommits(config, BenchmarkHistory.of({ runs: [...local, ...reported.filter(({ run }) => !localIds.has(run))], query, now }));
}
