/**
 * The dashboard's Self-improvement page (#1249): the loop that turns a scorer's failing labels into changes to the
 * team's harness, and what each change did.
 *
 *   labels ─► queue (what `self-improvement run` would start from now) ─► proposal (open branch and request)
 *          ─► proof (the regression suite, main against the change) ─► landed (on the default branch)
 *          ─► impact (the scorer's pass rate before and after the change)
 *
 * The queue is what `teamai self-improvement plan` picks, with the same `SelfImprovement.pick`, over the failures
 * `digest --json` lists.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { armKey, runComparisons, type ArmComparison, type BenchmarkRunInput } from '../benchmark/history.js';
import { listCachedSuites } from '../benchmark/suite-cache.js';
import { TaskSourceSchema } from '../benchmark/suite.js';
import { DigestFailures } from '../digest-failures.js';
import { ScorerResults, type RubricLabels, type Split, type Stats, type TrendWeek, type ViewedLabel } from '../scorers/results.js';
import { SelfImprovement, type Unusable } from '../self-improvement.js';
import type { LocalConfig } from '../types.js';
import { providerForRemote } from '../providers/registry.js';
import { canonicalJson } from '../utils/canonical-json.js';
import { execCommand } from '../utils/exec.js';
import { getConfiguredRemoteUrl } from '../utils/git.js';
import { loadCachedWorkflow } from '../workflow/cache.js';
import { benchmarkRuns } from './benchmarks.js';
import { readScorerLabels, rubricLabelsOf, sidesOf } from './scorers.js';
import { listLocalRuns, listReportedRuns, type LocalRunRow, type ReportedRunRow } from './workflow-runs.js';

/** The window failures are read over, as `self-improvement plan` reads them. */
const WINDOW_DAYS = 30;

/** One scorer's loop: how its default measurement passes, and what a run would start from now. */
export type ScorerLoop = {
  scorer: string;
  stats: Stats;
  trend: TrendWeek[];
  /** Failures a regression task can start from. */
  startable: number;
  /** Regression tasks the team repo already has for its failures. */
  covered: string[];
  refused: Record<Unusable, number>;
  /** Whether a run would change anything: two failures to start from, or one more beside a task. */
  isReady: boolean;
  command: string;
};

/** The scorer's default measurement on each side of a change: work that ran on a team revision without it, and with it. */
export type Impact = Omit<Split, 'commit'>;

/** The request of a proposal's branch on the team repo's host: open, none open, or a host that cannot say. */
export type Request = { kind: 'open'; url: string } | { kind: 'not_open' } | { kind: 'unknown' };

/**
 * The newest run of a suite that installed a change's team revision on one of its arms, and each pair of its arms that
 * differ only in the team, such as the default branch against the change, trial by trial.
 */
export type Proof = {
  run: string;
  source: BenchmarkRunInput['source'];
  suite: string;
  startedAt: string;
  comparisons: Array<Omit<ArmComparison, 'dimension' | 'usage' | 'from' | 'to'> & { from: ProofArm; to: ProofArm }>;
};
export type ProofArm = { arm: string; tool: string };

/**
 * A change to the team's harness made from a scorer's failures. `files` are the team files it adds or changes; `tasks`
 * those of them that are regression tasks made from the scorer's failures. `commit`: the commit that put it on the
 * default branch once landed; the head of its branch while proposed.
 */
type ChangeBase = { scorer: string; commit: string; title: string; at: string; files: string[]; tasks: string[]; proof?: Proof };
/** A change, and the team revisions a suite run that proves it installed: its head, or a merge's other parents. */
type Found<T extends Change['state']> = { change: Extract<Change, { state: T }>; revisions: string[] };
export type Change =
  | ChangeBase & { state: 'proposed'; branch: string; request: Request }
  | ChangeBase & { state: 'landed'; impact?: Impact };

/**
 * What runs the loop. `workflow`: the team's `workflows/teamai-self-improvement.yaml` or teamai's default. `jobs`: the
 * team repo's CI files that run `self-improvement run` and `benchmark run`. `suites`: the suites this checkout pulled,
 * with how many of their tasks a failure became.
 */
export type Setup = {
  workflow: { source: 'default' } | { source: 'team'; path: string } | { source: 'missing' };
  jobs: { improve?: string; proof?: string };
  suites: Array<{ name: string; path: string; tasks: number; regressions: number }>;
};

/** A run of the workflow, on this machine or published by a member or a CI runner. */
export type LoopRun = Pick<LocalRunRow | ReportedRunRow, 'run' | 'status' | 'startedAt' | 'endedAt' | 'source'> & { username?: string };

export type SelfImprovementView = {
  window: { days: number; from: string; to: string };
  scorers: ScorerLoop[];
  /** Newest first. */
  changes: Change[];
  setup: Setup;
  /** The newest runs of the workflow, newest first. */
  runs: LoopRun[];
};

const WORKFLOW = 'teamai-self-improvement';
/** How many of the workflow's runs the page lists. */
const RUN_LIMIT = 10;

/** How far back the page looks for changes, and counts the pass rate on each side of one. */
const CHANGE_DAYS = 180;
const DAY_MS = 24 * 60 * 60 * 1000;
/** A regression task's file, under a suite of `benchmarks/`. */
const TASK_FILE = /(^|\/)benchmarks\/.+\/tasks\/[^/]+\.yaml$/;

async function teamGit(config: LocalConfig, args: string[]): Promise<string | undefined> {
  const result = await execCommand('git', args, { cwd: config.repo.localPath, timeoutMs: 20_000 }).catch(() => undefined);
  return result?.code === 0 ? result.stdout : undefined;
}

/** The subject the task file `file` names as its `source` at `commit`, as canonical JSON. */
async function sourceAt(config: LocalConfig, commit: string, file: string): Promise<string | undefined> {
  const text = await teamGit(config, ['show', `${commit}:./${file}`]);
  if (text === undefined) return undefined;
  let task: unknown;
  try {
    task = parseYaml(text);
  } catch {
    return undefined;
  }
  const source = TaskSourceSchema.safeParse(typeof task === 'object' && task !== null && 'source' in task ? task.source : undefined);
  return source.success ? canonicalJson(source.data) : undefined;
}

/**
 * The changes on the team clone's checked-out branch since `since` that add a regression task made from a scorer's
 * failure: each commit as the default branch got it, so a merge counts once, with everything it brought.
 */
async function landedChanges(config: LocalConfig, { since, scorerOf }: { since: Date; scorerOf: ReadonlyMap<string, string> }): Promise<Array<Found<'landed'>>> {
  const log = await teamGit(config, ['log', '--first-parent', '--diff-merges=first-parent', `--since=${since.toISOString()}`, '--relative', '--no-renames', '--name-status', '--format=%x00%H%x09%P%x09%cI%x09%s', 'HEAD']);
  if (log === undefined) return [];
  const changes: Array<Found<'landed'>> = [];
  for (const block of log.split('\0').filter((entry) => entry.trim() !== '')) {
    const [header = '', ...lines] = block.split('\n');
    const [commit = '', parents = '', at = '', title = ''] = header.split('\t');
    const entries = lines.flatMap((line) => {
      const [status, file] = line.split('\t');
      return status !== undefined && file !== undefined ? [{ status, file }] : [];
    });
    const added = entries.filter(({ status, file }) => status === 'A' && TASK_FILE.test(file)).map(({ file }) => file);
    const scored = (await Promise.all(added.map(async (file) => ({ file, scorer: scorerOf.get(await sourceAt(config, commit, file) ?? '') }))))
      .flatMap(({ file, scorer }) => (scorer === undefined ? [] : [{ file, scorer }]));
    const scorer = scored[0]?.scorer;
    if (scorer === undefined) continue;
    const files = entries.filter(({ status }) => status !== 'D').map(({ file }) => file).sort();
    changes.push({
      change: { state: 'landed', scorer, commit, title, at, files, tasks: scored.filter((entry) => entry.scorer === scorer).map(({ file }) => file).sort() },
      revisions: [commit, ...parents.split(' ').slice(1)],
    });
  }
  return changes;
}

/** Where a run pushes its proposal for each scorer, and where the team clone keeps what it fetched of them. */
const PROPOSAL_PREFIX = 'teamai/self-improvement/';
const PROPOSAL_REFS = `refs/remotes/origin/${PROPOSAL_PREFIX}`;
/** How long the host may take to say whether a proposal's request is open. */
const LOOKUP_TIMEOUT_MS = 15_000;
/** The request of each proposal head the host answered for, by branch and head: a page load asks only for a new head. */
const requests = new Map<string, Request>();

/** The open request of `branch` on the team repo's host. Unknown when the host is not one teamai can ask, or cannot answer. */
async function requestOf(config: LocalConfig, { branch, head, target, refresh }: { branch: string; head: string; target: string; refresh: boolean }): Promise<Request> {
  const key = `${branch} ${head}`;
  const known = requests.get(key);
  if (known !== undefined || !refresh) return known ?? { kind: 'unknown' };
  const origin = providerForRemote(await getConfiguredRemoteUrl(config.repo.localPath) ?? '');
  if (origin.kind !== 'provider') return { kind: 'unknown' };
  const request: Request = await origin.pullRequests.findOpen({ repo: origin.repo, source: branch, target, timeoutMs: LOOKUP_TIMEOUT_MS })
    .then((url): Request => (url === undefined ? { kind: 'not_open' } : { kind: 'open', url }), (): Request => ({ kind: 'unknown' }));
  if (request.kind !== 'unknown') requests.set(key, request);
  return request;
}

/**
 * The proposals on origin that the default branch does not have yet: each branch `teamai/self-improvement/<scorer>`,
 * with what it adds or changes against the default branch. `refresh` fetches them from origin first; otherwise the page
 * shows what the last fetch got.
 */
async function proposedChanges(config: LocalConfig, { refresh }: { refresh: boolean }): Promise<Array<Found<'proposed'> & { sources: Map<string, string> }>> {
  if (refresh) await teamGit(config, ['fetch', '-q', '--prune', 'origin', `+refs/heads/${PROPOSAL_PREFIX}*:${PROPOSAL_REFS}*`]);
  const [refs, current] = await Promise.all([
    teamGit(config, ['for-each-ref', '--format=%(objectname)%09%(refname)', PROPOSAL_REFS]),
    teamGit(config, ['rev-parse', '--abbrev-ref', 'HEAD']),
  ]);
  const target = current?.trim() || 'main';
  const proposals = (refs ?? '').split('\n').flatMap((line) => {
    const [head, ref] = line.split('\t');
    return head && ref?.startsWith(PROPOSAL_REFS) ? [{ head, branch: ref.slice('refs/remotes/origin/'.length) }] : [];
  });
  const changes = await Promise.all(proposals.map(async ({ head, branch }): Promise<Found<'proposed'> & { sources: Map<string, string> } | undefined> => {
    const merged = await execCommand('git', ['merge-base', '--is-ancestor', head, 'HEAD'], { cwd: config.repo.localPath, timeoutMs: 10_000 }).catch(() => undefined);
    if (merged?.code === 0) return undefined;
    const [diff, header, request] = await Promise.all([
      teamGit(config, ['diff', '--relative', '--no-renames', '--name-status', `HEAD...${head}`]),
      teamGit(config, ['log', '-1', '--format=%cI%x09%s', head]),
      requestOf(config, { branch, head, target, refresh }),
    ]);
    if (diff === undefined || header === undefined) return undefined;
    const [at = '', title = ''] = header.trim().split('\t');
    const entries = diff.split('\n').flatMap((line) => {
      const [status, file] = line.split('\t');
      return status !== undefined && file !== undefined && status !== 'D' ? [{ status, file }] : [];
    });
    const tasks = entries.filter(({ status, file }) => status === 'A' && TASK_FILE.test(file)).map(({ file }) => file).sort();
    const sources = new Map((await Promise.all(tasks.map(async (file) => [await sourceAt(config, head, file), file] as const)))
      .flatMap(([source, file]) => (source === undefined ? [] : [[source, file] as const])));
    return {
      change: { state: 'proposed', scorer: branch.slice(PROPOSAL_PREFIX.length), branch, commit: head, title, at, files: entries.map(({ file }) => file).sort(), tasks, request },
      revisions: [head],
      sources,
    };
  }));
  return changes.filter((change) => change !== undefined);
}

/**
 * The newest of `runs` whose pulled arm installed one of `revisions`: the run a job pinned to the change, as
 * `benchmark run --team-ref` pins a pull request. An arm on a named ref, such as the default branch, is the baseline a
 * run compares against, so a later run whose baseline has the change proves another one.
 */
function proofOf(runs: readonly BenchmarkRunInput[], revisions: readonly string[]): Proof | undefined {
  const run = runs
    .filter(({ benchmark }) => benchmark.arms.some(({ team }) => team.kind === 'pulled' && revisions.includes(team.revision)))
    .sort((left, right) => Date.parse(right.startedAt) - Date.parse(left.startedAt))[0];
  if (run === undefined) return undefined;
  const armOf = (key: string): ProofArm | undefined => {
    const arm = run.benchmark.arms.find((candidate) => armKey(candidate) === key);
    return arm === undefined ? undefined : { arm: arm.name, tool: arm.tool };
  };
  const comparisons = runComparisons(run).flatMap(({ dimension, usage: _usage, from, to, ...comparison }) => {
    const [fromArm, toArm] = [armOf(from), armOf(to)];
    return dimension === 'team' && fromArm !== undefined && toArm !== undefined ? [{ ...comparison, from: fromArm, to: toArm }] : [];
  });
  return { run: run.run, source: run.source, suite: run.benchmark.suite.name, startedAt: run.startedAt, comparisons };
}

/** The scorer's default measurement on each side of `commit`, over the labels of the last `CHANGE_DAYS`. */
async function impactOf(config: LocalConfig, { labels, scorer, commit, now, rubricLabels }: { labels: readonly ViewedLabel[]; scorer: string; commit: string; now: Date; rubricLabels: RubricLabels }): Promise<Impact | undefined> {
  const sideOf = await sidesOf(config, commit, ScorerResults.revisions(labels));
  const split = ScorerResults.of({ labels, query: { windowDays: CHANGE_DAYS, scorer, split: { commit, sideOf } }, now, rubricLabels }).selected?.split;
  if (split === undefined) return undefined;
  const { commit: _commit, ...impact } = split;
  return impact;
}

/** The team repo's CI workflow files: the first that runs `self-improvement run`, and the first that runs `benchmark run`. */
async function ciJobs(config: LocalConfig): Promise<Setup['jobs']> {
  const top = (await teamGit(config, ['rev-parse', '--show-toplevel']))?.trim();
  if (top === undefined) return {};
  const dir = path.join(top, '.github', 'workflows');
  const files = (await fs.readdir(dir).catch((): string[] => [])).filter((file) => /\.ya?ml$/.test(file)).sort();
  const jobs: Setup['jobs'] = {};
  for (const file of files) {
    const text = await fs.readFile(path.join(dir, file), 'utf8').catch(() => '');
    const relative = `.github/workflows/${file}`;
    if (jobs.improve === undefined && /\bself-improvement run\b/.test(text)) jobs.improve = relative;
    if (jobs.proof === undefined && /\bbenchmark run\b/.test(text)) jobs.proof = relative;
  }
  return jobs;
}

async function setupOf(config: LocalConfig): Promise<Setup> {
  const [workflow, jobs, suites] = await Promise.all([loadCachedWorkflow(config, WORKFLOW), ciJobs(config), listCachedSuites(config)]);
  return {
    workflow: workflow === null ? { source: 'missing' } : workflow.source === 'team' ? { source: 'team', path: workflow.relativePath } : { source: 'default' },
    jobs,
    suites: suites.map((suite) => ({
      name: suite.name,
      path: path.posix.dirname(suite.relativePath),
      tasks: suite.tasks.length,
      regressions: suite.tasks.filter((task) => task.source !== undefined).length,
    })),
  };
}

/** The newest runs of the workflow: this machine's, and the published ones it has no run file for. */
async function loopRuns(config: LocalConfig): Promise<LoopRun[]> {
  const [local, reported] = await Promise.all([listLocalRuns(config).catch(() => []), listReportedRuns(config).catch(() => [])]);
  const localIds = new Set(local.map(({ run }) => run));
  return [...local, ...reported.filter(({ run }) => !localIds.has(run))]
    .filter(({ workflow }) => workflow === WORKFLOW)
    .sort((left, right) => Date.parse(right.startedAt) - Date.parse(left.startedAt))
    .slice(0, RUN_LIMIT)
    .map(({ run, status, startedAt, endedAt, source, ...rest }) => ({
      run, status, startedAt, source, ...endedAt !== undefined ? { endedAt } : {}, ...'username' in rest ? { username: rest.username } : {},
    }));
}

/** Whether `self-improvement run` would reach its improve step, as its workflow's gate decides. */
function isReady(startable: number, covered: number): boolean {
  return startable >= 2 || (startable >= 1 && covered >= 1);
}

/** The page's answer for one workspace. `refresh` refreshes the reports checkout from origin first. */
export async function selfImprovementView({ config, now = new Date(), refresh = true }: { config: LocalConfig; now?: Date; refresh?: boolean }): Promise<SelfImprovementView> {
  const [digest, labels] = await Promise.all([DigestFailures.read(config, { now, refresh }), readScorerLabels(config, { refresh: false })]);
  const rubricLabels = await rubricLabelsOf(config, labels.map(({ label }) => label));
  const summaries = ScorerResults.of({ labels, query: { windowDays: WINDOW_DAYS }, now, rubricLabels });
  const scorerOf = new Map(labels.flatMap(({ label }) => (label.passed ? [] : [[canonicalJson(label.subject), label.scorer] as const])));
  const starts = digest.failures.flatMap(({ start }) => ('commit' in start ? [start.commit] : []));
  const [proposed, landed, runs, setup, loop, present] = await Promise.all([
    proposedChanges(config, { refresh }),
    landedChanges(config, { since: new Date(now.getTime() - CHANGE_DAYS * DAY_MS), scorerOf }),
    benchmarkRuns(config, { refresh: false }),
    setupOf(config),
    loopRuns(config),
    SelfImprovement.commitsIn(config.projectRoot ?? process.cwd(), starts),
  ]);
  // The tasks a run for the scorer reads: the default branch's, and those its open proposal adds, as plan clones it.
  const pulled = digest.failures.flatMap((entry) => (entry.task === undefined ? [] : [[canonicalJson(entry.failure.subject), entry.task] as const]));
  const tasksOf = (scorer: string) => new Map([...pulled, ...proposed.find(({ change }) => change.scorer === scorer)?.sources ?? []]);
  const scorers = summaries.scorers.flatMap(({ scorer, defaultCohort, cohorts }): ScorerLoop[] => {
    const cohort = cohorts.find(({ id }) => id === defaultCohort);
    if (!cohort) return [];
    const picked = SelfImprovement.pick({ failures: digest.failures, scorer, tasks: tasksOf(scorer), hasCommit: (commit) => present.has(commit) });
    const refused: Record<Unusable, number> = { tracked_changes: 0, not_recorded: 0, not_in_checkout: 0 };
    for (const { why } of picked.refused) refused[why] += 1;
    return [{
      scorer,
      stats: cohort.stats,
      trend: cohort.trend,
      startable: picked.failures.length,
      covered: picked.covered,
      refused,
      isReady: isReady(picked.failures.length, picked.covered.length),
      command: `teamai self-improvement run ${scorer} --tools default=claude --sandbox`,
    }];
  });
  const proven = <T extends Change>(change: T, revisions: readonly string[]): T => {
    const proof = proofOf(runs, revisions);
    return proof === undefined ? change : { ...change, proof };
  };
  const withImpact = await Promise.all(landed.map(async ({ change, revisions }): Promise<Change> => {
    const impact = await impactOf(config, { labels, scorer: change.scorer, commit: change.commit, now, rubricLabels });
    return proven(impact === undefined ? change : { ...change, impact }, revisions);
  }));
  const changes = [...proposed.map(({ change, revisions }) => proven(change, revisions)), ...withImpact]
    .sort((left, right) => Date.parse(right.at) - Date.parse(left.at));
  return { window: summaries.window, scorers, changes, setup, runs: loop };
}
