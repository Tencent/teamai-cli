/**
 * Pull request delivery: what it reads of the business repository and of its host, and nothing it writes to a run. The
 * engine builds a job under the run lock, calls `deliverPr` once it released the lock, and applies the outcome under
 * the lock again, so no network call holds the lock and this module needs nothing of the engine's.
 */
import type { PrUrl } from './pr-url.js';
import type { WorkflowFailure } from './types.js';
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
  | { kind: 'no_provider' };

export type DeliveryOutcome = { ok: true; pr: PrUrl } | { ok: false; fault: DeliveryFault };

/** A full object id: the head comes from a driver's report, and anything else could reach git as an option. */
const OBJECT_ID = /^[0-9a-f]{40}([0-9a-f]{24})?$/i;

/**
 * Delivers one branch. Its changes against the run base are checked before anything else, a reported URL included,
 * so no pull request goes out, and no step succeeds, with a protected path changed.
 */
export async function deliverPr(job: DeliveryJob): Promise<DeliveryOutcome> {
  const changed = await changedFiles(job);
  if ('fault' in changed) return { ok: false, fault: changed.fault };
  const files = protectedPaths(changed.files);
  if (files.length > 0) return { ok: false, fault: { kind: 'protected_path', files } };
  if (job.reported) return { ok: true, pr: job.reported };
  return { ok: false, fault: { kind: 'no_provider' } };
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
export function deliveryFailure({ runId, key }: Pick<DeliveryJob, 'runId' | 'key'>, fault: DeliveryFault): WorkflowFailure {
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
    default: {
      const unknown: never = fault;
      return unknown;
    }
  }
}
