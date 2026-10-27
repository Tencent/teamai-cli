/**
 * What the member's finished sessions delivered, folded into the usage report once each (#1387).
 *
 *   report ─ fold(): each member session of the scope's log → its facts in reported-outcomes.json, until it is
 *            │       finished (6 hours idle, or unattended at a drain); a finished one gets its outcomes (learnings recorded for it, commits
 *            │       its member made, the open pull request holding one, as a report found it) and adds to its
 *            │       (run mode, kind) rows
 *            └ push confirmed ─ markReported(): flagged reported, and a `counted` session outcome event written
 *
 * Facts are kept between reports because compaction may drop a session's events once it has been quiet for 30 minutes,
 * long before it is finished. Ids, shas and URLs stay on this machine; the report publishes counts only. The first report
 * on a release with this file counts none of the sessions already finished: the release that recorded them kept no Stop
 * head and no learning of theirs, so each would count as one that delivered nothing.
 */
import path from 'node:path';
import { z } from 'zod';
import { RunModeSchema } from './launch-context.js';
import { appendEvent, dataHomeKey, readSessionOutcomes, SESSION_OUTCOME_RETENTION_MS, sessionRuns } from './dashboard-collector.js';
import { addCounts, uniqueOutcomes, type SessionOutcomeEvent, type SessionUsage, type WorkOutcome } from './outcomes.js';
import { interventionsEntry, promptTokensEntry, snapshotPathIn, type ReportedInterventions, type ReportedPromptTokens } from './session-owners.js';
import { FINISHED_AFTER_MS } from './session-flow/session-work.js';
import { getDataHome, type DashboardEvent, type LocalConfig, type UserOutcomeStats } from './types.js';
import { pathExists, readJson, writeJson } from './utils/fs.js';
import { checkoutForProjectAnchor, getCurrentBranch, getDefaultBranch, getHeadCommit } from './utils/git.js';
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
  /** The repository `cwd` is in (`projectAnchor`), whose other checkouts still hold its commits once `cwd` is removed. */
  anchor: z.string().optional(),
  /** Its first start, and the head that start saw: none in a repository with no commit yet, or when git failed. */
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
  /**
   * Set when `teamai score --drain` makes this report, which ends the job of every unattended session here (#1385).
   * `running` is the agent session that runs it: its last turn has no Stop yet, so its checkout is read now.
   */
  drain?: { running?: string };
}

function baselinePath(config: LocalConfig): string {
  return snapshotPathIn(getDataHome(config), 'outcomes');
}

/** The scope's baseline, or none before its first report on this release (or when the file is not readable). */
async function readBaseline(config: LocalConfig): Promise<Record<string, Entry> | undefined> {
  const parsed = z.record(EntrySchema).safeParse(await readJson<unknown>(baselinePath(config)));
  return parsed.success ? parsed.data : undefined;
}

function isIdle(facts: Facts, now: number): boolean {
  return Date.parse(facts.activeAt) + FINISHED_AFTER_MS <= now;
}

/** Idle for 6 hours, or unattended at a drain: an ephemeral runner's sessions are counted before the job ends. */
function isFinished(facts: Facts, { now, drain }: Pick<FoldInput, 'now' | 'drain'>): boolean {
  return isIdle(facts, now) || (drain !== undefined && facts.runMode === 'unattended');
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
      ...(event.projectAnchor ? { anchor: event.projectAnchor } : {}),
      ...(event.type === 'session_start' && known.startedAt === undefined
        ? { startedAt: event.timestamp, ...(event.gitAtStart ? { startHead: event.gitAtStart.head } : {}) } : {}),
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
  const { startedAt, startHead } = kept.startedAt !== undefined && (seen.startedAt === undefined || kept.startedAt <= seen.startedAt) ? kept : seen;
  return {
    ...kept,
    ...seen,
    activeAt: kept.activeAt > seen.activeAt ? kept.activeAt : seen.activeAt,
    startedAt,
    startHead,
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

/** Where the session's git is read: its own checkout, else, once that is gone (a removed worktree), one of its repository. */
async function checkoutOf(facts: Facts): Promise<string | undefined> {
  if (facts.cwd && await pathExists(facts.cwd)) return facts.cwd;
  return facts.anchor ? await checkoutForProjectAnchor(facts.anchor) ?? undefined : undefined;
}

/** `facts` with the head and branch `cwd` has checked out now, as its Stop would record them. */
async function withHeadNow(facts: Facts, cwd: string): Promise<Facts> {
  const [head, branch] = await Promise.all([getHeadCommit(cwd), getCurrentBranch(cwd)]);
  return head ? { ...facts, endHead: head, ...(branch ? { endBranch: branch } : {}) } : facts;
}

/** The commits the member authored in `cwd`, the session's checkout, from its start to its last Stop, oldest first. */
async function sessionCommits(cwd: string, facts: Facts): Promise<string[]> {
  const { startHead, endHead, startedAt } = facts;
  if (!endHead || !startedAt || startHead === endHead) return [];
  const email = (await git(cwd, ['config', '--get', 'user.email'], { timeoutMs: GIT_TIMEOUT_MS })).stdout.trim();
  if (!email) return [];
  // A commit dated before the session started came in with a pull, whoever wrote it. A start with no head (a repository
  // with no commit yet, or git that failed) leaves the start time alone to bound the session's commits.
  const listed = await git(cwd, [
    'log', '--reverse', '--format=%H', '--fixed-strings', `--author=<${email}>`, `--since=${startedAt}`, startHead ? `${startHead}..${endHead}` : endHead,
  ], { timeoutMs: GIT_TIMEOUT_MS });
  return listed.code === 0 ? listed.stdout.split('\n').filter((sha) => CommitIdSchema.safeParse(sha).success) : [];
}

/** A session's pull request lookup that got an answer, for the branch it asked about: the open pull request it found, or none. */
const PrLookupSchema = z.object({ branch: z.string(), url: PrUrlSchema.optional() });
type PrLookup = z.infer<typeof PrLookupSchema>;

function prCachePath(config: LocalConfig): string {
  return path.join(getDataHome(config), 'dashboard', 'outcome-prs.json');
}

async function readPrCache(config: LocalConfig): Promise<Record<string, PrLookup>> {
  const parsed = z.record(PrLookupSchema).safeParse(await readJson<unknown>(prCachePath(config)));
  return parsed.success ? parsed.data : {};
}

/**
 * The open pull request of `branch`, the last one the session stopped on, when origin's copy of it holds one of
 * `commits`, looked up as `deliver: pr` looks one up. Undefined, so not cached, when the host was not asked (origin's
 * branch holds no commit yet) or gave no answer (the lookup failed, or teamai has no credentials for it).
 */
async function lookUpPr({ cwd, branch, commits }: { cwd: string; branch: string; commits: string[] }): Promise<PrLookup | undefined> {
  const target = await getDefaultBranch(cwd);
  if (branch === target) return undefined;
  const pushed = await Promise.all(commits.map(async (sha) =>
    (await git(cwd, ['merge-base', '--is-ancestor', sha, `refs/remotes/origin/${branch}`], { timeoutMs: GIT_TIMEOUT_MS })).code === 0));
  if (!pushed.includes(true)) return undefined;
  const found = await findDelivered(cwd, { branch, target });
  switch (found.kind) {
    case 'found': return { branch, url: found.pr };
    case 'none': return { branch };
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
  const kept = await readBaseline(input.config);
  const baseline = kept ?? {};
  // Written on the first report even with no session, so a later one never takes its sessions for an earlier release's.
  let changed = kept === undefined;
  for (const [sessionId, seen] of factsOf(input.member, outcomes)) {
    const entry = baseline[sessionId];
    if (entry?.reported) continue;
    const facts = merged(entry?.facts, seen);
    // A drain's first report is an ephemeral runner's every report, so only idle sessions are an earlier release's.
    if (kept === undefined && isIdle(facts, input.now)) {
      baseline[sessionId] = { reported: true };
    } else if (JSON.stringify(facts) !== JSON.stringify(entry?.facts)) {
      baseline[sessionId] = { reported: false, facts };
      changed = true;
    }
  }
  if (changed) await writeJson(baselinePath(input.config), baseline);

  const pending = Object.entries(baseline).flatMap(([sessionId, entry]) =>
    (entry.reported ? [] : [{ sessionId, facts: entry.facts, isDue: isFinished(entry.facts, input) }]));
  // A session's pull request is looked up at each report until one is found, so one merged before the session is
  // finished still counts, and once more when it is; the answer is kept for a report whose push fails.
  const prs = await readPrCache(input.config);
  let prsChanged = false;
  // Each lookup may wait on a host, so they run together; one that fails leaves its pull request out.
  const finished = (await Promise.all(pending.map(async ({ sessionId, facts: kept, isDue }): Promise<FinishedSession[]> => {
    const cwd = await checkoutOf(kept);
    const facts = cwd && isDue && sessionId === input.drain?.running ? await withHeadNow(kept, cwd) : kept;
    const commits = cwd ? await sessionCommits(cwd, facts) : [];
    // A session that has since stopped on another branch is asked about that one.
    if (cwd && commits.length > 0 && facts.endBranch && prs[sessionId]?.branch !== facts.endBranch) {
      const looked = await lookUpPr({ cwd, branch: facts.endBranch, commits }).catch((e: unknown) => {
        log.debug(`outcomes: pull request lookup for session ${sessionId} failed: ${e instanceof Error ? e.message : String(e)}`);
        return undefined;
      });
      // A session still going may yet open one, so it keeps only a pull request found.
      if (looked && (isDue || looked.url)) {
        prs[sessionId] = looked;
        prsChanged = true;
      }
    }
    if (!isDue) return [];
    const lookup: PrLookup | undefined = prs[sessionId];
    const pr = lookup && lookup.branch === facts.endBranch ? lookup.url : undefined;
    const { tokens } = promptTokensEntry(input.totals.promptTokens[sessionId]);
    const interventions = Object.values(interventionsEntry(input.totals.interventions[sessionId])).reduce((sum, n) => sum + n, 0);
    return [{
      sessionId,
      ...(facts.tool ? { tool: facts.tool } : {}),
      ...(facts.runMode ? { runMode: facts.runMode } : {}),
      outcomes: uniqueOutcomes([
        ...commits.map((sha): WorkOutcome => ({ kind: 'commit', sha })),
        ...(pr ? [{ kind: 'pr' as const, url: pr }] : []),
        ...outcomes.filter((outcome) => outcome.sessionId === sessionId).flatMap((outcome) => outcome.outcomes),
      ]),
      counted: { tokens: { input: tokens.input, output: tokens.output }, interventions },
    }];
  }))).flat();
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
  const baseline = await readBaseline(config) ?? {};
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
