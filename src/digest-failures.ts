/**
 * `teamai digest --json` (#1249): what an improvement starts from. The failing score labels of the last 30 days, each
 * with the subject it judges and the commit its work started at, and each scorer's cohorts with, for a model judge,
 * how it agrees with hand labels. It reads labels as the dashboard's Scorers page does, so a benchmark's labels are
 * left out, and it never reads a judge's reasoning, a prompt or a transcript.
 */
import matter from 'gray-matter';
import { listCachedSuites } from './benchmark/suite-cache.js';
import { detectProjectConfig, requireInit } from './config.js';
import { readScorerLabels, rubricLabelsOf } from './dashboard/scorers.js';
import { SessionSubjectSchema, type SessionSubject } from './scorers/label.js';
import { ScorerResults, type Failure, type ScorerFailures } from './scorers/results.js';
import type { LocalConfig } from './types.js';
import { canonicalJson } from './utils/canonical-json.js';
import { readFileSafe } from './utils/fs.js';
import { indexableLearningsRoots, listLearningFiles } from './utils/learnings-roots.js';
import { safeDeliveredLearningsNamespaces } from './workspace-children.js';

/** A learning as a failure lists it: its id, its path under `learnings/` without `.md`, and the file it is read from. */
export type LinkedLearning = { id: string; path: string };

/**
 * A failing session lists the learnings whose `session` names it, `[]` when none does; a workflow pass lists none.
 * `task`: the benchmark task this checkout pulled whose `source` is the failure's subject, so it is a regression already.
 */
export type DigestFailure = Failure & { task?: string; learnings?: LinkedLearning[] };

export type DigestFailuresView = Omit<ScorerFailures, 'failures'> & { failures: DigestFailure[] };

/** The window failures are read over, in days of `scoredAt`: the dashboard's default. */
const WINDOW_DAYS = 30;

const sessionKey = ({ platform, sessionId }: SessionSubject) => `${platform}\0${sessionId}`;

/**
 * The learnings each session names in its frontmatter `session`, by session: every learning recall reads in this
 * scope, the namespaces it receives included, each id once, the first root holding it winning.
 */
async function learningsBySession(config: LocalConfig): Promise<Map<string, LinkedLearning[]>> {
  const [roots, namespaces] = await Promise.all([indexableLearningsRoots(config), safeDeliveredLearningsNamespaces(config, 'digest')]);
  const bySession = new Map<string, LinkedLearning[]>();
  for (const { file, absPath } of await listLearningFiles(roots, namespaces)) {
    let data: unknown;
    try {
      ({ data } = matter(await readFileSafe(absPath) ?? ''));
    } catch {
      continue;
    }
    const session = SessionSubjectSchema.safeParse(typeof data === 'object' && data !== null && 'session' in data ? data.session : undefined);
    if (!session.success) continue;
    const linked = { id: file.split(/[\\/]/).join('/').replace(/\.md$/, ''), path: absPath };
    bySession.set(sessionKey(session.data), [...bySession.get(sessionKey(session.data)) ?? [], linked]);
  }
  return bySession;
}

/** The task of each subject a pulled suite's task names as its `source`, by the subject's canonical JSON. */
async function tasksBySource(config: LocalConfig): Promise<Map<string, string>> {
  const tasks = new Map<string, string>();
  for (const suite of await listCachedSuites(config)) {
    for (const task of suite.tasks) {
      if (task.source && !tasks.has(canonicalJson(task.source))) tasks.set(canonicalJson(task.source), task.relativePath);
    }
  }
  return tasks;
}

async function failures(config: LocalConfig, now = new Date()): Promise<DigestFailuresView> {
  const labels = await readScorerLabels(config);
  const [rubricLabels, learnings, tasks] = await Promise.all([rubricLabelsOf(config, labels.map(({ label }) => label)), learningsBySession(config), tasksBySource(config)]);
  const view = ScorerResults.failures({ labels, windowDays: WINDOW_DAYS, now, rubricLabels });
  return {
    ...view,
    failures: view.failures.map((entry) => {
      const task = tasks.get(canonicalJson(entry.failure.subject));
      const linked = { ...entry, ...task ? { task } : {} };
      return entry.failure.source === 'session' ? { ...linked, learnings: learnings.get(sessionKey(entry.failure.subject)) ?? [] } : linked;
    }),
  };
}

/** Prints the digest's JSON envelope on stdout, and only that. */
async function print(): Promise<void> {
  const config = await detectProjectConfig(undefined, undefined, { dryRun: true }) ?? (await requireInit({ dryRun: true })).localConfig;
  console.log(JSON.stringify({ data: await failures(config) }));
}

export const DigestFailures = { print } as const;
