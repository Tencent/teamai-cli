/**
 * Pull request delivery: what it reads of the business repository and of its host, and nothing it writes to a run. The
 * engine builds a job under the run lock, calls `deliverPr` once it released the lock, and applies the outcome under
 * the lock again, so no network call holds the lock and this module needs nothing of the engine's.
 */
import os from 'node:os';
import { providerForRemote, type OriginProvider } from '../providers/registry.js';
import type { PullRequestRef } from '../providers/types.js';
import { sanitizePrUrl, type PrUrl } from './pr-url.js';
import type { DeliveryFailure } from './step-state.js';
import { fetchMissingCommits, git, protectedPaths } from './worktree.js';

/** Which delivery an outcome belongs to: it applies only while the step still delivers this pass of this commit. */
export interface DeliveryKey {
  step: string;
  pass: number;
  settledAt: number;
  branch: string;
  head: string;
}

/** Everything a delivery needs, read from the run under its lock. */
export interface DeliveryJob {
  key: DeliveryKey;
  runId: string;
  runName: string;
  /** The checkout the run started or was claimed in, which reads the delivered branch. */
  checkout: string;
  /** The run base commit the delivered branch is compared with. */
  base: string;
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
  | { kind: 'no_provider' }
  | { kind: 'lookup_failed'; provider: string }
  | { kind: 'create_failed'; provider: string }
  | { kind: 'unsafe_url'; provider: string }
  | { kind: 'withdrawn' };

export type DeliveryOutcome = { ok: true; pr: PrUrl } | { ok: false; fault: DeliveryFault };

/**
 * Asked under the run lock right before a pull request is opened: true while the step still delivers the job, which it
 * then marks as creating. False opens nothing.
 */
export type CreateGate = () => Promise<boolean>;

/** How long a host may take to answer one lookup or one create. */
export const DELIVERY_TIMEOUT_MS = 30_000;

/** A full object id: the head comes from a driver's report, and anything else could reach git as an option. */
const OBJECT_ID = /^[0-9a-f]{40}([0-9a-f]{24})?$/i;

const failed = (fault: DeliveryFault): DeliveryOutcome => ({ ok: false, fault });

/**
 * Delivers one branch. Its changes against the run base are checked before anything else, a reported URL included,
 * so no pull request goes out, and no step succeeds, with a protected path changed. Then the open request of the branch
 * is looked up, and only when there is none, and `gate` agrees, is one opened; a create that fails is looked up again.
 * Nothing here logs in, prompts or merges, and no text a host answered with is kept, since it may hold a credential.
 */
export async function deliverPr(job: DeliveryJob, gate: CreateGate): Promise<DeliveryOutcome> {
  const changed = await changedFiles(job);
  if ('fault' in changed) return failed(changed.fault);
  const files = protectedPaths(changed.files);
  if (files.length > 0) return failed({ kind: 'protected_path', files });
  if (job.reported) return { ok: true, pr: job.reported };
  const origin = await originOf(job.checkout);
  if (origin.kind === 'transport') return failed({ kind: 'no_provider' });
  const { provider, repo } = origin;
  const ref: PullRequestRef = { repo, source: job.key.branch, target: job.target, timeoutMs: DELIVERY_TIMEOUT_MS };
  const found = await findOpen(origin, ref);
  if (found.kind === 'found') return { ok: true, pr: found.pr };
  if (found.kind === 'failed') return failed({ kind: 'lookup_failed', provider: provider.name });
  if (found.kind === 'unsafe') return failed({ kind: 'unsafe_url', provider: provider.name });
  if (!await gate()) return failed({ kind: 'withdrawn' });
  try {
    const created = sanitizePrUrl(await provider.createPullRequest({
      repo, source: job.key.branch, target: job.target, title: `${job.runName}: ${job.key.step}`,
      description: `Opened by TeamAI for review: workflow ${job.runName}, run ${job.runId}, step ${job.key.step}, pass ${job.key.pass}.\n\nBase commit: ${job.base}\n\nTeamAI never merges this pull request.`,
      // Run outside the member checkout, so the provider's CLI can neither push from it nor read its branch.
      cwd: os.tmpdir(),
      spawnTimeoutMs: DELIVERY_TIMEOUT_MS,
    }));
    return created.url ? { ok: true, pr: created.url } : failed({ kind: 'unsafe_url', provider: provider.name });
  } catch {
    // The host may have opened the request before the create failed or timed out: find it rather than open another.
    const again = await findOpen(origin, ref);
    return again.kind === 'found' ? { ok: true, pr: again.pr } : failed({ kind: 'create_failed', provider: provider.name });
  }
}

/**
 * Why a URL a driver reported for `branch` is not kept: on the origin's host it must be the open request of the branch
 * into `target`, as the provider's lookup answers. A URL on another host, such as a private review service, an origin
 * only git reaches, or a lookup that cannot answer keeps it, and delivery accepts it as it is.
 */
export async function reportedPrMismatch(
  { checkout, url, branch, target }: { checkout: string; url: PrUrl; branch: string; target: string },
): Promise<string | undefined> {
  const origin = await originOf(checkout);
  if (origin.kind === 'transport' || new URL(url).hostname !== origin.hostname) return undefined;
  const found = await findOpen(origin, { repo: origin.repo, source: branch, target, timeoutMs: DELIVERY_TIMEOUT_MS });
  if (found.kind === 'none') return `branch ${branch} has no open pull request into ${target}`;
  if (found.kind === 'found' && found.pr !== url) return `is not the open pull request of branch ${branch} into ${target}`;
  return undefined;
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

/** The files the delivered head changes against the run base, read in the run's checkout once it fetched what it lacks. */
async function changedFiles({ key, runId, checkout, base }: DeliveryJob): Promise<{ files: string[] } | { fault: DeliveryFault }> {
  if (!OBJECT_ID.test(key.head) || !OBJECT_ID.test(base)) return { fault: { kind: 'unreadable' } };
  const fetched = await fetchMissingCommits(checkout, { run: runId, commits: [base, key.head] });
  if (fetched.missing.length > 0) return { fault: { kind: 'unreadable' } };
  const diff = await git(checkout, ['diff', '--no-renames', '--name-only', '-z', base, key.head, '--']);
  if (diff.code !== 0) return { fault: { kind: 'unreadable' } };
  return { files: diff.stdout.split('\0').filter(Boolean) };
}

const LISTED_FILES = 20;

/** The failure a step keeps for `fault`: what happened, where the work is, and what to do next. */
export function deliveryFailure({ runId, key }: Pick<DeliveryJob, 'runId' | 'key'>, fault: DeliveryFault): DeliveryFailure {
  const { step, branch } = key;
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
    case 'protected_path': {
      const listed = fault.files.slice(0, LISTED_FILES).join(', ');
      const more = fault.files.length > LISTED_FILES ? `, and ${fault.files.length - LISTED_FILES} more` : '';
      return {
        code: 'protected_path',
        message: `Step "${step}" changed protected paths against the run base: ${listed}${more}. TeamAI delivers no pull request that changes CI, hooks or agent configuration. The work is kept on origin in branch ${branch}. Have the step leave those paths alone, then run: ${retry}`,
      };
    }
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
