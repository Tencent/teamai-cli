/**
 * Pull request delivery: what it reads of the business repository and of its host, and nothing it writes to a run. The
 * engine builds a job under the run lock, calls `deliverPr` once it released the lock, and applies the outcome under
 * the lock again, so no network call holds the lock and this module needs nothing of the engine's.
 */
import type { PrUrl } from './pr-url.js';
import type { WorkflowFailure } from './types.js';

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
  /** A URL the step's driver reported and the engine kept: nothing is opened for it. */
  reported?: PrUrl;
}

/** Why a delivery opened no pull request. Each one is told with the branch that keeps the work. */
export type DeliveryFault = { kind: 'no_provider'; branch: string };

export type DeliveryOutcome = { ok: true; pr: PrUrl } | { ok: false; fault: DeliveryFault };

/** Delivers one branch. */
export async function deliverPr(job: DeliveryJob): Promise<DeliveryOutcome> {
  if (job.reported) return { ok: true, pr: job.reported };
  return { ok: false, fault: { kind: 'no_provider', branch: job.key.branch } };
}

/** The failure a step keeps for `fault`: what happened, where the work is, and the command that tries again. */
export function deliveryFailure(job: DeliveryJob, fault: DeliveryFault): WorkflowFailure {
  const retry = `teamai workflow retry ${job.runId} ${job.key.step}`;
  switch (fault.kind) {
    case 'no_provider':
      return {
        code: 'delivery_failed',
        message: `PR delivery for step "${job.key.step}" failed: TeamAI cannot open a pull request on this repository's origin. The work is kept on origin in branch ${fault.branch}. Open a pull request from it, or have the driver report changes.pr_url, then run: ${retry}`,
      };
    default: {
      const unknown: never = fault.kind;
      return unknown;
    }
  }
}
