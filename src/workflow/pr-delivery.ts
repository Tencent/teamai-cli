/**
 * Pull request delivery: what it reads of the business repository and of its host, and nothing it writes to a run. The
 * engine builds a job under the run lock, calls `deliverPr` once it released the lock, and applies the outcome under
 * the lock again, so no network call holds the lock and this module needs nothing of the engine's.
 */
import os from 'node:os';
import { providerForRemote, type OriginProvider } from '../providers/registry.js';
import { NON_INTERACTIVE_GIT_ENV } from '../utils/git-env.js';
import type { PullRequestRef } from '../providers/types.js';
import { sanitizePrUrl, type PrUrl } from './pr-url.js';
import type { DeliveryKey, UnresolvedCreate } from './delivery-schema.js';
import type { DeliveryFailure } from './step-state.js';
import { fetchMissingCommits, git, protectedPaths } from './worktree.js';

/** Everything a delivery needs, read from the run under its lock. */
export interface DeliveryJob {
  key: DeliveryKey;
  runId: string;
  runName: string;
  /** The checkout the run started or was claimed in, which reads the delivered branch. */
  checkout: string;
  /** The run base commit the delivered branch is compared with. */
  base: string;
  /** The latest commit a report recorded on this branch, read under the run lock. */
  recordedHead?: string;
  /** Work steps inside the delivering one left on branches no step delivers, which the delivered branch must hold. */
  childWork: Array<{ step: string; branch: string; commit: string }>;
  /** The workflow step whose copy the branch is, when another step's: retrying it runs its steps again in a new branch. */
  openedBy?: string;
  /** The branch the pull request goes into. */
  target: string;
  /** A URL the step's driver reported and the engine kept: nothing is opened for it. */
  reported?: PrUrl;
}

/** Why a delivery opened no pull request. `no_checkout` is found under the run lock, before there is a job. */
export type DeliveryFault =
  | { kind: 'no_checkout' }
  | { kind: 'unreadable' }
  | { kind: 'protected_path'; files: string[] }
  /** Only the commits a later report recorded after the step's own head change `files`. */
  | { kind: 'later_protected_path'; files: string[] }
  | { kind: 'branch_moved' }
  /** Origin's branch holds the recorded commit and more, at `tip`: a report of `tip` may still be on its way. */
  | { kind: 'branch_ahead'; tip: string }
  /** The recorded commit origin's branch is at lacks the step's head: a later step rewrote the branch's history. */
  | { kind: 'branch_rewritten' }
  /** Origin's branch lacks the work step `step` inside the delivering one left on `branch`. */
  | { kind: 'child_work_left_out'; step: string; branch: string }
  | { kind: 'branch_missing' }
  | { kind: 'branch_unreadable' }
  | { kind: 'no_provider' }
  | { kind: 'lookup_failed'; provider: string }
  | { kind: 'create_failed'; provider: string }
  | { kind: 'create_unconfirmed'; provider: string }
  | { kind: 'unsafe_url'; provider: string }
  | { kind: 'withdrawn' };

export type DeliveryOutcome = { ok: true; pr: PrUrl } | { ok: false; fault: DeliveryFault };

/**
 * Asked under the run lock right before a pull request is opened: `open` while the step still delivers the job, whose
 * request the run then lists as unresolved; `refused` when it no longer does; `busy` when nobody knows yet, because the
 * run lock could not be taken, a report recorded another commit on the branch since the job was picked, or a step that
 * writes the branch is leased. Only `open` opens anything.
 */
export type CreateGate = () => Promise<'open' | 'refused' | 'busy'>;

/** How long a host may take to answer one lookup or one create. */
export const DELIVERY_TIMEOUT_MS = 30_000;

/** How delivery runs git that reaches origin: bounded, and never waiting on a prompt. */
const ORIGIN_GIT = { timeoutMs: DELIVERY_TIMEOUT_MS, env: NON_INTERACTIVE_GIT_ENV };

/** A full object id: the head comes from a driver's report, and anything else could reach git as an option. */
const OBJECT_ID = /^[0-9a-f]{40}([0-9a-f]{24})?$/i;

const failed = (fault: DeliveryFault): DeliveryOutcome => ({ ok: false, fault });

/**
 * Delivers one branch. Its changes against the run base are checked before anything else, a reported URL included,
 * so no pull request goes out, and no step succeeds, with a protected path changed. Then the open request of the branch
 * is looked up, and only when there is none, origin's branch is still at the checked commit, and `gate` opens, is one
 * opened; then it is looked up again. `busy` is nothing opened and no outcome: the branch moved while the lookup ran, or
 * the gate could not answer, and the job is for a later call, which checks it again.
 * Nothing here logs in, prompts or merges, and no text a host answered with is kept, since it may hold a credential.
 */
export async function deliverPr(job: DeliveryJob, gate: CreateGate): Promise<DeliveryOutcome | 'busy'> {
  if (!OBJECT_ID.test(job.key.head) || !OBJECT_ID.test(job.base)) return failed({ kind: 'unreadable' });
  const tip = await originTip(job.checkout, job.key.branch);
  if (tip.kind === 'unreadable') return failed({ kind: 'branch_unreadable' });
  if (tip.commit === undefined) return failed({ kind: 'branch_missing' });
  if (tip.commit !== job.key.head && tip.commit !== job.recordedHead) {
    const ahead = await contains(job, { commit: tip.commit, ancestor: job.recordedHead ?? job.key.head });
    if ('fault' in ahead) return failed(ahead.fault);
    return failed(ahead.contains ? { kind: 'branch_ahead', tip: tip.commit } : { kind: 'branch_moved' });
  }
  if (tip.commit !== job.key.head) {
    const holds = await contains(job, { commit: tip.commit, ancestor: job.key.head });
    if ('fault' in holds) return failed(holds.fault);
    if (!holds.contains) return failed({ kind: 'branch_rewritten' });
  }
  const changed = await changedFiles({ ...job, key: { ...job.key, head: tip.commit } });
  if ('fault' in changed) return failed(changed.fault);
  const files = protectedPaths(changed.files);
  if (files.length > 0 && tip.commit !== job.key.head) {
    const own = await changedFiles(job);
    if ('fault' in own) return failed(own.fault);
    const owned = protectedPaths(own.files);
    return failed(owned.length > 0 ? { kind: 'protected_path', files: owned } : { kind: 'later_protected_path', files });
  }
  if (files.length > 0) return failed({ kind: 'protected_path', files });
  for (const child of job.childWork) {
    const held = await contains(job, { commit: tip.commit, ancestor: child.commit });
    if ('fault' in held) return failed(held.fault);
    if (!held.contains) return failed({ kind: 'child_work_left_out', step: child.step, branch: child.branch });
  }
  if (job.reported) return { ok: true, pr: job.reported };
  const origin = await originOf(job.checkout);
  if (origin.kind === 'transport') return failed({ kind: 'no_provider' });
  const { provider, repo } = origin;
  const ref: PullRequestRef = { repo, source: job.key.branch, target: job.target, timeoutMs: DELIVERY_TIMEOUT_MS };
  const found = await findOpen(origin, ref);
  if (found.kind === 'failed') return failed({ kind: 'lookup_failed', provider: provider.name });
  if (found.kind === 'unsafe') return failed({ kind: 'unsafe_url', provider: provider.name });
  // A step of the branch may have pushed while the lookup ran, so neither a found request nor a new one is taken on the
  // commit checked before it. A push after this read shows in the pull request itself, and nothing here closes that window.
  const checked = await originTip(job.checkout, job.key.branch);
  if (checked.kind === 'unreadable') return failed({ kind: 'branch_unreadable' });
  if (checked.commit !== tip.commit) return 'busy';
  if (found.kind === 'found') return { ok: true, pr: found.pr };
  const gated = await gate();
  if (gated === 'busy') return 'busy';
  if (gated === 'refused') return failed({ kind: 'withdrawn' });
  let answered = false;
  try {
    await provider.createPullRequest({
      repo, source: job.key.branch, target: job.target, title: `${job.runName}: ${job.key.step}`,
      description: `Opened by TeamAI for review: workflow ${job.runName}, run ${job.runId}, step ${job.key.step}, pass ${job.key.pass}.\n\nBase commit: ${job.base}\n\nTeamAI never merges this pull request.`,
      // Run outside the member checkout, so the provider's CLI can neither push from it nor read its branch.
      cwd: os.tmpdir(),
      spawnTimeoutMs: DELIVERY_TIMEOUT_MS,
    });
    answered = true;
  } catch {
    // A create that failed or timed out may still have opened the request, so the lookup below decides.
  }
  // One that answered may name the request by another URL than the lookup a later delivery of the branch finds it by,
  // or before the host lists it, so only the lookup's URL is kept: one request, one receipt.
  const opened = await findOpen(origin, ref);
  if (opened.kind === 'found') return { ok: true, pr: opened.pr };
  if (opened.kind === 'unsafe') return failed({ kind: 'unsafe_url', provider: provider.name });
  return failed({ kind: answered || opened.kind === 'failed' ? 'create_unconfirmed' : 'create_failed', provider: provider.name });
}

/**
 * Why a URL a driver reported for `branch` is not kept: on the origin's host it must be the open request of the branch
 * into `target`, as the provider's lookup answers, so one the lookup cannot confirm is not kept either; delivery's own
 * lookup still finds the open request. A URL on another host, such as a private review service, or an origin only git
 * reaches, keeps it, and delivery accepts it as it is.
 */
export async function reportedPrMismatch(
  { checkout, url, branch, target }: { checkout: string; url: PrUrl; branch: string; target: string },
): Promise<string | undefined> {
  const origin = await originOf(checkout);
  if (origin.kind === 'transport' || new URL(url).hostname !== origin.hostname) return undefined;
  const found = await findOpen(origin, { repo: origin.repo, source: branch, target, timeoutMs: DELIVERY_TIMEOUT_MS });
  if (found.kind === 'none') return `branch ${branch} has no open pull request into ${target}`;
  if (found.kind !== 'found') return `could not be checked against the open pull requests of branch ${branch} into ${target}`;
  return found.pr === url ? undefined : `is not the open pull request of branch ${branch} into ${target}`;
}

/**
 * Whether the host holds the open request `create` asked for, by lookup alone: nothing of the branch is read, and
 * nothing is opened. `failed` is a host that cannot answer or an origin no provider reads. `unsafe` is a URL that cannot be kept.
 */
export async function findDelivered(
  checkout: string, { branch, target }: Pick<UnresolvedCreate, 'branch' | 'target'>,
): Promise<{ kind: 'found'; pr: PrUrl } | { kind: 'none' } | { kind: 'failed' } | { kind: 'unsafe' }> {
  const origin = await originOf(checkout);
  if (origin.kind === 'transport') return { kind: 'failed' };
  return findOpen(origin, { repo: origin.repo, source: branch, target, timeoutMs: DELIVERY_TIMEOUT_MS });
}

/** The provider of the checkout's configured origin; git alone when the checkout has none. */
async function originOf(checkout: string): Promise<OriginProvider> {
  const remote = await git(checkout, ['config', '--get', 'remote.origin.url']);
  return remote.code === 0 ? providerForRemote(remote.stdout) : { kind: 'transport' };
}

/**
 * What a lookup said: the open request, sanitized; none; no answer; or a URL that cannot be kept, which a URL on another
 * host than the origin's pull requests is, whichever provider answered.
 */
async function findOpen(
  { pullRequests, hostname }: Extract<OriginProvider, { kind: 'provider' }>, ref: PullRequestRef,
): Promise<{ kind: 'found'; pr: PrUrl } | { kind: 'none' } | { kind: 'failed' } | { kind: 'unsafe' }> {
  let url: string | undefined;
  try {
    url = await pullRequests.findOpen(ref);
  } catch {
    return { kind: 'failed' };
  }
  if (url === undefined) return { kind: 'none' };
  const clean = sanitizePrUrl(url);
  return clean.url && new URL(clean.url).hostname === hostname ? { kind: 'found', pr: clean.url } : { kind: 'unsafe' };
}

/** The commit origin's `branch` is at, read by the checkout; none when origin has no such branch. */
async function originTip(checkout: string, branch: string): Promise<{ kind: 'read'; commit?: string } | { kind: 'unreadable' }> {
  const ref = `refs/heads/${branch}`;
  const listed = await git(checkout, ['-c', 'credential.interactive=false', 'ls-remote', 'origin', ref], ORIGIN_GIT);
  if (listed.code !== 0) return { kind: 'unreadable' };
  const commit = listed.stdout.split('\n').map((line) => line.split('\t')).find(([, name]) => name?.trim() === ref)?.[0];
  return commit ? { kind: 'read', commit } : { kind: 'read' };
}

/** The files the delivered head changes against the run base, read in the run's checkout once it fetched what it lacks. */
async function changedFiles({ key, runId, checkout, base }: DeliveryJob): Promise<{ files: string[] } | { fault: DeliveryFault }> {
  if (!OBJECT_ID.test(key.head) || !OBJECT_ID.test(base)) return { fault: { kind: 'unreadable' } };
  const fetched = await fetchMissingCommits(checkout, { run: runId, commits: [base, key.head] }, ORIGIN_GIT);
  if (fetched.missing.length > 0) return { fault: { kind: 'unreadable' } };
  const diff = await git(checkout, ['diff', '--no-renames', '--name-only', '-z', base, key.head, '--']);
  if (diff.code !== 0) return { fault: { kind: 'unreadable' } };
  return { files: diff.stdout.split('\0').filter(Boolean) };
}

/** Whether `commit` holds `ancestor`, read in the run's checkout once it fetched what it lacks. */
async function contains({ runId, checkout }: DeliveryJob, { commit, ancestor }: { commit: string; ancestor: string }): Promise<{ contains: boolean } | { fault: DeliveryFault }> {
  if (!OBJECT_ID.test(commit) || !OBJECT_ID.test(ancestor)) return { contains: false };
  const fetched = await fetchMissingCommits(checkout, { run: runId, commits: [ancestor, commit] }, ORIGIN_GIT);
  if (fetched.missing.includes(commit)) return { fault: { kind: 'unreadable' } };
  // A commit the checkout holds brings its history, so an ancestor still missing is not in it.
  if (fetched.missing.length > 0) return { contains: false };
  const { code } = await git(checkout, ['merge-base', '--is-ancestor', ancestor, commit]);
  return code === 0 || code === 1 ? { contains: code === 0 } : { fault: { kind: 'unreadable' } };
}

const LISTED_FILES = 20;

function listedFiles(files: string[]): string {
  const more = files.length > LISTED_FILES ? `, and ${files.length - LISTED_FILES} more` : '';
  return `${files.slice(0, LISTED_FILES).join(', ')}${more}`;
}

/** The failure a step keeps for `fault`: what happened, where the work is, and what to do next. */
export function deliveryFailure({ runId, key, recordedHead, openedBy }: Pick<DeliveryJob, 'runId' | 'key' | 'recordedHead' | 'openedBy'>, fault: DeliveryFault): DeliveryFailure {
  const { step, branch } = key;
  const head = recordedHead ?? key.head;
  const retry = `teamai workflow retry ${runId} ${step}`;
  switch (fault.kind) {
    case 'no_checkout':
      return {
        code: 'delivery_failed',
        message: `PR delivery for step "${step}" failed: the run records no checkout, or no base branch, to deliver branch ${branch} from and into. The work is kept in branch ${branch}. Open a pull request from it yourself, or start the run again from a checkout of its repository.`,
      };
    case 'unreadable':
      return {
        code: 'delivery_failed',
        message: `PR delivery for step "${step}" failed: the run's checkout cannot read the commit branch ${branch} reported, or the run base, even after fetching the run's branches from origin, so its changes cannot be checked. Push branch ${branch} to origin, then run: ${retry}`,
      };
    case 'protected_path':
      return {
        code: 'protected_path',
        message: `Step "${step}" changed protected paths against the run base: ${listedFiles(fault.files)}. TeamAI delivers no pull request that changes CI, hooks or agent configuration. The work is kept on origin in branch ${branch}. Have the step leave those paths alone, then run: ${retry}`,
      };
    case 'later_protected_path': {
      const rerun = openedBy ? `. Or, once workflow step "${openedBy}" has stopped, run its steps again in a new branch: teamai workflow retry ${runId} ${openedBy}` : '';
      return {
        code: 'delivery_failed',
        message: `PR delivery for step "${step}" failed: commit ${head}, which a later report recorded on the shared branch ${branch}, changed protected paths against the run base: ${listedFiles(fault.files)}. Step "${step}" itself left them alone, so a retry does not run it again. TeamAI delivers no pull request that changes CI, hooks or agent configuration. The work is kept on origin in branch ${branch}. To deliver the step's own work without the later commits, put branch ${branch} on origin back at ${key.head}, the commit the step reported, then run: ${retry}${rerun}`,
      };
    }
    case 'branch_missing':
      return {
        code: 'delivery_failed',
        message: `PR delivery for step "${step}" failed: origin has no branch ${branch}; push ${head} to it, then run: ${retry}`,
      };
    case 'branch_ahead':
      return {
        code: 'delivery_failed',
        message: `PR delivery for step "${step}" failed: branch ${branch} on origin is at commit ${fault.tip}, which holds commit ${head}, the last one a report recorded on it, and later commits no report recorded, so TeamAI has not checked them, and no pull request was opened or accepted. Put branch ${branch} on origin back at ${head}, then run: ${retry}`,
      };
    case 'branch_moved':
      return {
        code: 'delivery_failed',
        message: `PR delivery for step "${step}" failed: branch ${branch} on origin moved away from commit ${head}, the last one a report recorded on it, so it no longer holds the changes TeamAI checked, and no pull request was opened or accepted. Put branch ${branch} on origin back at ${head}, then run: ${retry}`,
      };
    case 'branch_rewritten':
      return {
        code: 'delivery_failed',
        message: `PR delivery for step "${step}" failed: commit ${head}, the last one a report recorded on branch ${branch}, does not contain commit ${key.head} the step reported, so a pull request from it would not hold the step's work, and none was opened or accepted. Have a step on that branch record a commit that contains both, or put branch ${branch} on origin back at ${key.head}, then run: ${retry}`,
      };
    case 'child_work_left_out':
      return {
        code: 'delivery_failed',
        message: `PR delivery for step "${step}" failed: step "${fault.step}" wrote branch ${fault.branch}, which branch ${branch} does not hold, so a pull request from it would leave that work out, and none was opened or accepted. The work is kept in branches ${branch} and ${fault.branch}. Have a later step in the workflow need step "${fault.step}", so it merges branch ${fault.branch}, or give step "${fault.step}" its own deliver: pr. A run keeps the workflow it started with, so start the run again after you change the workflow.`,
      };
    case 'branch_unreadable':
      return {
        code: 'delivery_failed',
        message: `PR delivery for step "${step}" failed: TeamAI could not read branch ${branch} on origin to check that it still holds commit ${key.head} the step reported, so no pull request was opened or accepted. Check the checkout's access to origin, then run: ${retry}`,
      };
    case 'no_provider':
      return {
        code: 'delivery_failed',
        message: `PR delivery for step "${step}" failed: TeamAI cannot open a pull request on this repository's origin. The work is kept on origin in branch ${branch}. Open a pull request from it, or have the driver report changes.pr_url, then run: ${retry}`,
      };
    case 'lookup_failed':
      return {
        code: 'delivery_failed',
        message: `PR delivery for step "${step}" failed: the ${fault.provider} provider could not say whether branch ${branch} already has an open pull request, so TeamAI opened none. Check its credentials and its access to the repository. The work is kept on origin in branch ${branch}. Then run: ${retry}`,
      };
    case 'create_failed':
      return {
        code: 'delivery_failed',
        message: `PR delivery for step "${step}" failed: the ${fault.provider} provider did not open a pull request from branch ${branch}. Check its credentials, its access to the repository, and that the branch is on origin. The work is kept in branch ${branch}. Then run: ${retry}`,
      };
    case 'create_unconfirmed':
      return {
        code: 'delivery_failed',
        message: `PR delivery for step "${step}" failed: the ${fault.provider} host may have opened a pull request from branch ${branch}, but TeamAI could not confirm it. No receipt was recorded. Check its credentials and its access to the repository, then run: ${retry}`,
      };
    case 'unsafe_url':
      return {
        code: 'delivery_failed',
        message: `PR delivery for step "${step}" failed: the ${fault.provider} provider answered with a pull request URL TeamAI cannot keep. The work is kept on origin in branch ${branch}. Check the open pull requests of that branch, then run: ${retry}`,
      };
    case 'withdrawn':
      return {
        code: 'delivery_failed',
        message: `PR delivery for step "${step}" stopped: the step no longer delivered when its pull request was about to be opened, so none was. The work is kept in branch ${branch}.`,
      };
    default: {
      const unknown: never = fault;
      return unknown;
    }
  }
}
