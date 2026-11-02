/**
 * What a failing label's subject links to in this checkout (#1249): the benchmark task a pulled suite names it in as its
 * `source`, so it is a regression already, and, for a session, the learnings whose frontmatter `session` names it.
 * `digest --json` and the dashboard's Scorers page read the same links.
 */
import matter from 'gray-matter';
import { listCachedSuites } from '../benchmark/suite-cache.js';
import type { LocalConfig } from '../types.js';
import { canonicalJson } from '../utils/canonical-json.js';
import { readFileSafe } from '../utils/fs.js';
import { indexableLearningsRoots, listLearningFiles } from '../utils/learnings-roots.js';
import { safeDeliveredLearningsNamespaces } from '../workspace-children.js';
import { z } from 'zod';
import { SessionSubjectSchema, type RunSubject, type SessionSubject } from './label.js';

/** The front matter of a learning that names the session it came from. */
const LearningSessionSchema = z.object({ session: SessionSubjectSchema });

/** A learning as a failure lists it: its id, its path under `learnings/` without `.md`, and the file it is read from. */
export type LinkedLearning = { id: string; path: string };

/** What a failing label's subject links to: the regression task naming it, and the learnings naming a session. */
export type FailureLinks = {
  taskOf(subject: SessionSubject | RunSubject): string | undefined;
  learningsOf(subject: SessionSubject): LinkedLearning[];
};

/**
 * The learnings each session names in its frontmatter `session`, by the session's canonical JSON: every learning recall
 * reads in this scope, the namespaces it receives included, each id once, the first root holding it winning.
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

    const named = LearningSessionSchema.safeParse(data);

    if (!named.success) continue;
    const key = canonicalJson(named.data.session);
    bySession.set(key, [...bySession.get(key) ?? [], { id: file.split(/[\\/]/).join('/').replace(/\.md$/, ''), path: absPath }]);
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

async function read(config: LocalConfig): Promise<FailureLinks> {
  const [tasks, learnings] = await Promise.all([tasksBySource(config), learningsBySession(config)]);

  return {
    taskOf: (subject) => tasks.get(canonicalJson(subject)),
    learningsOf: (subject) => learnings.get(canonicalJson(subject)) ?? [],
  };
}

export const FailureLinks = { read } as const;
