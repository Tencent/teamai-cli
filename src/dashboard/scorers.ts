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
import { readReminderDecisions, REMINDER_RECORD_DAYS, sanitizeSessionId } from '../contribute-check.js';
import { memberEvents } from '../dashboard-collector.js';
import type { ScoreLabel } from '../scorers/label.js';
import { LabelStore } from '../scorers/label-store.js';
import { cachedScorerNames, loadCachedScorer, scorerSourceHash } from '../scorers/cache.js';
import { parseScorer } from '../scorers/definition.js';
import { DIMENSIONS_OFFERED, FAILING_MAX, SCORER_WINDOWS, ScorerResults, type ReminderInput, type RubricLabels, type ScorerResultsQuery, type ScorerResultsView, type Side, type ViewedLabel } from '../scorers/results.js';
import { sessionArchiveRoot } from '../session-flow/session-cmd-shared.js';
import { SyncManager } from '../session-flow/sync.js';
import { getReportsDir, isSelfMode, usesBranchWorktree, type DashboardEvent, type LocalConfig } from '../types.js';
import { execCommand } from '../utils/exec.js';
import { buildEndRecord, RECORDS_DIR } from '../workflow/records.js';
import { isRunId, readRun, runsDir } from '../workflow/store.js';
import { HttpError } from './http.js';

/** What the page asks for: the view's query, with the team commit to split at as the member typed it. */
export type ScorerQuery = Omit<ScorerResultsQuery, 'split'> & { commit?: string };

const QuerySchema = z.object({
  window: z.coerce.number().refine((days) => SCORER_WINDOWS.some((offered) => offered === days)).optional(),
  scorer: z.string().min(1).optional(),
  cohort: z.string().min(1).optional(),
  groupBy: z.enum(DIMENSIONS_OFFERED).optional(),
  commit: z.string().regex(/^[0-9a-fA-F]{4,64}$/).optional(),
  group: z.string().min(1).max(2048).optional(),
  failing: z.coerce.number().int().min(1).max(FAILING_MAX).optional(),
});

/** The page's query string as a query. Throws an HttpError the page shows for a value it does not offer. */
export function parseScorerQuery(params: URLSearchParams): ScorerQuery {
  const parsed = QuerySchema.safeParse(Object.fromEntries(['window', 'scorer', 'cohort', 'groupBy', 'commit', 'group', 'failing'].flatMap((key) => {
    const value = params.get(key);
    return value ? [[key, value]] : [];
  })));
  if (!parsed.success) {
    throw new HttpError(400, `Scorer results take window ${SCORER_WINDOWS.join(', ')}, a grouping the page offers, a commit as hex digits, and up to ${FAILING_MAX} failing labels.`);
  }
  const { window, scorer, cohort, groupBy, commit, group, failing } = parsed.data;
  return {
    windowDays: window ?? 30,
    ...(scorer ? { scorer } : {}),
    ...(cohort ? { cohort } : {}),
    ...(groupBy ? { groupBy } : {}),
    ...(commit ? { commit: commit.toLowerCase() } : {}),
    ...(group || failing ? { failing: { ...(group ? { group } : {}), ...(failing ? { limit: failing } : {}) } } : {}),
  };
}

/** What a run record holds that the view reads: each pass's agent, and whether the run was a benchmark (#1180). */
const RecordSchema = z.object({
  steps: z.array(z.object({ step: z.string(), pass: z.number(), agent: z.unknown().optional() })).optional(),
  benchmark: z.unknown().optional(),
});

type RunAgents = { source: 'local' | 'reported'; isBenchmark: boolean; agents: Map<string, RecordedAgent> };
type PublishedRecord = z.infer<typeof RecordSchema>;

const passKey = (step: string, pass: number) => `${step}#${pass}`;
const sessionKey = (platform: string, sessionId: string) => `${platform}\0${sessionId}`;

async function publishedRecord(config: LocalConfig, runId: string): Promise<PublishedRecord | undefined> {
  try {
    const parsed = RecordSchema.safeParse(JSON.parse(await fs.readFile(path.join(getReportsDir(config), RECORDS_DIR, `${runId}.json`), 'utf8')));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The run a workflow label judges: its pass agents from this machine's run file when it has one, else from the record
 * the team published. Whether it was a benchmark comes from the published record either way.
 */
async function runAgents(config: LocalConfig, runId: string, { isLocal, team }: { isLocal: boolean; team: TeamReads }): Promise<RunAgents | undefined> {
  if (!isRunId(runId)) return undefined;
  const read = (steps: PublishedRecord['steps']) => new Map((steps ?? []).flatMap(({ step, pass, agent }) => {
    const recorded = readRecordedAgent(agent);
    return recorded ? [[passKey(step, pass), recorded] as const] : [];
  }));
  const [local, published] = await Promise.all([isLocal ? readRun(config, runId) : undefined, team.record(runId)]);
  const isBenchmark = published?.benchmark !== undefined;
  if (typeof local === 'object') return { source: 'local', isBenchmark, agents: read(buildEndRecord(local, local.driver, '').steps) };
  return published ? { source: 'reported', isBenchmark, agents: read(published.steps) } : undefined;
}

/**
 * The name of each session the team archive holds, by source platform and session id; the latest update wins. On a
 * git-kind team that is teamai-reports and the archive teamai kept on the default branch before, in the team clone.
 */
function archivedNames(config: LocalConfig): Map<string, string> {
  const root = sessionArchiveRoot(config);
  if (!root) return new Map();
  const entries = (isSelfMode(config) ? [root] : [root, config.repo.localPath]).flatMap((dir) => new SyncManager(dir).listAllSessions())
    .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt));
  return new Map(entries.flatMap((entry) => (entry.sessionId ? [[sessionKey(entry.platform, entry.sessionId), entry.sessionName] as const] : [])));
}

/**
 * What the team published, as read at one commit of the reports checkout and of the team clone: its labels, the names
 * of its archived sessions, and each run's record, read on first ask.
 */
type TeamReads = {
  labels: ReadonlyArray<{ member: string; label: ScoreLabel }>;
  names: ReadonlyMap<string, string>;
  record: (runId: string) => Promise<PublishedRecord | undefined>;
};

/**
 * The team reads of each reports checkout, by the commits they were read at. Every change on the page asks again, and
 * only a new commit of either checkout changes what the team published, so a click re-reads nothing else.
 */
const teamReadsCache = new Map<string, { at: string; reads: Promise<TeamReads> }>();

/** The commit checked out in `dir`, or undefined when it has none or is gone: then nothing read from it is kept. */
async function headOf(dir: string): Promise<string | undefined> {
  const head = await execCommand('git', ['rev-parse', '--verify', '--quiet', 'HEAD'], { cwd: dir, timeoutMs: 10_000 }).catch(() => undefined);
  return head?.code === 0 ? head.stdout.trim() : undefined;
}

async function readTeam(config: LocalConfig): Promise<TeamReads> {
  const records = new Map<string, Promise<PublishedRecord | undefined>>();
  return {
    labels: await LabelStore.published(config),
    names: archivedNames(config),
    record: (runId) => {
      const record = records.get(runId) ?? publishedRecord(config, runId);
      records.set(runId, record);
      return record;
    },
  };
}

/**
 * The team reads at the current commits, from memory when neither checkout moved. Nothing is kept for a checkout with no
 * commit, or for reports that are not a branch worktree, which a sync rewrites without a commit.
 */
async function teamReads(config: LocalConfig): Promise<TeamReads> {
  const dir = getReportsDir(config);
  const [reportsHead, teamHead] = usesBranchWorktree(config) ? await Promise.all([headOf(dir), headOf(config.repo.localPath)]) : [];
  const at = reportsHead && teamHead ? `${reportsHead} ${teamHead}` : undefined;
  const kept = teamReadsCache.get(dir);
  if (at && kept?.at === at) return kept.reads;
  const reads = readTeam(config);
  if (at) teamReadsCache.set(dir, { at, reads });
  else teamReadsCache.delete(dir);
  try {
    return await reads;
  } catch (e) {
    if (teamReadsCache.get(dir)?.reads === reads) teamReadsCache.delete(dir);
    throw e;
  }
}

/** The values a scorer file at a team commit lists, by commit, scorer and source hash. A commit never changes. */
const committedRubrics = new Map<string, Promise<readonly string[] | undefined>>();

/**
 * The values the rubric `sourceHash` of `scorer` lists, read at `teamRevision` from this machine's team clone: the root
 * or namespace file of that name whose text is the rubric. Undefined when the clone lacks the commit or holds no such
 * file at it.
 */
async function committedRubric(config: LocalConfig, { scorer, sourceHash, teamRevision }: { scorer: string; sourceHash: string; teamRevision: string }): Promise<readonly string[] | undefined> {
  const listed = await teamGit(config, ['ls-tree', '-r', '--name-only', teamRevision, '--', 'scorers']);
  if (listed.code !== 0) return undefined;
  const files = listed.stdout.split('\n').filter((file) => path.posix.basename(file) === `${scorer}.md` && [path.posix.dirname(file), path.posix.dirname(path.posix.dirname(file))].includes('scorers'));
  for (const file of files) {
    const shown = await teamGit(config, ['show', `${teamRevision}:${file}`]);
    if (shown.code !== 0 || scorerSourceHash(shown.stdout) !== sourceHash) continue;
    const parsed = parseScorer(file, shown.stdout);
    return parsed.ok ? parsed.definition.labels.map((label) => label.value) : undefined;
  }
  return undefined;
}

/**
 * The values each rubric lists, by source hash: which hand labels it pairs. The rubric of a scorer this machine caches
 * is read from the cache, and any other rubric of a scorer with a hand label from the team clone at a team revision its
 * labels carry. A rubric neither reads stays out, and the view falls back to the values its labels stored.
 */
async function rubricLabelsOf(config: LocalConfig, labels: readonly ScoreLabel[]): Promise<RubricLabels> {
  const cached = await Promise.all((await cachedScorerNames(config)).map((name) => loadCachedScorer(config, name)));
  const known = new Map<string, readonly string[]>(cached.flatMap((scorer) => (scorer ? [[scorer.sourceHash, scorer.definition.labels.map((label) => label.value)] as const] : [])));
  const handLabelled = new Set(labels.flatMap((label) => (label.judge.kind === 'human' ? [label.scorer] : [])));
  const revisions = new Map<string, { scorer: string; sourceHash: string; teamRevisions: Set<string> }>();
  for (const { scorer, rubric: { sourceHash, teamRevision } } of labels) {
    if (!handLabelled.has(scorer) || known.has(sourceHash) || !teamRevision || !/^[0-9a-f]{40,64}$/.test(teamRevision)) continue;
    const key = `${scorer}\0${sourceHash}`;
    const rubric = revisions.get(key) ?? { scorer, sourceHash, teamRevisions: new Set<string>() };
    rubric.teamRevisions.add(teamRevision);
    revisions.set(key, rubric);
  }
  const pending = [...revisions.values()];
  for (let start = 0; start < pending.length; start += SPLIT_GIT_BATCH) {
    await Promise.all(pending.slice(start, start + SPLIT_GIT_BATCH).map(async ({ scorer, sourceHash, teamRevisions }) => {
      for (const teamRevision of teamRevisions) {
        const key = `${teamRevision}\0${scorer}\0${sourceHash}`;
        const read = committedRubrics.get(key) ?? committedRubric(config, { scorer, sourceHash, teamRevision });
        committedRubrics.set(key, read);
        const values = await read;
        if (values) {
          known.set(sourceHash, values);
          return;
        }
        // A commit this clone lacks may arrive with the next pull, so only an answer is kept.
        committedRubrics.delete(key);
      }
    }));
  }
  return known;
}

/** The runs this machine has a run file for. */
async function localRunIds(config: LocalConfig): Promise<Set<string>> {
  const entries = await fs.readdir(runsDir(config)).catch(() => []);
  return new Set(entries.flatMap((entry) => (entry.endsWith('.json') ? [entry.slice(0, -'.json'.length)] : [])));
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

/** How many git processes a split starts at once, however many team revisions the labels name. */
const SPLIT_GIT_BATCH = 8;

/** Which side of `commit` each revision is on: after when the revision contains it. A revision this clone lacks has none. */
async function sidesOf(config: LocalConfig, commit: string, revisions: ReadonlySet<string>): Promise<Map<string, Side>> {
  const sides = new Map<string, Side>();
  const pending = [...revisions];
  for (let start = 0; start < pending.length; start += SPLIT_GIT_BATCH) {
    await Promise.all(pending.slice(start, start + SPLIT_GIT_BATCH).map(async (revision) => {
      const { code } = await teamGit(config, ['merge-base', '--is-ancestor', commit, revision]);
      if (code === 0) sides.set(revision, 'after');
      else if (code === 1) sides.set(revision, 'before');
    }));
  }
  return sides;
}

/**
 * The member's own sessions that started on this machine in the window, and whether their reminder fired. A window
 * longer than this machine keeps reminder decisions is cut to that, so an older session never reads as not recorded.
 */
async function reminderInput({ events, windowDays, now }: { events: readonly DashboardEvent[]; windowDays: number; now: Date }): Promise<ReminderInput> {
  const days = Math.min(windowDays, REMINDER_RECORD_DAYS);
  const { from, to } = ScorerResults.window(days, now);
  const sessions = [...new Set(memberEvents([...events])
    .filter((event) => event.type === 'session_start' && event.timestamp >= from && event.timestamp <= to)
    .map((event) => event.sessionId))];
  const decisions = await readReminderDecisions();
  const hinted = new Map(sessions.flatMap((session) => {
    const decision = decisions.get(sanitizeSessionId(session));
    return decision === undefined ? [] : [[session, decision] as const];
  }));
  return { days, sessions, hinted };
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
  const [local, team, localRuns] = await Promise.all([LabelStore.local(config), teamReads(config), localRunIds(config)]);
  const labels = [
    ...local.map((label) => ({ label, author: config.username ?? 'unknown' })),
    ...team.labels.map(({ member, label }) => ({ label, author: member })),
  ];

  const runIds = new Set(labels.flatMap(({ label }) => (label.source === 'workflow' ? [label.subject.runId] : [])));
  const runs = new Map(await Promise.all([...runIds].map(async (runId) => [runId, await runAgents(config, runId, { isLocal: localRuns.has(runId), team })] as const)));
  const { names } = team;
  const viewed: ViewedLabel[] = labels.flatMap(({ label, author }): ViewedLabel[] => {
    if (label.source === 'session') {
      const sessionName = names.get(sessionKey(label.subject.platform, label.subject.sessionId));
      return [{ label, author, ...label.agent ? { agent: label.agent } : {}, ...sessionName ? { sessionName } : {} }];
    }
    const run = runs.get(label.subject.runId);
    if (run?.isBenchmark) return [];
    const agent = run?.agents.get(passKey(label.subject.step, label.subject.pass));
    return [{ label, author, ...agent ? { agent } : {}, ...run ? { runSource: run.source } : {} }];
  });

  const { commit, ...rest } = query;
  const [split, reminders, rubricLabels] = await Promise.all([
    commit ? (async () => {
      const full = await resolveCommit(config, commit);
      return { commit: full, sideOf: await sidesOf(config, full, ScorerResults.revisions(viewed)) };
    })() : undefined,
    events ? reminderInput({ events, windowDays: query.windowDays, now }) : undefined,
    rubricLabelsOf(config, viewed.map(({ label }) => label)),
  ]);
  return ScorerResults.of({ labels: viewed, query: { ...rest, ...split ? { split } : {} }, now, rubricLabels, ...reminders ? { reminders } : {} });
}
