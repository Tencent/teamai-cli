/**
 * The dashboard's Scorers page (#1182): pass rates of the score labels on `teamai-reports` and on this machine, through
 * `ScorerResults`. This module reads what the counting needs and nothing else: labels, the `agent` of the pass a
 * workflow label judges from its run record, the name of an archived session, this team clone's ancestry for a commit
 * split, and this machine's friction reminder state. It never reads a judge's reasoning, a prompt, a transcript or a
 * diff, and its answer carries no native session id.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { readRecordedAgent, type RecordedAgent } from '../agent-observation.js';
import { readReminderDecisions, sanitizeSessionId } from '../contribute-check.js';
import { memberEvents } from '../dashboard-collector.js';
import { LabelStore } from '../scorers/label-store.js';
import { isDimension, ScorerResults, type ScorerResultsQuery, type ScorerResultsView, type Side, type ViewedLabel } from '../scorers/results.js';
import { sessionArchiveRoot } from '../session-flow/session-cmd-shared.js';
import { SyncManager } from '../session-flow/sync.js';
import { getReportsDir, usesBranchWorktree, type DashboardEvent, type LocalConfig } from '../types.js';
import { execCommand } from '../utils/exec.js';
import { buildEndRecord, RECORDS_DIR } from '../workflow/records.js';
import { isRunId, readRun } from '../workflow/store.js';
import { HttpError } from './http.js';

/** The windows the page offers, in days of `scoredAt`. */
export const SCORER_WINDOWS = [7, 30, 90, 180] as const;

/** What the page asks for: the view's query, with the team commit to split at as the member typed it. */
export type ScorerQuery = Omit<ScorerResultsQuery, 'split'> & { commit?: string };

const QuerySchema = z.object({
  window: z.enum(['7', '30', '90', '180']).optional(),
  scorer: z.string().min(1).optional(),
  cohort: z.string().min(1).optional(),
  groupBy: z.string().refine(isDimension).optional(),
  commit: z.string().regex(/^[0-9a-fA-F]{4,64}$/).optional(),
});

/** The page's query string as a query. Throws an HttpError the page shows for a value it does not offer. */
export function parseScorerQuery(params: URLSearchParams): ScorerQuery {
  const parsed = QuerySchema.safeParse(Object.fromEntries(['window', 'scorer', 'cohort', 'groupBy', 'commit'].flatMap((key) => {
    const value = params.get(key);
    return value ? [[key, value]] : [];
  })));
  if (!parsed.success) {
    throw new HttpError(400, `Scorer results take window ${SCORER_WINDOWS.join(', ')}, a grouping the page offers, and a commit as hex digits.`);
  }
  const { window, scorer, cohort, groupBy, commit } = parsed.data;
  return {
    windowDays: window ? Number(window) : 30,
    ...(scorer ? { scorer } : {}),
    ...(cohort ? { cohort } : {}),
    ...(groupBy && isDimension(groupBy) ? { groupBy } : {}),
    ...(commit ? { commit: commit.toLowerCase() } : {}),
  };
}

/** What a run record holds that the view reads: each pass's agent, and whether the run was a benchmark (#1180). */
const RecordSchema = z.object({
  steps: z.array(z.object({ step: z.string(), pass: z.number(), agent: z.unknown().optional() })).optional(),
  benchmark: z.unknown().optional(),
});

type RunAgents = { source: 'local' | 'reported'; benchmark: boolean; agents: Map<string, RecordedAgent> };

const passKey = (step: string, pass: number) => `${step}#${pass}`;

/** The run a workflow label judges: this machine's run file when it has one, else the record the team published. */
async function runAgents(config: LocalConfig, runId: string): Promise<RunAgents | undefined> {
  if (!isRunId(runId)) return undefined;
  const local = await readRun(config, runId);
  const read = (steps: z.infer<typeof RecordSchema>['steps']) => new Map((steps ?? []).flatMap(({ step, pass, agent }) => {
    const recorded = readRecordedAgent(agent);
    return recorded ? [[passKey(step, pass), recorded] as const] : [];
  }));
  if (typeof local === 'object') return { source: 'local', benchmark: false, agents: read(buildEndRecord(local, local.driver, '').steps) };
  try {
    const parsed = RecordSchema.safeParse(JSON.parse(await fs.readFile(path.join(getReportsDir(config), RECORDS_DIR, `${runId}.json`), 'utf8')));
    if (!parsed.success) return undefined;
    return { source: 'reported', benchmark: parsed.data.benchmark !== undefined, agents: read(parsed.data.steps) };
  } catch {
    return undefined;
  }
}

/** The name of each session the team archive holds, by source platform and session id; the latest update wins. */
function archivedNames(config: LocalConfig): Map<string, string> {
  const root = sessionArchiveRoot(config);
  if (!root) return new Map();
  const entries = new SyncManager(root).listAllSessions()
    .filter((entry) => entry.sessionId)
    .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt));
  return new Map(entries.map((entry) => [`${entry.platform}\0${entry.sessionId}`, entry.sessionName]));
}

async function teamGit(config: LocalConfig, args: string[]) {
  return execCommand('git', args, { cwd: config.repo.localPath, timeoutMs: 10_000 });
}

/** The full commit `commit` names in this machine's team clone. Throws an HttpError the page shows when it has none. */
async function resolveCommit(config: LocalConfig, commit: string): Promise<string> {
  const resolved = await teamGit(config, ['rev-parse', '--verify', '--quiet', '--end-of-options', `${commit}^{commit}`]);
  if (resolved.code !== 0) {
    throw new HttpError(400, `Commit ${commit} is not in this machine's team clone. Run teamai pull, or give a commit of the team repo.`);
  }
  return resolved.stdout.trim();
}

/** Which side of `commit` each revision is on: after when the revision contains it. A revision this clone lacks has none. */
async function sidesOf(config: LocalConfig, commit: string, revisions: ReadonlySet<string>): Promise<Map<string, Side>> {
  const answers = await Promise.all([...revisions].map(async (revision) => {
    const { code } = await teamGit(config, ['merge-base', '--is-ancestor', commit, revision]);
    return code === 0 ? [[revision, 'after' as const] as const] : code === 1 ? [[revision, 'before' as const] as const] : [];
  }));
  return new Map(answers.flat());
}

/** The member's own sessions that started on this machine in the window, and whether their reminder fired. */
async function reminderInput(events: readonly DashboardEvent[], from: string, to: string) {
  const sessions = [...new Set(memberEvents([...events])
    .filter((event) => event.type === 'session_start' && event.timestamp >= from && event.timestamp <= to)
    .map((event) => event.sessionId))];
  const decisions = await readReminderDecisions();
  const hinted = new Map(sessions.flatMap((session) => {
    const decision = decisions.get(sanitizeSessionId(session));
    return decision === undefined ? [] : [[session, decision] as const];
  }));
  return { sessions, hinted };
}

/**
 * The Scorers page's answer for one workspace. `events` are this machine's dashboard events of the workspace; without
 * them there is no reminder table. `refresh` refreshes the reports checkout from origin first, as every reader of it.
 */
export async function scorerResults({ config, query, now = new Date(), events, refresh = true }: {
  config: LocalConfig;
  query: ScorerQuery;
  now?: Date;
  events?: readonly DashboardEvent[];
  refresh?: boolean;
}): Promise<ScorerResultsView> {
  if (usesBranchWorktree(config)) {
    const { readableReportsWorktree } = await import('../utils/reports-branch.js');
    await readableReportsWorktree(config, { dryRun: !refresh });
  }
  const [local, published] = await Promise.all([LabelStore.local(config), LabelStore.published(config)]);
  const labels = [
    ...local.map((label) => ({ label, author: config.username ?? 'unknown' })),
    ...published.map(({ member, label }) => ({ label, author: member })),
  ];

  const runIds = new Set(labels.flatMap(({ label }) => (label.source === 'workflow' ? [label.subject.runId] : [])));
  const runs = new Map(await Promise.all([...runIds].map(async (runId) => [runId, await runAgents(config, runId)] as const)));
  const names = archivedNames(config);
  const viewed: ViewedLabel[] = labels.flatMap(({ label, author }): ViewedLabel[] => {
    if (label.source === 'session') {
      const sessionName = names.get(`${label.subject.platform}\0${label.subject.sessionId}`);
      return [{ label, author, ...label.agent ? { agent: label.agent } : {}, ...sessionName ? { sessionName } : {} }];
    }
    const run = runs.get(label.subject.runId);
    if (run?.benchmark) return [];
    const agent = run?.agents.get(passKey(label.subject.step, label.subject.pass));
    return [{ label, author, ...agent ? { agent } : {}, ...run ? { runSource: run.source } : {} }];
  });

  const { commit, ...rest } = query;
  const window = ScorerResults.window(query.windowDays, now);
  const [split, reminders] = await Promise.all([
    commit ? (async () => {
      const full = await resolveCommit(config, commit);
      const revisions = new Set(viewed.flatMap(({ agent }) => (agent && 'v' in agent && agent.team ? [agent.team.revision] : [])));
      return { commit: full, sideOf: await sidesOf(config, full, revisions) };
    })() : undefined,
    events ? reminderInput(events, window.from, window.to) : undefined,
  ]);
  return ScorerResults.of({ labels: viewed, query: { ...rest, ...split ? { split } : {} }, now, ...reminders ? { reminders } : {} });
}
