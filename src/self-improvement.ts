/**
 * What teamai's default workflow `teamai-self-improvement` (#1249) decides, and the dashboard shows with the same rules:
 * which failures of a scorer a regression task can start from, and whether a run changes the harness.
 *
 *   plan     teamai digest --json --scorer <scorer> --suite <dir> --proposal teamai/self-improvement/<scorer>
 *              data.improvement: the failures a task can start from (a recorded start commit this checkout has, no
 *              task of the suite on origin's default branch or on the proposal naming its subject yet), each subject
 *              once, newest first, the tasks that cover the others, and whether the run is ready
 *   improve  a prompt step in workspace { team: { branch: teamai/self-improvement/<scorer> } }, with deliver: pr: it
 *              changes the team's assets and writes one task per failure, and teamai pushes and proposes them as one
 *              pull request, which the next run updates
 */
import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { taskSourceOf } from './benchmark/suite.js';
import { BENCHMARK_NAME } from './benchmark/terms.js';
import type { DigestFailure } from './digest-failures.js';
import { loadCachedScorer } from './scorers/cache.js';
import { getDataHome, SYNC_LOCK_FILENAME, type LocalConfig } from './types.js';
import { acquireLock, releaseLock } from './update.js';
import { canonicalJson } from './utils/canonical-json.js';
import { evaluateExpression, isTruthy, parseExpression } from './workflow/expression.js';
import type { WorkflowDefinition } from './workflow/types.js';

const run = promisify(execFile);

/** teamai's default workflow that `teamai self-improvement run` starts, unless the team pushed its own of that name. */
const WORKFLOW = 'teamai-self-improvement';

/** The suite a run puts its regression tasks in unless `--suite` names another. */
const SUITE = 'benchmarks/regressions';

/** The prefix of the branch every run proposes on. */
const BRANCH_PREFIX = 'teamai/self-improvement/';

/** The branch every run for `scorer` proposes on, so a later run updates the open pull request instead of opening another. */
function branchOf(scorer: string): string {
  return `${BRANCH_PREFIX}${scorer}`;
}

/**
 * Whether a run of `workflow` for `inputs` would propose a change from `improvement`, as `plan` prints it: whether the `if`
 * of its step that delivers a pull request holds, reading `steps.plan` as that step's output. The workflow holds the
 * threshold, so a team changes it there. False for a workflow with no such step, or an `if` that does not parse.
 */
function wouldImprove(workflow: WorkflowDefinition | undefined, { inputs, improvement }: { inputs: { scorer: string; suite: string }; improvement: Improvement }): boolean {
  const step = workflow?.steps.find((candidate) => candidate.deliver === 'pr');

  if (step?.if === undefined) return step !== undefined;
  const parsed = parseExpression(step.if);

  if (!parsed.ok) return false;

  return isTruthy(evaluateExpression(parsed.expression, { inputs, steps: { plan: { outcome: 'success', outputs: { data: { improvement } } } } }));
}

/** The command that runs the loop for `scorer` on a machine to throw away, as the guide's scheduled job does. */
function commandOf(scorer: string): string {
  return `teamai self-improvement run ${scorer} --tools default=claude --sandbox`;
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
  const why = ({ start }: DigestFailure): Unusable | undefined => ('refused' in start ? start.refused : hasCommit(start.commit) ? undefined : 'not_in_checkout');
  // Each subject's failures, newest first: one label of it may have a start another lacks, such as a hand label's.
  const bySubject = new Map<string, [DigestFailure, ...DigestFailure[]]>();

  for (const entry of failures) {
    if (entry.failure.scorer !== scorer) continue;
    const subject = canonicalJson(entry.failure.subject);
    const listed = bySubject.get(subject);

    if (listed) listed.push(entry);
    else bySubject.set(subject, [entry]);
  }

  for (const [subject, [newest, ...older]] of bySubject) {
    const task = tasks.get(subject);

    if (task !== undefined) {
      if (!picked.covered.includes(task)) picked.covered.push(task);
      continue;
    }

    const refused = why(newest);
    const usable = refused === undefined ? newest : older.find((entry) => why(entry) === undefined);

    if (usable !== undefined) picked.failures.push(usable);
    else if (refused !== undefined) picked.refused.push({ subject: newest.failure.subject, why: refused });
  }

  return picked;
}

/** The commits of `commits` the checkout `cwd` has, asked of git once; none when `cwd` is not a checkout. */
async function commitsIn(cwd: string, commits: Iterable<string>): Promise<Set<string>> {
  const wanted = [...new Set(commits)];

  if (wanted.length === 0) return new Set();

  const answer = await new Promise<string>((resolve, reject) => {
    const child = execFile('git', ['cat-file', '--batch-check=%(objecttype)'], { cwd, maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => (error ? reject(error) : resolve(stdout)));
    child.stdin?.end(wanted.map((commit) => `${commit}^{commit}\n`).join(''));
  }).catch(() => '');

  const types = answer.split('\n');

  return new Set(wanted.filter((_, index) => types[index] === 'commit'));
}

async function git(cwd: string, args: string[]): Promise<string> {
  return (await run('git', args, { cwd, maxBuffer: 16 * 1024 * 1024 })).stdout.trim();
}

/** A regression task file of any suite, as a path in the team repo. */
const TASK_FILE = /(^|\/)benchmarks\/.+\/tasks\/[^/]+\.yaml$/;

/**
 * Whether `base` holds the proposal at `head`: it merged it, or a commit of its own added each regression task the
 * proposal adds exactly as the proposal has it, as a squash or rebase merge leaves a kept branch, whatever `base` did with
 * the task since. Both are refs of the team checkout `cwd`.
 */
async function holdsProposal(cwd: string, { base, head }: { base: string; head: string }): Promise<boolean> {
  if (await git(cwd, ['merge-base', '--is-ancestor', head, base]).then(() => true, () => false)) return true;
  const added = (await git(cwd, ['diff', '--relative', '--no-renames', '--name-only', '--diff-filter=A', `${base}...${head}`])).split('\n').filter((file) => TASK_FILE.test(file));

  if (added.length === 0) return false;
  const blobs = await Promise.all(added.map((file) => git(cwd, ['rev-parse', `${head}:./${file}`])));
  const landed = await Promise.all(blobs.map((blob) => git(cwd, ['log', '-1', '--format=%H', `--find-object=${blob}`, base, '--not', head])));

  return landed.every((commit) => commit !== '');
}

/** A suite directory under `benchmarks/`, such as benchmarks/regressions or benchmarks/web/regressions. */
const SUITE_DIR = new RegExp(`^benchmarks/(?:${BENCHMARK_NAME.source.slice(1, -1)}/)?${BENCHMARK_NAME.source.slice(1, -1)}$`);

/**
 * The tasks of `suite` that name a subject as their `source`, by the subject's canonical JSON, as `<suite>/tasks/<file>`:
 * those on `proposal` first, then those on the default branch, both as origin has them now, read in the member's team
 * checkout. `hasProposal`: origin has `proposal`, and its default branch does not hold it (`holdsProposal`); the tasks of
 * one it holds are read from the default branch alone. `busy` while a teamai pull or push holds that checkout: the fetch
 * updates the refs a pull updates.
 */
async function coveringTasks(config: LocalConfig, input: { suite: string; proposal?: string }): Promise<{ tasks: Map<string, string>; hasProposal: boolean } | 'busy'> {
  const lock = path.join(getDataHome(config), SYNC_LOCK_FILENAME);

  if (!await acquireLock(lock)) return 'busy';

  try {
    return await tasksOnOrigin(config.repo.localPath, input);
  } finally {
    await releaseLock(lock);
  }
}

async function tasksOnOrigin(teamCheckout: string, { suite, proposal }: { suite: string; proposal?: string }): Promise<{ tasks: Map<string, string>; hasProposal: boolean }> {
  const top = await git(teamCheckout, ['rev-parse', '--show-toplevel']);
  const prefix = await git(teamCheckout, ['rev-parse', '--show-prefix']);
  const listed = await git(top, ['ls-remote', '--symref', 'origin', 'HEAD', ...(proposal !== undefined ? [`refs/heads/${proposal}`] : [])]);
  const base = /^ref: refs\/heads\/(\S+)\s+HEAD$/m.exec(listed)?.[1];
  const onOrigin = proposal !== undefined && listed.split('\n').some((line) => line.endsWith(`\trefs/heads/${proposal}`));
  const branches = [...(onOrigin && proposal !== undefined ? [proposal] : []), ...(base !== undefined ? [base] : [])];

  if (branches.length > 0) await git(top, ['fetch', '-q', '--no-tags', 'origin', ...branches.map((branch) => `+refs/heads/${branch}:refs/remotes/origin/${branch}`)]);
  // A branch the default branch holds is a proposal that merged and was kept, as the dashboard reads it: none is open.
  const merged = onOrigin && base !== undefined && await holdsProposal(teamCheckout, { base: `refs/remotes/origin/${base}`, head: `refs/remotes/origin/${proposal}` });
  const hasProposal = onOrigin && !merged;
  const tasks = new Map<string, string>();

  for (const branch of merged ? branches.slice(1) : branches) {
    const ref = `refs/remotes/origin/${branch}`;

    const files = (await git(top, ['ls-tree', '-r', '--name-only', ref, '--', `${prefix}${suite}/tasks/`])).split('\n')
      .filter((file) => file.endsWith('.yaml') && !file.slice(`${prefix}${suite}/tasks/`.length).includes('/')).sort();

    for (const file of files) {
      const source = taskSourceOf(await git(top, ['show', `${ref}:${file}`]));

      if (source !== undefined && !tasks.has(canonicalJson(source))) tasks.set(canonicalJson(source), file.slice(prefix.length));
    }
  }

  return { tasks, hasProposal };
}

/** What a run of the workflow starts from, as `digest --json --scorer` prints it in `data.improvement`. */
export type Improvement = Picked & { hasProposal: boolean };

/**
 * The improvement `scorer`'s `failures` call for, with the tasks of `suite` on origin and on `proposal` covering the
 * failures they name, or why it cannot be read: a suite that is no directory under `benchmarks/`, or a scorer the team
 * does not have.
 */
async function plan(config: LocalConfig, input: { failures: readonly DigestFailure[]; scorer: string; suite: string; proposal?: string }): Promise<Improvement | { code: string; message: string }> {
  const { failures, scorer, suite, proposal } = input;

  if (!SUITE_DIR.test(suite)) return { code: 'invalid_arguments', message: `--suite ${suite} is not a suite directory. Give one under benchmarks/, such as benchmarks/regressions.` };

  if (!BENCHMARK_NAME.test(scorer) || await loadCachedScorer(config, scorer) === null) {
    return { code: 'scorer_not_found', message: `The team has no scorer ${scorer}. Run teamai pull, or give one teamai list scorers shows.` };
  }

  const starts = failures.flatMap(({ start }) => ('commit' in start ? [start.commit] : []));

  const [covering, present] = await Promise.all([
    coveringTasks(config, { suite, proposal }),
    commitsIn(config.projectRoot ?? process.cwd(), starts),
  ]);

  if (covering === 'busy') {
    return { code: 'busy', message: 'Another teamai pull/push is in progress for this project, so the regression tasks on origin were not read. Re-run once it finishes.' };
  }

  const picked = pick({ failures, scorer, tasks: covering.tasks, hasCommit: (commit) => present.has(commit) });

  return { ...picked, hasProposal: covering.hasProposal };
}

export const SelfImprovement = { WORKFLOW, SUITE, BRANCH_PREFIX, TASK_FILE, holdsProposal, pick, wouldImprove, commandOf, branchOf, commitsIn, coveringTasks, plan } as const;
