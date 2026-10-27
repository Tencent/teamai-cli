/**
 * What the member's finished sessions delivered, folded into the usage report once each (#1387).
 *
 *   report ─ fold(): each member session of the scope's log → its facts in reported-outcomes.json, until it is
 *            │       finished (6 hours idle); a finished one gets its outcomes (learnings recorded for it, commits
 *            │       its member made, the open pull request holding one) and adds to its (run mode, kind) rows
 *            └ push confirmed ─ markReported(): flagged reported, and a `counted` session outcome event written
 *
 * Facts are kept between reports because compaction may drop a session's events once it has been quiet for 30 minutes,
 * long before it is finished. Ids, shas and URLs stay on this machine; the report publishes counts only.
 */
import path from 'node:path';
import { z } from 'zod';
import { RunModeSchema } from './launch-context.js';
import { appendEvent, dataHomeKey, readSessionOutcomes, SESSION_OUTCOME_RETENTION_MS, sessionRuns } from './dashboard-collector.js';
import { addCounts, uniqueOutcomes, type SessionOutcomeEvent, type SessionUsage, type WorkOutcome } from './outcomes.js';
import { interventionsEntry, promptTokensEntry, snapshotPathIn, type ReportedInterventions, type ReportedPromptTokens } from './session-owners.js';
import { FINISHED_AFTER_MS } from './session-flow/session-work.js';
import { getDataHome, type DashboardEvent, type LocalConfig, type UserOutcomeStats } from './types.js';
import { readJson, writeJson } from './utils/fs.js';
import { log } from './utils/logger.js';
import { CommitIdSchema } from './workflow/delivery-schema.js';
import { findDelivered } from './workflow/pr-delivery.js';
import { PrUrlSchema } from './workflow/pr-url.js';
import { git } from './workflow/worktree.js';

const GIT_TIMEOUT_MS = 10_000;

/** What a session's events said of it, kept until it is finished. */
const FactsSchema = z.object({
  activeAt: z.string(),
  tool: z.string().optional(),
  runMode: RunModeSchema.optional(),
  cwd: z.string().optional(),
  startedAt: z.string().optional(),
  startHead: z.string().optional(),
  endHead: z.string().optional(),
  /** The branch checked out at its last Stop that recorded one: the one whose pull request it delivered to. */
  endBranch: z.string().optional(),
});
type Facts = z.infer<typeof FactsSchema>;

const EntrySchema = z.union([z.object({ reported: z.literal(true) }), z.object({ reported: z.literal(false), facts: FactsSchema })]);
type Entry = z.infer<typeof EntrySchema>;

/** A session this report counts, with what it counts it with: what {@link markReported} records of it. */
export type FinishedSession = Pick<SessionOutcomeEvent, 'sessionId' | 'tool' | 'runMode' | 'outcomes'> & { counted: SessionUsage };

/** What `fold` hands the report: the counts to add, and the sessions they count. */
export interface OutcomeFold {
  delta: UserOutcomeStats;
  finished: FinishedSession[];
}

/** The scope's sessions and what the report already folded of them. */
export interface FoldInput {
  config: LocalConfig;
  /** Every event of the log, any scope's: a session another scope recorded takes its outcomes there. */
  logged: DashboardEvent[];
  /** The scope's events, the member's and the sessions teamai launched. */
  scoped: DashboardEvent[];
  /** The scope's events of the member's own sessions (`memberEvents`). */
  member: DashboardEvent[];
  /**
   * What the usage report has counted of each session once this report is pushed, rollouts compaction dropped
   * included, so a session is counted here with the usage the report counts for it.
   */
  totals: { promptTokens: ReportedPromptTokens; interventions: ReportedInterventions };
  now: number;
}

function baselinePath(config: LocalConfig): string {
  return snapshotPathIn(getDataHome(config), 'outcomes');
}

async function readBaseline(config: LocalConfig): Promise<Record<string, Entry>> {
  const parsed = z.record(EntrySchema).safeParse(await readJson<unknown>(baselinePath(config)));
  return parsed.success ? parsed.data : {};
}

/** The facts the scope's member events give each session, merged over what an earlier report kept. */
function factsOf(member: DashboardEvent[], outcomes: SessionOutcomeEvent[]): Map<string, Facts> {
  const facts = new Map<string, Facts>();
  const runs = sessionRuns(member);
  const sorted = [...member].sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
  for (const event of sorted) {
    const known: Facts = facts.get(event.sessionId) ?? { activeAt: event.timestamp };
    const runMode = runs.get(event.sessionId)?.runMode;
    facts.set(event.sessionId, {
      ...known,
      activeAt: event.timestamp,
      tool: event.tool,
      ...(runMode ? { runMode } : {}),
      ...(event.cwd ? { cwd: event.cwd } : {}),
      ...(event.gitAtStart && known.startHead === undefined ? { startedAt: event.timestamp, startHead: event.gitAtStart.head } : {}),
      ...(event.gitHead ? { endHead: event.gitHead } : {}),
      ...(event.gitHead && event.gitBranch ? { endBranch: event.gitBranch } : {}),
    });
  }
  // A session with no event of its own (a tool teamai records no hooks for) is known by its outcomes.
  const withEvents = new Set(facts.keys());
  for (const outcome of outcomes) {
    if (withEvents.has(outcome.sessionId)) continue;
    const known = facts.get(outcome.sessionId);
    const tool = outcome.tool ?? known?.tool;
    const runMode = outcome.runMode ?? known?.runMode;
    facts.set(outcome.sessionId, {
      activeAt: known && known.activeAt > outcome.timestamp ? known.activeAt : outcome.timestamp,
      ...(tool ? { tool } : {}),
      ...(runMode ? { runMode } : {}),
    });
  }
  return facts;
}

/** `kept`, an earlier report's facts, brought up to date with `seen`: the session's start stays the earlier one. */
function merged(kept: Facts | undefined, seen: Facts): Facts {
  if (!kept) return seen;
  const startedEarlier = kept.startHead !== undefined && (seen.startedAt === undefined || (kept.startedAt ?? '') <= seen.startedAt);
  return {
    ...kept,
    ...seen,
    activeAt: kept.activeAt > seen.activeAt ? kept.activeAt : seen.activeAt,
    ...(startedEarlier ? { startedAt: kept.startedAt, startHead: kept.startHead } : {}),
  };
}

/** The session outcomes of the log that are the scope's member's: by their session's scope, else by their own. */
async function scopeOutcomes(input: FoldInput): Promise<SessionOutcomeEvent[]> {
  const key = await dataHomeKey(getDataHome(input.config));
  const scoped = new Set(input.scoped.map((event) => event.sessionId));
  const member = new Set(input.member.map((event) => event.sessionId));
  const logged = new Set(input.logged.map((event) => event.sessionId));
  return (await readSessionOutcomes()).filter((outcome) => !outcome.counted && !outcome.launchedBy
    && (scoped.has(outcome.sessionId) ? member.has(outcome.sessionId) : !logged.has(outcome.sessionId) && outcome.dataHomeKey === key));
}

/** The commits the member authored in `facts.cwd` from the session's start to its last Stop, oldest first. */
async function sessionCommits(facts: Facts): Promise<string[]> {
  const { cwd, startHead, endHead, startedAt } = facts;
  if (!cwd || !startHead || !endHead || startHead === endHead) return [];
  const email = (await git(cwd, ['config', '--get', 'user.email'], { timeoutMs: GIT_TIMEOUT_MS })).stdout.trim();
  if (!email) return [];
  const author = `<${email.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}>`;
  // A commit dated before the session started came in with a pull, whoever wrote it.
  const listed = await git(cwd, [
    'log', '--reverse', '--format=%H', `--author=${author}`, ...(startedAt ? [`--since=${startedAt}`] : []), `${startHead}..${endHead}`,
  ], { timeoutMs: GIT_TIMEOUT_MS });
  return listed.code === 0 ? listed.stdout.split('\n').filter((sha) => CommitIdSchema.safeParse(sha).success) : [];
}

/** A session's pull request lookup that got an answer: the open pull request it found, or none. */
const PrLookupSchema = z.object({ url: PrUrlSchema.optional() });
type PrLookup = z.infer<typeof PrLookupSchema>;

function prCachePath(config: LocalConfig): string {
  return path.join(getDataHome(config), 'dashboard', 'outcome-prs.json');
}

async function readPrCache(config: LocalConfig): Promise<Record<string, PrLookup>> {
  const parsed = z.record(PrLookupSchema).safeParse(await readJson<unknown>(prCachePath(config)));
  return parsed.success ? parsed.data : {};
}

/**
 * The open pull request of `branch`, the one the session last stopped on, when origin's copy of it holds one of
 * `commits`, looked up as `deliver: pr` looks one up. Undefined, so not cached, when the host was not asked (origin's
 * branch holds no commit yet) or gave no answer (the lookup failed, or teamai has no credentials for it).
 */
async function lookUpPr({ cwd, branch, commits }: { cwd: string; branch: string; commits: string[] }): Promise<PrLookup | undefined> {
  const target = (await git(cwd, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'], { timeoutMs: GIT_TIMEOUT_MS })).stdout.trim().replace(/^origin\//, '');
  if (!target || branch === target) return undefined;
  const pushed = await Promise.all(commits.map(async (sha) =>
    (await git(cwd, ['merge-base', '--is-ancestor', sha, `refs/remotes/origin/${branch}`], { timeoutMs: GIT_TIMEOUT_MS })).code === 0));
  if (!pushed.includes(true)) return undefined;
  const found = await findDelivered(cwd, { branch, target });
  switch (found.kind) {
    case 'found': return { url: found.pr };
    case 'none': return {};
    case 'failed':
    case 'unsafe': return undefined;
    default: {
      const unhandled: never = found;
      return unhandled;
    }
  }
}

/**
 * Keep the facts of the scope's member sessions, and fold those that are finished: what each delivered, and the counts
 * it adds to its rows. Nothing is flagged reported here; {@link markReported} does that once the report is pushed.
 */
async function fold(input: FoldInput): Promise<OutcomeFold> {
  const outcomes = await scopeOutcomes(input);
  const baseline = await readBaseline(input.config);
  let changed = false;
  for (const [sessionId, seen] of factsOf(input.member, outcomes)) {
    const entry = baseline[sessionId];
    if (entry?.reported) continue;
    const facts = merged(entry?.facts, seen);
    if (JSON.stringify(facts) !== JSON.stringify(entry?.facts)) {
      baseline[sessionId] = { reported: false, facts };
      changed = true;
    }
  }
  if (changed) await writeJson(baselinePath(input.config), baseline);

  const due = Object.entries(baseline).flatMap(([sessionId, entry]) =>
    (!entry.reported && Date.parse(entry.facts.activeAt) + FINISHED_AFTER_MS <= input.now ? [{ sessionId, facts: entry.facts }] : []));
  // A session's pull request is looked up once, and the answer kept for a report whose push fails.
  const prs = await readPrCache(input.config);
  let prsChanged = false;
  // Each lookup may wait on a host, so they run together; one that fails leaves its pull request out.
  const finished = await Promise.all(due.map(async ({ sessionId, facts }): Promise<FinishedSession> => {
    const commits = await sessionCommits(facts);
    if (commits.length > 0 && facts.cwd && facts.endBranch && !prs[sessionId]) {
      const looked = await lookUpPr({ cwd: facts.cwd, branch: facts.endBranch, commits }).catch((e: unknown) => {
        log.debug(`outcomes: pull request lookup for session ${sessionId} failed: ${e instanceof Error ? e.message : String(e)}`);
        return undefined;
      });
      if (looked) {
        prs[sessionId] = looked;
        prsChanged = true;
      }
    }
    const pr = prs[sessionId]?.url;
    const { tokens } = promptTokensEntry(input.totals.promptTokens[sessionId]);
    const interventions = Object.values(interventionsEntry(input.totals.interventions[sessionId])).reduce((sum, n) => sum + n, 0);
    return {
      sessionId,
      ...(facts.tool ? { tool: facts.tool } : {}),
      ...(facts.runMode ? { runMode: facts.runMode } : {}),
      outcomes: uniqueOutcomes([
        ...commits.map((sha): WorkOutcome => ({ kind: 'commit', sha })),
        ...(pr ? [{ kind: 'pr' as const, url: pr }] : []),
        ...outcomes.filter((outcome) => outcome.sessionId === sessionId).flatMap((outcome) => outcome.outcomes),
      ]),
      counted: { tokens: { input: tokens.input, output: tokens.output }, interventions },
    };
  }));
  if (prsChanged) await writeJson(prCachePath(input.config), prs);
  return { delta: rowsOf(finished), finished };
}

/** The rows `sessions` add up to: each in its run mode's row of every kind it delivered, or of `none`. */
function rowsOf(sessions: readonly FinishedSession[]): UserOutcomeStats {
  const rows: UserOutcomeStats = {};
  for (const session of sessions) {
    const mode = (rows[session.runMode ?? 'notRecorded'] ??= {});
    const kinds = new Set(session.outcomes.map((outcome) => outcome.kind));
    for (const kind of kinds.size > 0 ? kinds : ['none' as const]) mode[kind] = addCounts(mode[kind], { sessions: 1, ...session.counted });
  }
  return rows;
}

const SUMMARY_RECENT_LIMIT = 20;

/** A finished session as the dashboard lists it. */
export type CountedSession = FinishedSession & { countedAt: string };

/** What the dashboard shows of the finished sessions the report counted in the last 30 days. */
export interface OutcomeSummary {
  sessions: number;
  /** The sessions that delivered at least one outcome. */
  delivered: number;
  rows: UserOutcomeStats;
  /** The latest 20, newest first. */
  recent: CountedSession[];
}

/**
 * The finished sessions the report counted in the last 30 days, as long as compaction keeps their lines, from the
 * `counted` session outcome events {@link markReported} wrote: those of the scope whose data home key is `dataHomeKey`,
 * or every scope's without one.
 */
function summarize(events: readonly SessionOutcomeEvent[], { dataHomeKey: key, now }: { dataHomeKey?: string; now: number }): OutcomeSummary {
  const counted = events.flatMap(({ sessionId, tool, runMode, outcomes, counted: usage, timestamp, dataHomeKey: eventKey }): CountedSession[] =>
    (usage && (key === undefined || eventKey === key) && now - Date.parse(timestamp) <= SESSION_OUTCOME_RETENTION_MS
      ? [{ sessionId, ...(tool ? { tool } : {}), ...(runMode ? { runMode } : {}), countedAt: timestamp, outcomes, counted: usage }]
      : []));
  return {
    sessions: counted.length,
    delivered: counted.filter((session) => session.outcomes.length > 0).length,
    rows: rowsOf(counted),
    recent: counted.sort((a, b) => Date.parse(b.countedAt) - Date.parse(a.countedAt)).slice(0, SUMMARY_RECENT_LIMIT),
  };
}

/**
 * Once the report that counted `finished` is pushed: each is flagged reported, its outcomes recorded here, and its
 * pull request lookup, which no later report needs, dropped.
 */
async function markReported(config: LocalConfig, finished: readonly FinishedSession[]): Promise<void> {
  if (finished.length === 0) return;
  const baseline = await readBaseline(config);
  for (const { sessionId } of finished) baseline[sessionId] = { reported: true };
  await writeJson(baselinePath(config), baseline);
  const prs = await readPrCache(config);
  const looked = finished.filter(({ sessionId }) => Object.hasOwn(prs, sessionId));
  for (const { sessionId } of looked) delete prs[sessionId];
  if (looked.length > 0) await writeJson(prCachePath(config), prs);
  const key = await dataHomeKey(getDataHome(config));
  const timestamp = new Date().toISOString();
  for (const session of finished) {
    await appendEvent({
      type: 'session_outcome', timestamp, sessionId: session.sessionId, ...(session.tool ? { tool: session.tool } : {}), dataHomeKey: key,
      ...(session.runMode ? { runMode: session.runMode } : {}), outcomes: session.outcomes, counted: session.counted,
    });
  }
}

export const SessionOutcomes = { fold, markReported, summarize } as const;
