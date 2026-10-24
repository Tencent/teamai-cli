import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { collectTeamSecrets } from '../env-resolution.js';
import { pinScorers } from '../scorers/cache.js';
import { AgentSession } from '../session-flow/agent-session.js';
import { archiveSessions, type ArchiveSessionRef } from '../session-flow/archive.js';
import { usesBranchWorktree, type LocalConfig } from '../types.js';
import { canonicalJson } from '../utils/canonical-json.js';
import { collectEnvSecrets, sanitizeGitUrl } from '../utils/redact.js';
import { fetchReportsOriginFile, updateReports, type ReportsChange } from '../utils/reports-branch.js';
import { loadWorkflowBundle, loadWorkflowBundleAt, type WorkflowBundle } from './cache.js';
import { pendingRecords, publishPendingRecords, type RecordDelivery } from './records.js';
import {
  definitionHash, parseSnapshot, projectRun, snapshotBody, snapshotPath, snapshotText,
  type HandoffOwner, type RunSnapshot, type SnapshotBody, type SnapshotError,
} from './snapshot.js';
import { takeOver, type UnleasedStep } from './step-state.js';
import { installOwner, isRunId, readRun, updateRun } from './store.js';
import type { RunState, WorkflowDefinition } from './types.js';
import { branchName, stepMode, type LeaseSession, type SessionRef } from './workspace.js';
import { git } from './worktree.js';

/**
 * Hands a run from one teamai install to another through `teamai-reports`. The install that owns a run is the only one
 * that publishes it; another takes it with a claim, which origin accepts only over the state it read.
 */

export type HandoffError =
  | SnapshotError
  | { code: 'not_owner'; owner: HandoffOwner; ownedAt: string; message: string }
  | { code: 'busy'; message: string }
  | { code: 'invalid_run'; message: string }
  | { code: 'unsupported_repo'; message: string }
  | { code: 'reports_unreachable'; message: string }
  | { code: 'reports_failed'; message: string }
  | { code: 'run_not_found'; message: string }
  | { code: 'run_unreadable'; message: string }
  | { code: 'run_not_published'; message: string }
  | { code: 'run_mismatch'; localCreatedAt: string; remoteCreatedAt: string; message: string }
  | { code: 'state_conflict'; message: string }
  | { code: 'state_moved'; message: string }
  | { code: 'definition_mismatch'; teamRevision?: string; message: string }
  | { code: 'records_pending'; message: string }
  | { code: 'sessions_not_archived'; message: string }
  | { code: 'origin_unavailable'; message: string }
  | { code: 'commit_missing'; branch: string; commit: string; message: string }
  | { code: 'branch_diverged'; branch: string; expected: string; actual: string; message: string };

export type Result<T> = { ok: true; value: T } | { ok: false; error: HandoffError };

/** A lease the run held when it was published; whoever claims the run releases it. */
export interface InFlightLease {
  step: string;
  attempt: string;
  driverKind: string;
}

export interface PublishReceipt {
  run: string;
  publication: 'published' | 'unchanged';
  stateRevision: number;
  inFlight: InFlightLease[];
  /** When asked to: the sessions put in the team session archive, which the steps that have not settled continue. */
  sessions?: SessionRef[];
  /** When asked to: the newer sessions of a chain this machine could not read, which the archive does not hold. */
  skipped?: SessionRef[];
}

export interface ClaimReceipt {
  run: string;
  /** `claimed` when this machine installed the published state, `already_owned` when it kept its own. */
  ownership: 'claimed' | 'already_owned';
  owner: HandoffOwner;
  stateRevision: number;
}

function ok<T>(value: T): Result<T> {
  return { ok: true, value };
}

function refused(error: HandoffError): { ok: false; error: HandoffError } {
  return { ok: false, error };
}

const UNSUPPORTED_REPO: HandoffError = {
  code: 'unsupported_repo',
  message: 'Handing a run to another machine needs a team repo with a teamai-reports branch; an http team repo has none.',
};

const INVALID_RUN: HandoffError = {
  code: 'invalid_run',
  message: 'Run id must look like r followed by 8 or 16 hex digits',
};

const REPORTS_BUSY: HandoffError = {
  code: 'busy',
  message: 'Another teamai process is writing teamai-reports; try again.',
};

function runBusy(runId: string): HandoffError {
  return { code: 'busy', message: `Run ${runId} is locked by another process; try again.` };
}

function runUnreadable(runId: string): HandoffError {
  return { code: 'run_unreadable', message: `Run ${runId} could not be read` };
}

function unreachable(reason: string): HandoffError {
  return {
    code: 'reports_unreachable',
    message: `teamai-reports could not be read from the team repo's origin (${sanitizeGitUrl(reason)}). Check the connection and try again.`,
  };
}

function notOwner(runId: string, snapshot: RunSnapshot): HandoffError {
  return {
    code: 'not_owner',
    owner: snapshot.owner,
    ownedAt: snapshot.ownedAt,
    message: `Run ${runId} is owned by ${snapshot.owner.user} (install ${snapshot.owner.id}) since ${snapshot.ownedAt}. To take it over: teamai workflow resume ${runId} --claim`,
  };
}

function mismatch(runId: string, local: RunState, snapshot: RunSnapshot): HandoffError {
  return {
    code: 'run_mismatch',
    localCreatedAt: local.createdAt,
    remoteCreatedAt: snapshot.createdAt,
    message: `Run ${runId} here started at ${local.createdAt}, and the run published under that id started at ${snapshot.createdAt}: they are different runs.`,
  };
}

function claimedElsewhere(runId: string, owner: HandoffOwner, ownedAt: string): HandoffError {
  return {
    code: 'not_owner',
    owner,
    ownedAt,
    message: `Run ${runId} is owned by ${owner.user} (install ${owner.id}) since ${ownedAt}, so how it ended on this machine, and its run record, were not published to teamai-reports. Only that install can publish them.`,
  };
}

function stateConflict(runId: string, published: number, seen: number): HandoffError {
  return {
    code: 'state_conflict',
    message: `Run ${runId} on teamai-reports is at state revision ${published}, and this machine last saw ${seen}. Resume it to take the published state: teamai workflow resume ${runId}`,
  };
}

type OriginSnapshot = Result<RunSnapshot | 'absent'>;

async function readOrigin(dir: string, runId: string): Promise<OriginSnapshot> {
  const read = await fetchReportsOriginFile(dir, snapshotPath(runId));
  switch (read.status) {
    case 'absent':
      return ok('absent');
    case 'unreachable':
      return refused(unreachable(read.reason));
    case 'found':
      return parseSnapshot(read.text, runId);
    default: {
      const unhandled: never = read;
      return unhandled;
    }
  }
}

/** The state revision of `snapshot` this machine has seen: its own write counts once origin shows it. */
function acknowledged(local: RunState, snapshot: RunSnapshot): number {
  if (local.publication?.pending === snapshot.write) return snapshot.stateRevision;
  return local.publication?.stateRevision ?? 0;
}

function inFlight(body: SnapshotBody): InFlightLease[] {
  return body.steps.flatMap((step) => (step.status === 'leased'
    ? [{ step: step.id, attempt: step.lease.attempt, driverKind: step.lease.driverKind }]
    : []));
}

/** What a publish decided inside its reports write. */
type PublishVerdict =
  | { kind: 'unchanged'; snapshot: RunSnapshot }
  | { kind: 'write'; snapshot: RunSnapshot };

/**
 * Publishes run `runId` to `teamai-reports` as this install's. The first publish makes this install the owner; a later
 * one needs origin to still show this install and the state revision it last saw. Publishing an unchanged run writes
 * nothing. A run another install owns is refused before anything is pushed, archived, or drained. The run's branches are
 * checked on the origin of the business checkout the run records, else of `checkout`.
 *
 * With `sessions`, the sessions it picks from the run are put in the team session archive first, scrubbed, so they can
 * be there even when the snapshot is then refused. The engine picks them: this module does not import the engine.
 */
export async function publishRun(
  config: LocalConfig,
  runId: string,
  options: { checkout: string; env?: NodeJS.ProcessEnv; sessions?: (run: RunState) => LeaseSession[] },
): Promise<Result<PublishReceipt>> {
  if (!isRunId(runId)) return refused(INVALID_RUN);
  if (!usesBranchWorktree(config)) return refused(UNSUPPORTED_REPO);
  const env = options.env ?? process.env;
  const stored = await readRun(config, runId);
  if (stored === 'missing') return refused({ code: 'run_not_found', message: `Run ${runId} was not found` });
  if (stored === 'corrupt') return refused(runUnreadable(runId));
  const secrets = { ...collectEnvSecrets(env), ...await collectTeamSecrets(config, env) };
  const projected = projectRun(stored, secrets);
  if (!projected.ok) return projected;
  const checked = checkedOutsideLocks(stored, options.sessions);
  const owner = await installOwner(config);
  const before = await readPublished(config, runId);
  if (!before.ok) return before;
  const elsewhere = before.value === 'absent' ? undefined : ownershipRefusal(stored, before.value, owner);
  if (elsewhere) return refused(elsewhere);
  // Origin already holds the run as it is, so there is nothing to write and nothing to check on the business origin: a
  // finished run's branches may be gone or have moved on, and its end is not published again.
  if (before.value !== 'absent' && options.sessions === undefined && holdsRun(stored, before.value, projected.value)
    && !(await pendingRecords(config)).some((record) => record.run === runId)) {
    return ok(receipt(runId, 'unchanged', before.value));
  }
  const checkout = stored.checkout ?? options.checkout;
  const pinned = await checkOrigin(checkout, stored, { side: 'publish' });
  if (!pinned.ok) return pinned;

  const drained = await publishPendingRecords(config, { run: runId })
    .catch((error: unknown): RecordDelivery => ({ state: 'pending', reason: error instanceof Error ? error.message : String(error) }));
  if (drained.state === 'pending') return refused(recordsPending(runId, drained.reason));
  const shared = options.sessions ? await shareSessions(config, runId, options.sessions(stored), checkout) : undefined;
  if (shared && !shared.ok) return shared;
  const sessions = shared?.value;

  const result = await updateReports(config, async (worktree): Promise<ReportsChange<Result<PublishVerdict>>> => {
    const origin = await readOrigin(worktree, runId);
    const verdict = origin.ok ? await decideLocked(config, runId, { origin: origin.value, checked, sessions: options.sessions, owner, secrets }) : origin;
    if (!verdict.ok) return { value: verdict, write: null };
    const write = verdict.value.kind === 'write' ? await writeSnapshot(worktree, verdict.value.snapshot, `[teamai] Publish workflow run ${runId}`) : null;
    return { value: verdict, write };
  });
  const verdict = result.value;
  if (verdict === undefined) return refused(result.status === 'busy' ? REPORTS_BUSY : writeFailed(runId, result));
  if (!verdict.ok) return verdict;
  const decided = verdict.value;
  if (decided.kind === 'unchanged') return ok(receipt(runId, 'unchanged', decided.snapshot, sessions));
  const written = decided.snapshot;
  if (result.status !== 'published' && result.status !== 'already-present') {
    // The commit may still have landed, or may land with the next reports write: origin decides.
    const origin = await readPublished(config, runId);
    if (origin.ok && origin.value !== 'absent' && origin.value.write === written.write) {
      return acknowledge(config, runId, written, sessions);
    }
    if (origin.ok && origin.value !== 'absent' && origin.value.owner.id !== owner.id) return refused(notOwner(runId, origin.value));
    if (!origin.ok && origin.error.code === 'reports_unreachable') return refused(origin.error);
    return refused(writeFailed(runId, result));
  }
  return acknowledge(config, runId, written, sessions);
}

/** Decides a publish under the run lock, refusing while a record of the run waits to reach teamai-reports. */
async function decideLocked(config: LocalConfig, runId: string, against: PublishAgainst): Promise<Result<PublishVerdict>> {
  const locked = await updateRun(config, runId, async (local): Promise<{ value: Result<PublishVerdict>; write?: RunState }> => {
    if (local === 'missing') return { value: refused({ code: 'run_not_found', message: `Run ${runId} was not found` }) };
    // A run's end record is queued under this lock, so none can arrive between this check and the snapshot.
    if ((await pendingRecords(config)).some((record) => record.run === runId)) {
      return { value: refused(recordsPending(runId, 'a record of the run was queued while it was being published')) };
    }
    return decidePublish(local, against);
  });
  switch (locked.status) {
    case 'done':
      return locked.value;
    case 'busy':
      return refused(runBusy(runId));
    case 'corrupt':
      return refused(runUnreadable(runId));
    default: {
      const unhandled: never = locked;
      return unhandled;
    }
  }
}

/** The sessions a publish put in the team session archive, and the ones of a chain this machine could not read. */
interface SessionShare {
  archived: SessionRef[];
  skipped: SessionRef[];
}

/** A session of a chain, with the platform this machine's archive knows its tool by. */
type ChainRef = SessionRef & ArchiveSessionRef;

/**
 * Puts, in the team session archive, the newest session of each chain of run `runId` that this machine's tools can read.
 * The newer sessions of a chain that it cannot read are skipped and listed; a chain with none readable refuses the publish.
 */
async function shareSessions(config: LocalConfig, runId: string, chains: LeaseSession[], checkout: string): Promise<Result<SessionShare>> {
  const skipped: SessionRef[] = [];
  const readable: ChainRef[][] = [];
  for (const chain of chains) {
    const refs: ChainRef[] = [];
    for (const session of [chain, ...(chain.earlier ?? [])]) {
      const platform = AgentSession.platformForTool(session.tool);
      if (platform) refs.push({ tool: session.tool, id: session.id, platform, sessionId: session.id });
      else skipped.push({ tool: session.tool, id: session.id });
    }
    if (refs.length === 0) return refused(sessionsNotArchived(runId, `teamai cannot read sessions of ${chain.tool}.`));
    readable.push(refs);
  }
  if (readable.length === 0) return ok({ archived: [], skipped });
  const archived = await archiveSessions(config, readable, { run: runId, checkout });
  if (archived.status === 'failed') return refused(sessionsNotArchived(runId, archived.message));
  return ok({
    archived: archived.archived.map(sessionRef),
    skipped: [...skipped, ...archived.skipped.map(sessionRef)],
  });
}

function sessionRef({ tool, id }: SessionRef): SessionRef {
  return { tool, id };
}

function sessionsNotArchived(runId: string, reason: string): HandoffError {
  return {
    code: 'sessions_not_archived',
    message: `Run ${runId} was not published: the sessions its steps continue did not reach the team session archive. ${sanitizeGitUrl(reason)} ` +
      'Publish again, or publish without --sessions and those steps start new sessions.',
  };
}

async function writeSnapshot(worktree: string, snapshot: RunSnapshot, message: string): Promise<{ files: string[]; message: string }> {
  const rel = snapshotPath(snapshot.run);
  await fs.mkdir(path.join(worktree, path.dirname(rel)), { recursive: true });
  await fs.writeFile(path.join(worktree, rel), snapshotText(snapshot), 'utf-8');
  return { files: [rel], message };
}

/** A publish that would leave records of the run behind: they would reach teamai-reports after the run had moved on. */
function recordsPending(runId: string, reason: string): HandoffError {
  return {
    code: 'records_pending',
    message: `Run ${runId} was not published: its run records did not reach teamai-reports (${sanitizeGitUrl(reason.trim())}). Publish it again: teamai workflow publish ${runId}`,
  };
}

function writeFailed(runId: string, result: { status: string; reason?: string }): HandoffError {
  const reason = result.reason === undefined ? '' : ` (${sanitizeGitUrl(result.reason)})`;
  return { code: 'reports_failed', message: `Run ${runId} could not be written to teamai-reports${reason}. Try again.` };
}

function receipt(runId: string, publication: PublishReceipt['publication'], snapshot: RunSnapshot, shared?: SessionShare): PublishReceipt {
  return {
    run: runId, publication, stateRevision: snapshot.stateRevision, inFlight: inFlight(snapshot),
    ...(shared ? { sessions: shared.archived, ...(shared.skipped.length > 0 ? { skipped: shared.skipped } : {}) } : {}),
  };
}

/**
 * Checks, with `ls-remote` on the origin of business checkout `checkout`, that every workspace of run `run` is on origin
 * at the commit the run recorded, and that its base is pinned as `teamai/<run>/base`, which a driver's fetch of the run's
 * branches brings in wherever the base came from. A publish pins a missing base; nothing else is pushed or fetched.
 */
async function checkOrigin(
  checkout: string,
  run: { id: string; base?: { commit: string }; copies?: Record<string, { commit?: string }> },
  by: { side: 'publish' } | { side: 'claim'; publisher: HandoffOwner },
): Promise<Result<void>> {
  const recorded = Object.entries(run.copies ?? {}).flatMap(([branch, copy]) => (copy.commit === undefined ? [] : [{ branch, commit: copy.commit }]));
  const pin = `teamai/${run.id}/base`;
  if (!run.base && recorded.length === 0) return ok(undefined);
  const listed = await git(checkout, ['ls-remote', '--heads', 'origin', `refs/heads/teamai/${run.id}/*`]);
  if (listed.code !== 0) return refused(originUnavailable(checkout, 'read', listed.stderr));
  const heads = new Map(listed.stdout.split('\n').flatMap((line) => {
    const [commit, ref] = line.trim().split(/\s+/);
    return commit && ref?.startsWith('refs/heads/') ? [[ref.slice('refs/heads/'.length), commit] as const] : [];
  }));
  const expected = [...(run.base ? [{ branch: pin, commit: run.base.commit }] : []), ...recorded];
  for (const { branch, commit } of expected) {
    const actual = heads.get(branch);
    if (actual === commit) continue;
    // Only the publishing checkout has the recorded commit, and so can tell a push that did not land from other work.
    if (actual !== undefined && by.side === 'publish' && (await git(checkout, ['merge-base', '--is-ancestor', actual, commit])).code === 0) {
      return refused({
        code: 'commit_missing',
        branch,
        commit,
        message: `Branch ${branch} on the origin of ${checkout} is at ${actual}, behind commit ${commit} that run ${run.id} recorded: that push did not land. Push it from this checkout, then publish again: git -C ${checkout} push origin ${commit}:refs/heads/${branch}`,
      });
    }
    if (actual !== undefined) {
      return refused({
        code: 'branch_diverged',
        branch,
        expected: commit,
        actual,
        message: by.side === 'publish'
          ? `Branch ${branch} on the origin of ${checkout} is at ${actual}, and run ${run.id} recorded ${commit}. Either have the driver that pushed ${actual} report it, or move ${branch} on origin back to ${commit}, then try again; teamai moves neither.`
          : `Branch ${branch} on the origin of ${checkout} is at ${actual}, and run ${run.id} recorded ${commit} when ${by.publisher.user} last published it. If ${by.publisher.user} continued the run since, ${by.publisher.user} can publish it again: teamai workflow publish ${run.id}. Moving ${branch} on origin back to ${commit} discards the commits on it past ${commit}; teamai does not move it.`,
      });
    }
    if (branch !== pin || by.side === 'claim') {
      return refused({
        code: 'commit_missing',
        branch,
        commit,
        message: `Branch ${branch} is not on the origin of ${checkout}, and run ${run.id} recorded commit ${commit} on it. Push it from the machine that has the commit, then try again.`,
      });
    }
    const pushed = await git(checkout, ['push', '--quiet', 'origin', `${commit}:refs/heads/${pin}`]);
    if (pushed.code === 0) continue;
    if ((await git(checkout, ['cat-file', '-e', `${commit}^{commit}`])).code !== 0) {
      return refused({
        code: 'commit_missing',
        branch,
        commit,
        message: `Run ${run.id} started from commit ${commit}, which ${checkout} does not have, so it cannot be pinned on origin as ${pin}. Publish from the checkout the run started in.`,
      });
    }
    return refused(originUnavailable(checkout, 'updated', pushed.stderr));
  }
  return ok(undefined);
}

function originUnavailable(checkout: string, action: 'read' | 'updated', stderr: string): HandoffError {
  return {
    code: 'origin_unavailable',
    message: `The origin of ${checkout} could not be ${action} (${sanitizeGitUrl(stderr.trim()) || 'git failed'}). Run this from the run's business checkout, with access to its origin.`,
  };
}

/**
 * What a publish checked before it took the locks: the base and the commits it found on the business origin, and the
 * sessions it put in the archive. The rest of the run may move meanwhile, and is published as the locks find it.
 */
function checkedOutsideLocks(run: RunState, sessions?: (run: RunState) => LeaseSession[]): string {
  const commits = Object.entries(run.copies ?? {}).flatMap(([branch, copy]) => (copy.commit === undefined ? [] : [[branch, copy.commit]]));
  return canonicalJson({ base: run.base?.commit, commits: Object.fromEntries(commits), sessions: sessions?.(run) ?? [] });
}

/** What a publish decides against: the snapshot origin holds, and what it checked of the run outside the locks. */
interface PublishAgainst {
  origin: RunSnapshot | 'absent';
  checked: string;
  sessions?: (run: RunState) => LeaseSession[];
  owner: HandoffOwner;
  secrets: Record<string, string>;
}

/** Decides a publish against the snapshot origin holds, and records the write it makes before it is pushed. */
async function decidePublish(
  local: RunState,
  { origin, checked, sessions, owner, secrets }: PublishAgainst,
): Promise<{ value: Result<PublishVerdict>; write?: RunState }> {
  const body = projectRun(local, secrets);
  if (!body.ok) return { value: body };
  if (checkedOutsideLocks(local, sessions) !== checked) return { value: refused(publishMoved(local.id)) };
  const now = new Date().toISOString();
  if (origin === 'absent') {
    const seen = local.publication?.stateRevision ?? 0;
    const snapshot = header(local.id, owner, now, seen + 1, body.value);
    return { value: ok({ kind: 'write', snapshot }), write: published(local, { stateRevision: seen, pending: snapshot.write }) };
  }
  const elsewhere = ownershipRefusal(local, origin, owner);
  if (elsewhere) return { value: refused(elsewhere) };
  const seen = acknowledged(local, origin);
  if (seen !== origin.stateRevision) return { value: refused(stateConflict(local.id, origin.stateRevision, seen)) };
  if (canonicalJson(body.value) === canonicalJson(snapshotBody(origin))) {
    const write = local.publication?.pending === undefined ? undefined : published(local, { stateRevision: seen });
    return { value: ok({ kind: 'unchanged', snapshot: origin }), ...(write ? { write } : {}) };
  }
  const snapshot = header(local.id, owner, origin.ownedAt, origin.stateRevision + 1, body.value);
  return { value: ok({ kind: 'write', snapshot }), write: published(local, { stateRevision: seen, pending: snapshot.write }) };
}

/**
 * Whether origin's snapshot already holds run `local` as it is: the same body, at the state revision this machine
 * acknowledged, with no write of this machine's still pending.
 */
function holdsRun(local: RunState, origin: RunSnapshot, body: SnapshotBody): boolean {
  return local.publication?.pending === undefined
    && acknowledged(local, origin) === origin.stateRevision
    && canonicalJson(body) === canonicalJson(snapshotBody(origin));
}

/** Why `owner` may not publish `local` over `origin`: the published run is another run, or another install's. */
function ownershipRefusal(local: RunState, origin: RunSnapshot, owner: HandoffOwner): HandoffError | undefined {
  if (origin.createdAt !== local.createdAt) return mismatch(local.id, local, origin);
  if (origin.owner.id !== owner.id) return notOwner(local.id, origin);
  return undefined;
}

/** `local` with what this machine knows of the snapshot replaced; any earlier pending write is dropped. */
function published(local: RunState, known: { stateRevision: number; pending?: string }): RunState {
  const { pending: _pending, ...kept } = local.publication ?? {};
  return { ...local, publication: { ...kept, ...known } };
}

function header(runId: string, owner: HandoffOwner, ownedAt: string, stateRevision: number, body: SnapshotBody): RunSnapshot {
  return { snapshot: 1, run: runId, owner, ownedAt, stateRevision, write: randomUUID(), ...body };
}

/** Records that origin holds `snapshot`, which this machine wrote, unless the run has since recorded another write. */
async function acknowledge(config: LocalConfig, runId: string, snapshot: RunSnapshot, sessions?: SessionShare): Promise<Result<PublishReceipt>> {
  await updateRun(config, runId, async (local) => {
    if (local === 'missing' || local.publication?.pending !== snapshot.write) return { value: undefined };
    return { value: undefined, write: published(local, { stateRevision: snapshot.stateRevision }) };
  });
  return ok(receipt(runId, 'published', snapshot, sessions));
}

/**
 * Publishes how run `runId` ended when this install published it before, so a member who resumes it gets how it ended,
 * not the state last published. It is a publish, so it runs every check a publish runs, and repeating it after the end
 * reached origin writes nothing. Resolves to why the end was not published, when it was not.
 */
export async function publishRunEnd(config: LocalConfig, runId: string, checkout: string): Promise<HandoffError | undefined> {
  const stored = await readRun(config, runId);
  if (typeof stored !== 'object' || stored.publication === undefined || stored.status === 'running') return undefined;
  const published = await publishRun(config, runId, { checkout });
  if (published.ok) return undefined;
  const { error } = published;
  return error.code === 'not_owner' ? claimedElsewhere(runId, error.owner, error.ownedAt) : error;
}

/** What a claim decided from the snapshot it read; `replaces` is the write a claim lands only over. */
type ClaimVerdict =
  | { kind: 'owned'; snapshot: RunSnapshot }
  | { kind: 'claimed'; snapshot: RunSnapshot; replaces: string; definitions: Definitions; handed: Handover };

interface Definitions {
  definition: WorkflowDefinition;
  workflows: Record<string, WorkflowDefinition>;
}

/**
 * Makes this install the owner of published run `runId` and installs the published state, with every lease another
 * machine held released. A run this install already owns keeps its local progress. `checkout` is the business checkout
 * the run continues in.
 */
export async function claimRun(config: LocalConfig, runId: string, options: { checkout: string }): Promise<Result<ClaimReceipt>> {
  return acquire(config, runId, await publishedRun(config, runId), { transfer: true, checkout: options.checkout });
}

/**
 * Readies run `runId` for `workflow resume`: a run this machine never published continues as it is, with no git, and so
 * does one whose first publish never reached origin. A missing run is claimed. A published one continues only while this
 * install owns it, unless `claim` takes it over. Resolves to null when nothing was checked.
 */
export async function resumeRun(config: LocalConfig, runId: string, options: { claim: boolean; checkout: string }): Promise<Result<ClaimReceipt | null>> {
  const stored = await readRun(config, runId);
  if (stored === 'corrupt') return refused(runUnreadable(runId));
  if (stored === 'missing' || options.claim) return acquire(config, runId, await publishedRun(config, runId), { transfer: true, checkout: options.checkout });
  if (stored.publication === undefined) return ok(null);
  const origin = await publishedRun(config, runId);
  // No other install can have claimed a run origin never showed, and this one never saw it there.
  if (origin.ok && origin.value === 'absent' && stored.publication.stateRevision === 0) return ok(null);
  return acquire(config, runId, origin, { transfer: false, checkout: options.checkout });
}

/** The snapshot of run `runId` origin holds, for a claim or a resume. */
async function publishedRun(config: LocalConfig, runId: string): Promise<OriginSnapshot> {
  if (!isRunId(runId)) return refused(INVALID_RUN);
  if (!usesBranchWorktree(config)) return refused(UNSUPPORTED_REPO);
  return readPublished(config, runId);
}

async function acquire(
  config: LocalConfig,
  runId: string,
  origin: OriginSnapshot,
  { transfer, checkout }: { transfer: boolean; checkout: string },
): Promise<Result<ClaimReceipt>> {
  if (!origin.ok) return origin;
  const owner = await installOwner(config);
  // Decided outside the reports lock: rebuilding definitions and checking the business origin can take a while.
  const decided = await decideClaim(config, runId, origin.value, owner, { transfer, checkout });
  if (!decided.ok) return decided;
  const verdict = decided.value;
  switch (verdict.kind) {
    case 'owned':
      return settleOwned(config, runId, checkout, owner, verdict.snapshot);
    case 'claimed': {
      const landed = await replaceSnapshot(config, runId, verdict.replaces, verdict.snapshot);
      // Origin took no claim this machine can prove, so nothing local changes; claiming again finds out.
      if (!landed.ok) return landed;
      return install(config, runId, checkout, verdict.snapshot, verdict.definitions, verdict.handed);
    }
    default: {
      const unhandled: never = verdict;
      return unhandled;
    }
  }
}

/** The snapshot of run `runId` origin holds, read under the reports lock, which is held for that read only. */
async function readPublished(config: LocalConfig, runId: string): Promise<OriginSnapshot> {
  const result = await updateReports(
    config,
    async (worktree) => ({ value: await readOrigin(worktree, runId), write: null }),
    { pushIfCreated: false },
  );
  return result.value ?? refused(result.status === 'busy' ? REPORTS_BUSY : writeFailed(runId, result));
}

/** Writes `snapshot` to teamai-reports only while origin still holds the write `replaces`. */
async function replaceSnapshot(config: LocalConfig, runId: string, replaces: string, snapshot: RunSnapshot): Promise<Result<void>> {
  const result = await updateReports(config, async (worktree): Promise<ReportsChange<Result<void>>> => {
    const origin = await readOrigin(worktree, runId);
    if (!origin.ok) return { value: origin, write: null };
    if (origin.value === 'absent' || origin.value.write !== replaces) return { value: refused(stateMoved(runId)), write: null };
    return { value: ok(undefined), write: await writeSnapshot(worktree, snapshot, `[teamai] Claim workflow run ${runId}`) };
  });
  if (result.value && !result.value.ok) return result.value;
  if (result.status === 'busy') return refused(REPORTS_BUSY);
  if (result.status !== 'published' && result.status !== 'already-present') return refused(writeFailed(runId, result));
  return ok(undefined);
}

function publishMoved(runId: string): HandoffError {
  return {
    code: 'state_moved',
    message: `Run ${runId} changed while it was being published, so nothing was published. Publish it again: teamai workflow publish ${runId}`,
  };
}

function stateMoved(runId: string): HandoffError {
  return {
    code: 'state_moved',
    message: `Run ${runId} changed on teamai-reports while this machine prepared its claim, so nothing was claimed. Claim it again: teamai workflow resume ${runId} --claim`,
  };
}

async function decideClaim(
  config: LocalConfig,
  runId: string,
  origin: RunSnapshot | 'absent',
  owner: HandoffOwner,
  { transfer, checkout }: { transfer: boolean; checkout: string },
): Promise<Result<ClaimVerdict>> {
  if (origin === 'absent') {
    return refused({
      code: 'run_not_published',
      message: `Run ${runId} is not on teamai-reports. Publish it from the machine that has it: teamai workflow publish ${runId}`,
    });
  }
  const local = await readRun(config, runId);
  if (local === 'corrupt') return refused(runUnreadable(runId));
  if (local !== 'missing' && local.createdAt !== origin.createdAt) return refused(mismatch(runId, local, origin));
  if (origin.owner.id === owner.id) return ok({ kind: 'owned', snapshot: origin });
  if (!transfer) return refused(notOwner(runId, origin));
  const definitions = await definitionsOf(config, origin);
  if (!definitions.ok) return definitions;
  const handed = handedOver(origin, definitions.value);
  // A settled run leases nothing until a retry reopens it, so its branches, which a merge may have deleted, are needed
  // only then: the first drive after the retry fetches and reconciles them.
  if (origin.status === 'running') {
    const onOrigin = await checkOrigin(checkout, { id: runId, base: origin.base, copies: handed.copies }, { side: 'claim', publisher: origin.owner });
    if (!onOrigin.ok) return onOrigin;
  }
  const claimed: RunSnapshot = { ...header(runId, owner, new Date().toISOString(), origin.stateRevision + 1, snapshotBody(origin)), ...handed };
  return ok({ kind: 'claimed', snapshot: claimed, replaces: origin.write, definitions: definitions.value, handed });
}

interface Handover {
  steps: UnleasedStep[];
  copies: SnapshotBody['copies'];
}

/**
 * The published run as this machine continues it: every lease released, and a lease that opened a copy of its own moved
 * to a new pass, its old branch no longer among the run's copies.
 */
function handedOver(snapshot: RunSnapshot, definitions: Definitions): Handover {
  const tree = { ...definitions, steps: snapshot.steps };
  const modes = snapshot.steps.map((step) => stepMode(tree, step.id));
  const moved = snapshot.steps.flatMap((step, index) => (step.status === 'leased' && modes[index] === 'new'
    ? [branchName(snapshot.run, step.id, step.pass ?? 1)]
    : []));
  return {
    steps: snapshot.steps.map((step, index) => takeOver(step, modes[index])),
    copies: Object.fromEntries(Object.entries(snapshot.copies).filter(([branch]) => !moved.includes(branch))),
  };
}

/**
 * The definitions run `snapshot` executes, exactly as the machine that ran it had them: this machine's cache when it holds
 * the same ones, else the team commit the run ran at.
 */
async function definitionsOf(config: LocalConfig, snapshot: RunSnapshot): Promise<Result<Definitions>> {
  const same = (bundle: WorkflowBundle): boolean => bundle.sourceHash === snapshot.sourceHash
    && definitionHash(bundle.definition, bundle.workflows) === snapshot.definitionHash;
  const cached = await loadWorkflowBundle(config, snapshot.name);
  if (!('failed' in cached) && same(cached)) return ok({ definition: cached.definition, workflows: cached.workflows });
  const revision = snapshot.teamRevision;
  if (!revision) {
    return refused({
      code: 'definition_mismatch',
      message: `Run ${snapshot.run} runs workflow "${snapshot.name}" without a team commit that holds its sources, and this machine's copy differs. Once the machine that ran it has pushed its workflows, run teamai pull and try again.`,
    });
  }
  const at = await loadWorkflowBundleAt(config, snapshot.name, revision);
  if ('failed' in at) {
    return refused({
      code: 'definition_mismatch',
      teamRevision: revision,
      message: `Run ${snapshot.run} runs workflow "${snapshot.name}" as of team commit ${revision}, which this machine cannot read: ${at.failed}. Fetch that commit into the team repo, then try again.`,
    });
  }
  if (!same(at)) {
    return refused({
      code: 'definition_mismatch',
      teamRevision: revision,
      message: `Run ${snapshot.run} runs workflow "${snapshot.name}" as of team commit ${revision}, and this teamai reads that commit differently from the one that ran it. Use the same teamai version on both machines, then try again.`,
    });
  }
  return ok({ definition: at.definition, workflows: at.workflows });
}

/**
 * Origin shows this install as the owner. A local run at that state revision, or whose pending write origin shows,
 * keeps its progress; a missing or older one is replaced by the published state.
 */
async function settleOwned(config: LocalConfig, runId: string, checkout: string, owner: HandoffOwner, snapshot: RunSnapshot): Promise<Result<ClaimReceipt>> {
  const kept = await updateRun(config, runId, async (local): Promise<{ value: Result<boolean>; write?: RunState }> => {
    if (local === 'missing') return { value: ok(false) };
    if (local.createdAt !== snapshot.createdAt) return { value: refused(mismatch(runId, local, snapshot)) };
    const seen = acknowledged(local, snapshot);
    if (seen > snapshot.stateRevision) return { value: refused(stateConflict(runId, snapshot.stateRevision, seen)) };
    if (seen < snapshot.stateRevision) return { value: ok(false) };
    if (local.publication?.pending !== snapshot.write) return { value: ok(true) };
    return { value: ok(true), write: published(local, { stateRevision: seen }) };
  });
  if (kept.status === 'busy') return refused(runBusy(runId));
  if (kept.status === 'corrupt') return refused(runUnreadable(runId));
  if (!kept.value.ok) return kept.value;
  if (kept.value.value) return ok({ run: runId, ownership: 'already_owned', owner, stateRevision: snapshot.stateRevision });
  const definitions = await definitionsOf(config, snapshot);
  if (!definitions.ok) return definitions;
  return install(config, runId, checkout, snapshot, definitions.value, handedOver(snapshot, definitions.value));
}

async function install(
  config: LocalConfig,
  runId: string,
  checkout: string,
  snapshot: RunSnapshot,
  definitions: Definitions,
  handed: Handover,
): Promise<Result<ClaimReceipt>> {
  // Every published field comes from the body as it is; only what the snapshot rewrites or leaves out is rebuilt here.
  const { definitionHash: _hash, copies: _copies, steps: _steps, scorers: published, ...body } = snapshotBody(snapshot);
  // A pinned scorer comes back only when this machine caches the same bytes; otherwise its passes are not scored here (D19).
  const cached = await pinScorers(config, Object.keys(published ?? {}));
  const scorers = Object.fromEntries(Object.entries(cached).filter(([name, pin]) => published?.[name]?.sourceHash === pin.sourceHash));
  const run: RunState = {
    ...body,
    id: runId,
    definition: definitions.definition,
    ...(Object.keys(definitions.workflows).length > 0 ? { workflows: definitions.workflows } : {}),
    ...(Object.keys(scorers).length > 0 ? { scorers } : {}),
    steps: handed.steps,
    settledAttempts: [],
    ...(Object.keys(handed.copies).length > 0 ? { copies: handed.copies } : {}),
    checkout,
    publication: {
      stateRevision: snapshot.stateRevision,
      ...(Object.values(handed.copies).some((copy) => copy.commit !== undefined) ? { reconcileCopies: true } : {}),
    },
  };
  const installed = await updateRun(config, runId, async (local) => {
    if (local !== 'missing' && local.createdAt !== snapshot.createdAt) return { value: refused(mismatch(runId, local, snapshot)) };
    return { value: ok(undefined), write: run };
  });
  if (installed.status === 'busy') return refused(runBusy(runId));
  if (installed.status === 'corrupt') return refused(runUnreadable(runId));
  if (!installed.value.ok) return installed.value;
  return ok({ run: runId, ownership: 'claimed', owner: snapshot.owner, stateRevision: snapshot.stateRevision });
}
