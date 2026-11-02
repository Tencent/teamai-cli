/**
 * The dashboard's Self-improvement page (#1249): the loop that turns a scorer's failing labels into changes to the
 * team's harness, and what each change did.
 *
 *   labels ─► queue (what `self-improvement run` would start from now) ─► proposal (open branch and request)
 *          ─► review (each request the host merged, closed without merging, or keeps open)
 *          ─► proof (the regression suite, main against the change) ─► landed (on the default branch)
 *          ─► impact (the scorer's pass rate before and after the change)
 *
 * The queue is what `teamai digest --json --scorer` picks, with the same `SelfImprovement.pick`, over the failures
 * `digest --json` lists.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { armKey, runComparisons, type ArmComparison, type BenchmarkRunInput } from '../benchmark/history.js';
import { listCachedSuites } from '../benchmark/suite-cache.js';
import { taskSourceOf } from '../benchmark/suite.js';
import { DigestFailures } from '../digest-failures.js';
import { ScorerResults, type RubricLabels, type Split, type Stats, type TrendWeek, type ViewedLabel } from '../scorers/results.js';
import { SelfImprovement, type Unusable } from '../self-improvement.js';
import type { LocalConfig } from '../types.js';
import { providerForRemote } from '../providers/registry.js';
import type { PullRequestRecord } from '../providers/types.js';
import { canonicalJson } from '../utils/canonical-json.js';
import { execCommand } from '../utils/exec.js';
import { getConfiguredRemoteUrl } from '../utils/git.js';
import { loadCachedWorkflow } from '../workflow/cache.js';
import type { ResolvedWorkflow } from '../workflow/types.js';
import { benchmarkRuns } from './benchmarks.js';
import { readScorerLabels, rubricLabelsOf, sidesOf } from './scorers.js';
import { listLocalRuns, listReportedRuns, type LocalRunRow, type ReportedRunRow } from './workflow-runs.js';


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
  /** Whether a run would propose a change: the `if` of the workflow's step that delivers it holds (`wouldImprove`). */
  isReady: boolean;
  command: string;
  /** How the host ended the requests of the scorer's proposal branch; absent when it was not asked or could not answer. */
  requests?: RequestCounts;
};

/** The requests of proposal branches by how they ended. */
export type RequestCounts = { open: number; merged: number; closed: number };

/** Every scorer's requests, once the host answered for each one's branch. */
export type Requests = ({ kind: 'answered' } & RequestCounts) | { kind: 'unknown' };

/** The scorer's default measurement on each side of a change: work that ran on a team revision without it, and with it. */
export type Impact = Omit<Split, 'commit'>;

/** The request of a proposal's branch on the team repo's host: open since `openedAt`, none open, or a host that cannot say. */
export type ProposalRequest = { kind: 'open'; url: string; openedAt: string } | { kind: 'not_open' } | { kind: 'unknown' };

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
  | ChangeBase & { state: 'proposed'; branch: string; request: ProposalRequest }
  | ChangeBase & { state: 'landed'; impact?: Impact }
  | ClosedChange;

/** A request of a proposal branch the host closed without merging: a change the team turned down. `at`: when it closed. */
export type ClosedChange = { state: 'closed'; scorer: string; title: string; url: string; openedAt: string; at: string };

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
  requests: Requests;
  setup: Setup;
  /** The newest runs of the workflow, newest first. */
  runs: LoopRun[];
};

/** How many of the workflow's runs the page lists. */
const RUN_LIMIT = 10;

/** How far back the page looks for changes, and counts the pass rate on each side of one. */
const CHANGE_DAYS = 180;
const DAY_MS = 24 * 60 * 60 * 1000;

async function teamGit(config: LocalConfig, args: string[]): Promise<string | undefined> {
  const result = await execCommand('git', args, { cwd: config.repo.localPath, timeoutMs: 20_000 }).catch(() => undefined);

  return result?.code === 0 ? result.stdout : undefined;
}

/** The subject the task file `file` names as its `source` at `commit`, as canonical JSON. */
async function sourceAt(config: LocalConfig, { commit, file }: { commit: string; file: string }): Promise<string | undefined> {
  const text = await teamGit(config, ['show', `${commit}:./${file}`]);
  const source = text === undefined ? undefined : taskSourceOf(text);

  return source === undefined ? undefined : canonicalJson(source);
}

/**
 * The changes on the team clone's checked-out branch since `since` that add a regression task made from a scorer's
 * failure: each commit as the default branch got it, so a merge counts once, with everything it brought.
 */
async function landedChanges(config: LocalConfig, { since, scorersOf, proposalOf }: {
  since: Date;
  /** The scorers that failed each subject, by its canonical JSON. */
  scorersOf: ReadonlyMap<string, ReadonlySet<string>>;
  /** The proposal a commit landed: its scorer, and the head the host merged when it states it. */
  proposalOf: (commit: { commit: string; title: string }) => { scorer: string; head?: string } | undefined;
}): Promise<Array<Found<'landed'>>> {
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

    const added = entries.filter(({ status, file }) => status === 'A' && SelfImprovement.TASK_FILE.test(file)).map(({ file }) => file);

    const scored = (await Promise.all(added.map(async (file) => ({ file, scorers: scorersOf.get(await sourceAt(config, { commit, file }) ?? '') }))))
      .flatMap(({ file, scorers }) => (scorers === undefined ? [] : [{ file, scorers }]));

    // A subject several scorers failed: the scorer the commit names, else the one most of the added tasks failed.
    const candidates = [...new Set(scored.flatMap(({ scorers }) => [...scorers]))]
      .map((name) => ({ name, tasks: scored.filter(({ scorers }) => scorers.has(name)).length }))
      .sort((left, right) => right.tasks - left.tasks || left.name.localeCompare(right.name));

    const proposal = proposalOf({ commit, title });
    const scorer = candidates.find(({ name }) => name === proposal?.scorer)?.name ?? candidates[0]?.name;

    if (scorer === undefined) continue;
    const files = entries.filter(({ status }) => status !== 'D').map(({ file }) => file).sort();
    changes.push({
      change: { state: 'landed', scorer, commit, title, at, files, tasks: scored.filter(({ scorers }) => scorers.has(scorer)).map(({ file }) => file).sort() },
      revisions: [commit, ...parents.split(' ').slice(1), ...proposal?.scorer === scorer && proposal.head ? [proposal.head] : []],
    });
  }

  return changes;
}

/** Where the team clone keeps what it fetched of the proposal branches. */
const PROPOSAL_REFS = `refs/remotes/origin/${SelfImprovement.BRANCH_PREFIX}`;

/** How long the host may take to list a proposal branch's requests. */
const LOOKUP_TIMEOUT_MS = 15_000;

/** The requests the host last listed for each proposal branch, by host, repository and branch: a load that does not refresh reads these. */
const histories = new Map<string, PullRequestRecord[]>();

/**
 * The requests of each scorer's proposal branch into `target`, as the host lists them, asked again when `refresh` is set.
 * Undefined when the host is not one teamai can ask, or has not answered for every scorer, so counts are never partial.
 */
async function historiesOf(config: LocalConfig, { scorers, target, refresh }: { scorers: readonly string[]; target: string; refresh: boolean }): Promise<Map<string, PullRequestRecord[]> | undefined> {
  const origin = providerForRemote(await getConfiguredRemoteUrl(config.repo.localPath) ?? '');

  if (origin.kind !== 'provider') return undefined;

  const answers = await Promise.all(scorers.map(async (scorer) => {
    const source = SelfImprovement.branchOf(scorer);
    const key = `${origin.hostname} ${origin.repo} ${source}`;

    if (refresh) {
      const listed = await origin.pullRequests.history({ repo: origin.repo, source, target, timeoutMs: LOOKUP_TIMEOUT_MS }).catch(() => undefined);

      if (listed !== undefined) histories.set(key, listed);
    }

    return [scorer, histories.get(key)] as const;
  }));

  const known = answers.flatMap(([scorer, listed]) => (listed === undefined ? [] : [[scorer, listed] as const]));

  return known.length === answers.length ? new Map(known) : undefined;
}

/** The default branch of the team clone: the branch it has checked out. */
async function defaultBranch(config: LocalConfig): Promise<string> {
  return (await teamGit(config, ['rev-parse', '--abbrev-ref', 'HEAD']))?.trim() || 'main';
}

/**
 * The proposals on origin that the default branch does not have yet: each branch `teamai/self-improvement/<scorer>`,
 * with what it adds or changes against the default branch. `refresh` fetches them from origin first; otherwise the page
 * shows what the last fetch got.
 */
async function proposedChanges(config: LocalConfig, { refresh }: { refresh: boolean }): Promise<Array<Found<'proposed'> & { sources: Map<string, string> }>> {
  if (refresh) await teamGit(config, ['fetch', '-q', '--prune', 'origin', `+refs/heads/${SelfImprovement.BRANCH_PREFIX}*:${PROPOSAL_REFS}*`]);
  const refs = await teamGit(config, ['for-each-ref', '--format=%(objectname)%09%(refname)', PROPOSAL_REFS]);

  const proposals = (refs ?? '').split('\n').flatMap((line) => {
    const [head, ref] = line.split('\t');

    return head && ref?.startsWith(PROPOSAL_REFS) ? [{ head, branch: ref.slice('refs/remotes/origin/'.length) }] : [];
  });

  const changes = await Promise.all(proposals.map(async ({ head, branch }): Promise<Found<'proposed'> & { sources: Map<string, string> } | undefined> => {
    if (await SelfImprovement.holdsProposal(config.repo.localPath, { base: 'HEAD', head }).catch(() => false)) return undefined;

    const [diff, header] = await Promise.all([
      teamGit(config, ['diff', '--relative', '--no-renames', '--name-status', `HEAD...${head}`]),
      teamGit(config, ['log', '-1', '--format=%cI%x09%s', head]),
    ]);

    if (diff === undefined || header === undefined) return undefined;
    const [at = '', title = ''] = header.trim().split('\t');

    const entries = diff.split('\n').flatMap((line) => {
      const [status, file] = line.split('\t');

      return status !== undefined && file !== undefined && status !== 'D' ? [{ status, file }] : [];
    });

    const tasks = entries.filter(({ status, file }) => status === 'A' && SelfImprovement.TASK_FILE.test(file)).map(({ file }) => file).sort();

    const sources = new Map((await Promise.all(tasks.map(async (file) => [await sourceAt(config, { commit: head, file }), file] as const)))
      .flatMap(([source, file]) => (source === undefined ? [] : [[source, file] as const])));

    return {
      change: { state: 'proposed', scorer: branch.slice(SelfImprovement.BRANCH_PREFIX.length), branch, commit: head, title, at, files: entries.map(({ file }) => file).sort(), tasks, request: { kind: 'unknown' } },
      revisions: [head],
      sources,
    };
  }));

  return changes.filter((change) => change !== undefined);
}

/**
 * The newest of `runs` whose pulled arm installed one of `revisions`: the run a job pinned to the change, as
 * `benchmark run --team-ref` pins a pull request. An arm on a named ref, such as the default branch, is the baseline a
 * run compares against, so a later run whose baseline has the change proves another one. A squash- or rebase-merged
 * change has its request's head among `revisions` when the host stated it: no other run is taken for its proof. The run
 * is of the suite of each regression task the change adds and has that task, so another suite's run of the same
 * revision is not taken for it. A suite is named after its directory.
 */
function proofOf(runs: readonly BenchmarkRunInput[], { revisions, tasks }: { revisions: readonly string[]; tasks: readonly string[] }): Proof | undefined {
  const added = tasks.map((file) => ({ suite: path.posix.basename(path.posix.dirname(path.posix.dirname(file))), id: path.posix.basename(file, '.yaml') }));

  const run = runs
    .filter((candidate) => candidate.benchmark.arms.some(({ team }) => team.kind === 'pulled' && revisions.includes(team.revision))
      && added.every(({ suite, id }) => candidate.benchmark.suite.name === suite && candidate.benchmark.tasks.some((task) => task.id === id)))
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

/**
 * The team repo's CI files, GitHub Actions workflows then `.gitlab-ci.yml`: the first that runs `self-improvement run`,
 * and the first that runs `benchmark run`.
 */
async function ciJobs(config: LocalConfig): Promise<Setup['jobs']> {
  const top = (await teamGit(config, ['rev-parse', '--show-toplevel']))?.trim();

  if (top === undefined) return {};

  const actions = (await fs.readdir(path.join(top, '.github', 'workflows')).catch((): string[] => []))
    .filter((file) => /\.ya?ml$/.test(file)).sort().map((file) => `.github/workflows/${file}`);

  const texts = await Promise.all([...actions, '.gitlab-ci.yml'].map(async (relative) => ({ relative, text: await fs.readFile(path.join(top, relative), 'utf8').catch(() => '') })));
  const first = (command: RegExp): string | undefined => texts.find(({ text }) => command.test(text))?.relative;
  const [improve, proof] = [first(/\bself-improvement run\b/), first(/\bbenchmark run\b/)];

  return { improve, proof };
}

async function setupOf(config: LocalConfig, workflow: ResolvedWorkflow | null): Promise<Setup> {
  const [jobs, suites] = await Promise.all([ciJobs(config), listCachedSuites(config)]);

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
    .filter(({ workflow }) => workflow === SelfImprovement.WORKFLOW)
    .sort((left, right) => Date.parse(right.startedAt) - Date.parse(left.startedAt))
    .slice(0, RUN_LIMIT)
    .map(({ run, status, startedAt, endedAt, source, ...rest }) => ({
      run, status, startedAt, source, endedAt, username: 'username' in rest ? rest.username : undefined,
    }));
}

/** The proposal's request as the host listed it: the open one, none open, or not known. */
function proposalRequest(listed: readonly PullRequestRecord[] | undefined): ProposalRequest {
  if (listed === undefined) return { kind: 'unknown' };
  const open = listed.find((request) => request.state === 'open');

  return open === undefined ? { kind: 'not_open' } : { kind: 'open', url: open.url, openedAt: open.openedAt };
}

function countsOf(listed: readonly PullRequestRecord[]): RequestCounts {
  const counts: RequestCounts = { open: 0, merged: 0, closed: 0 };

  for (const { state } of listed) counts[state] += 1;

  return counts;
}

/** The page's answer for one workspace. `refresh` refreshes the reports checkout from origin first. */
export async function selfImprovementView({ config, now = new Date(), refresh = true }: { config: LocalConfig; now?: Date; refresh?: boolean }): Promise<SelfImprovementView> {
  const [digest, labels] = await Promise.all([DigestFailures.read(config, { now, refresh }), readScorerLabels(config, { refresh: false })]);
  const rubricLabels = await rubricLabelsOf(config, labels.map(({ label }) => label));
  const summaries = ScorerResults.of({ labels, query: { windowDays: DigestFailures.WINDOW_DAYS }, now, rubricLabels });
  const scorersOf = new Map<string, Set<string>>();

  for (const { label } of labels) {
    if (label.passed) continue;
    const subject = canonicalJson(label.subject);
    scorersOf.set(subject, new Set([...scorersOf.get(subject) ?? [], label.scorer]));
  }

  const starts = digest.failures.flatMap(({ start }) => ('commit' in start ? [start.commit] : []));

  const workflow = await loadCachedWorkflow(config, SelfImprovement.WORKFLOW);

  const [proposed, runs, setup, loop, present, target, suites] = await Promise.all([
    proposedChanges(config, { refresh }),
    benchmarkRuns(config, { refresh: false }),
    setupOf(config, workflow),
    loopRuns(config),
    SelfImprovement.commitsIn(config.projectRoot ?? process.cwd(), starts),
    defaultBranch(config),
    listCachedSuites(config),
  ]);

  const asked = [...new Set([...summaries.scorers.map(({ scorer }) => scorer), ...proposed.map(({ change }) => change.scorer)])].sort();
  const listed = await historiesOf(config, { scorers: asked, target, refresh });
  const merged = [...listed ?? []].flatMap(([scorer, requests]) => requests.flatMap((request) => (request.state === 'merged' ? [{ scorer, request }] : [])));

  // The request the host merged as the commit, else one its title names by number; else the branch its title names whole.
  const proposalOf = ({ commit, title }: { commit: string; title: string }): { scorer: string; head?: string } | undefined => {
    const numbers = new Set([...title.matchAll(/#(\d+)\b/g)].map(([, number]) => number));
    const found = merged.find(({ request }) => request.merge?.commit === commit) ?? merged.find(({ request }) => numbers.has(/\/(\d+)$/.exec(request.url)?.[1] ?? ''));

    if (found) return { scorer: found.scorer, head: found.request.merge?.head };
    const words = title.split(/[\s'"`:]+/);
    const scorer = asked.find((name) => words.some((word) => word === SelfImprovement.branchOf(name) || word.endsWith(`/${SelfImprovement.branchOf(name)}`)));

    return scorer === undefined ? undefined : { scorer };
  };

  const landed = await landedChanges(config, { since: new Date(now.getTime() - CHANGE_DAYS * DAY_MS), scorersOf, proposalOf });
  // The tasks a run of the command reads: its suite's on the default branch, and those its open proposal adds, as plan clones it.
  const isPlanned = (file: string): boolean => file.startsWith(`${SelfImprovement.SUITE}/tasks/`);

  const pulled = suites.flatMap(({ tasks }) => tasks.flatMap(({ source, relativePath }) => (
    source && isPlanned(relativePath) ? [[canonicalJson(source), relativePath] as const] : []
  )));

  const tasksOf = (scorer: string) => new Map([...pulled, ...[...proposed.find(({ change }) => change.scorer === scorer)?.sources ?? []].filter(([, file]) => isPlanned(file))]);

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
      isReady: SelfImprovement.wouldImprove(workflow?.definition, {
        inputs: { scorer, suite: SelfImprovement.SUITE },
        improvement: { ...picked, hasProposal: proposed.some(({ change }) => change.scorer === scorer) },
      }),
      command: SelfImprovement.commandOf(scorer),
      requests: listed?.has(scorer) ? countsOf(listed.get(scorer) ?? []) : undefined,
    }];
  });

  const proven = <T extends Exclude<Change, ClosedChange>>(change: T, revisions: readonly string[]): T => {
    const proof = proofOf(runs, { revisions, tasks: change.tasks });

    return proof === undefined ? change : { ...change, proof };
  };

  const withImpact = await Promise.all(landed.map(async ({ change, revisions }): Promise<Change> => {
    const impact = await impactOf(config, { labels, scorer: change.scorer, commit: change.commit, now, rubricLabels });

    return proven(impact === undefined ? change : { ...change, impact }, revisions);
  }));

  const closed = [...listed ?? []].flatMap(([scorer, requests]) => requests.flatMap((request): ClosedChange[] => (
    request.state === 'closed' ? [{ state: 'closed', scorer, title: request.title, url: request.url, openedAt: request.openedAt, at: request.closedAt }] : []
  )));

  const changes = [
    ...proposed.map(({ change, revisions }) => proven({ ...change, request: proposalRequest(listed?.get(change.scorer)) }, revisions)),
    ...withImpact,
    ...closed,
  ].sort((left, right) => Date.parse(right.at) - Date.parse(left.at));

  const requests: Requests = listed === undefined ? { kind: 'unknown' } : { kind: 'answered', ...countsOf([...listed.values()].flat()) };

  return { window: summaries.window, scorers, changes, requests, setup, runs: loop };
}
