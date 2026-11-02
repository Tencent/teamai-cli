/**
 * The steps of teamai's default workflow `teamai-self-improvement` (#1249), which `teamai self-improvement run` starts:
 *
 *   plan     teamai self-improvement plan <scorer> --suite <dir>
 *              clones the team repo, on the open proposal's branch when origin has it, and picks the scorer's failures
 *              a regression task can start from: a recorded start commit this checkout has, no task in the clone's
 *              suite naming its subject yet, each subject once, newest first
 *   improve  a prompt that changes the team's assets in that clone and writes one task per failure
 *   propose  teamai self-improvement propose --team <clone> --branch <branch>
 *              pushes every file the clone adds or changes against the default branch, as push --file does, to the
 *              proposal's branch: one pull request, updated by the next run
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { parse as parseYaml } from 'yaml';
import { TaskSourceSchema } from './benchmark/suite.js';
import { BENCHMARK_NAME } from './benchmark/terms.js';
import { detectProjectConfig, requireInit } from './config.js';
import { DigestFailures, type DigestFailure } from './digest-failures.js';
import { loadCachedScorer } from './scorers/cache.js';
import { getDataHome, isSelfMode, type LocalConfig } from './types.js';
import { canonicalJson } from './utils/canonical-json.js';
import { log, setStderrOnly } from './utils/logger.js';

const run = promisify(execFile);

/** The branch every run for `scorer` proposes on, so a later run updates the open pull request instead of opening another. */
function branchOf(scorer: string): string {
  return `teamai/self-improvement/${scorer}`;
}

/** Why a failure of the scorer cannot become a task: no commit holds its start, or this checkout lacks the one that does. */
export type Unusable = 'tracked_changes' | 'not_recorded' | 'not_in_checkout';

export type Picked = {
  /** The failures a task can start from, each subject once, newest first. */
  failures: DigestFailure[];
  /** The tasks the proposal already has for the scorer's failures, each once. */
  covered: string[];
  refused: Array<{ subject: DigestFailure['failure']['subject']; why: Unusable }>;
};

/**
 * The failures of `scorer` a regression task can start from, of every failure `digest --json` lists. `tasks` maps the
 * canonical JSON of each subject a task names as its `source` to that task; `hasCommit` says whether this checkout has
 * a commit.
 */
function pick({ failures, scorer, tasks, hasCommit }: {
  failures: readonly DigestFailure[];
  scorer: string;
  tasks: ReadonlyMap<string, string>;
  hasCommit: (commit: string) => boolean;
}): Picked {
  const picked: Picked = { failures: [], covered: [], refused: [] };
  const seen = new Set<string>();
  for (const entry of failures) {
    if (entry.failure.scorer !== scorer) continue;
    const subject = canonicalJson(entry.failure.subject);
    if (seen.has(subject)) continue;
    seen.add(subject);
    const task = tasks.get(subject);
    if (task !== undefined) {
      if (!picked.covered.includes(task)) picked.covered.push(task);
      continue;
    }
    const why = 'refused' in entry.start ? entry.start.refused : hasCommit(entry.start.commit) ? undefined : 'not_in_checkout';
    if (why === undefined) picked.failures.push(entry);
    else picked.refused.push({ subject: entry.failure.subject, why });
  }
  return picked;
}

/** The task each subject a task file of `suiteDir` names as its `source`, by the subject's canonical JSON, as `<suite>/tasks/<file>`. */
async function tasksBySource(teamRoot: string, suite: string): Promise<Map<string, string>> {
  const dir = path.join(teamRoot, suite, 'tasks');
  const files = (await fs.readdir(dir).catch(() => [])).filter((file) => file.endsWith('.yaml')).sort();
  const tasks = new Map<string, string>();
  for (const file of files) {
    let task: unknown;
    try {
      task = parseYaml(await fs.readFile(path.join(dir, file), 'utf8'));
    } catch {
      continue;
    }
    const source = TaskSourceSchema.safeParse(typeof task === 'object' && task !== null && 'source' in task ? task.source : undefined);
    if (source.success && !tasks.has(canonicalJson(source.data))) tasks.set(canonicalJson(source.data), `${suite}/tasks/${file}`);
  }
  return tasks;
}

/** The commits of `commits` the checkout `cwd` has. */
async function commitsIn(cwd: string, commits: Iterable<string>): Promise<Set<string>> {
  const found = new Set<string>();
  for (const commit of new Set(commits)) {
    const has = await run('git', ['cat-file', '-e', `${commit}^{commit}`], { cwd }).then(() => true, () => false);
    if (has) found.add(commit);
  }
  return found;
}

async function git(cwd: string, args: string[]): Promise<string> {
  return (await run('git', args, { cwd, maxBuffer: 16 * 1024 * 1024 })).stdout.trim();
}

/** A fresh clone of the team repo at `<data home>/self-improvement/<scorer>`, on `branch` when origin has it. */
async function checkout(config: LocalConfig, scorer: string, branch: string): Promise<string> {
  const dir = path.join(getDataHome(config), 'self-improvement', scorer);
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(path.dirname(dir), { recursive: true });
  await run('git', ['clone', '-q', config.repo.remote, dir]);
  if (await git(dir, ['ls-remote', '--heads', 'origin', `refs/heads/${branch}`]) !== '') {
    await git(dir, ['checkout', '-q', '-B', branch, `origin/${branch}`]);
  }
  return dir;
}

function refuse(code: string, message: string): void {
  log.error(`${code}: ${message}`);
  process.exitCode = 1;
}

async function projectConfig(): Promise<LocalConfig> {
  return await detectProjectConfig(undefined, undefined, { dryRun: true }) ?? (await requireInit({ dryRun: true })).localConfig;
}

/** A suite directory under `benchmarks/`, such as benchmarks/regressions or benchmarks/web/regressions. */
const SUITE_DIR = new RegExp(`^benchmarks/(?:${BENCHMARK_NAME.source.slice(1, -1)}/)?${BENCHMARK_NAME.source.slice(1, -1)}$`);

/** `teamai self-improvement plan <scorer> --suite <dir>`: prints `{ team, branch, failures, covered, refused }`. */
async function plan(scorer: string, { suite }: { suite: string }): Promise<void> {
  setStderrOnly(true);
  if (!SUITE_DIR.test(suite)) {
    refuse('invalid_arguments', `--suite ${suite} is not a suite directory. Give one under benchmarks/, such as benchmarks/regressions.`);
    return;
  }
  const config = await projectConfig();
  if (!BENCHMARK_NAME.test(scorer) || await loadCachedScorer(config, scorer) === null) {
    refuse('scorer_not_found', `The team has no scorer ${scorer}. Run teamai pull, or give one teamai list scorers shows.`);
    return;
  }
  const branch = branchOf(scorer);
  const clone = await checkout(config, scorer, branch);
  const team = isSelfMode(config) ? path.join(clone, '.teamai') : clone;
  const { failures } = await DigestFailures.read(config);
  const starts = failures.flatMap(({ start }) => ('commit' in start ? [start.commit] : []));
  const [tasks, present] = await Promise.all([tasksBySource(team, suite), commitsIn(process.cwd(), starts)]);
  const picked = pick({ failures, scorer, tasks, hasCommit: (commit) => present.has(commit) });
  process.stdout.write(`${JSON.stringify({ team, branch, ...picked })}\n`);
}

/**
 * `teamai self-improvement propose --team <dir> --branch <branch>`: every file the team checkout `team` adds or changes
 * against the default branch on origin, pushed to `branch` as `push --file` pushes them. A deleted file is not proposed.
 */
async function propose({ team, branch }: { team: string; branch: string }): Promise<void> {
  const head = await git(team, ['ls-remote', '--symref', 'origin', 'HEAD']);
  const base = /^ref: refs\/heads\/(\S+)\s+HEAD$/m.exec(head)?.[1];
  if (base === undefined) {
    refuse('invalid_arguments', `${team} has no origin with a default branch, so there is nothing to compare its files with. Give the checkout teamai self-improvement plan printed.`);
    return;
  }
  await git(team, ['fetch', '-q', 'origin', base]);
  await git(team, ['add', '-A']);
  const changed = (await git(team, ['diff', '--cached', '--relative', '--name-status', '--no-renames', 'FETCH_HEAD'])).split('\n').filter(Boolean)
    .map((line) => line.split('\t'));
  const files = changed.flatMap(([status, file]) => (file !== undefined && (status === 'A' || status === 'M') ? [file] : []));
  const deleted = changed.flatMap(([status, file]) => (file !== undefined && status === 'D' ? [file] : []));
  if (deleted.length > 0) log.warn(`Not proposed, since a pull request from push --file only adds or changes files: ${deleted.join(', ')} deleted in ${team}.`);
  if (files.length === 0) {
    log.info(`No changes to propose: ${team} adds or changes no file against ${base}.`);
    return;
  }
  const { pushFile } = await import('./push-file.js');
  await pushFile({ file: files.map((file) => path.join(team, file)), path: files, branch });
}

export const SelfImprovement = { pick, plan, propose, branchOf, commitsIn } as const;
