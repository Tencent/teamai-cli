import path from 'node:path';

import type { LocalConfig } from '../types.js';
import type { RefreshResult } from '../utils/branch-worktree.js';
import { getKnowledgeDir, getReportsDir, usesBranchWorktree } from '../types.js';
import { learningsRoots } from '../utils/learnings-roots.js';

export interface MaintenancePaths {
  repoPath: string;
  votesDir: string;
  /**
   * Where maintenance writes: archives, promotions and confidence updates land
   * in a root that can actually be published.
   */
  learningsWriteDir: string;
  /** Every learnings root to read, highest precedence first. */
  learningsReadDirs: readonly string[];
}

/**
 * A side-branch lock could not be taken (#808): another command holds it, or
 * it cannot be created. The checkout there is unchecked: it may be another
 * repository's, or still being created, so maintenance must not read votes
 * from it or write learnings under it.
 */
export class CheckoutLockedError extends Error {
  override name = 'CheckoutLockedError';
  constructor(checkout: 'learnings' | 'reports', lockPath: string) {
    super(
      `The ${checkout} checkout is locked: another teamai command may be updating it, or its lock at ${lockPath} could not be created. ` +
        'Nothing was changed. Run this again when the other command finishes; ' +
        `if this keeps happening, check that ${path.dirname(lockPath)} is writable.`,
    );
  }
}

/**
 * A side-branch checkout could not be created or synced, for a reason other
 * than a refusal (#808): maintenance would write into a directory that is no
 * checkout, and the next publish would delete it.
 */
export class CheckoutUnavailableError extends Error {
  override name = 'CheckoutUnavailableError';
  constructor(checkout: 'learnings' | 'reports', reason: string) {
    super(`The ${checkout} checkout could not be set up: ${reason}. Nothing was changed. Fix that, then run this again.`);
  }
}

/** Throw unless the refresh left a checkout maintenance can read and write. */
function assertCheckoutReady(checkout: 'learnings' | 'reports', refreshed: RefreshResult): void {
  switch (refreshed.status) {
    case 'done':
      return;
    case 'busy':
      throw new CheckoutLockedError(checkout, refreshed.lockPath);
    case 'failed':
      throw new CheckoutUnavailableError(checkout, refreshed.reason);
    default: {
      const unhandled: never = refreshed;
      throw new Error(`Unhandled refresh result: ${JSON.stringify(unhandled)}`);
    }
  }
}

/**
 * Resolve the knowledge and report roots used by recall maintenance commands.
 *
 * Knowledge remains on the default branch (or self-mode `.teamai/` on main).
 * Votes live in the teamai-reports worktree for every non-HTTP repo. HTTP keeps
 * both data sets under localConfig.repo.localPath. Maintenance is a report
 * reader, so a cold start may create its local cache but never publishes a new
 * reports branch as a side effect. A dry run creates and refreshes nothing.
 * Throws CheckoutLockedError when the reports or learnings lock cannot be
 * taken, and CheckoutUnavailableError when either checkout could not be set up.
 */
export async function resolveMaintenancePaths(
  localConfig: LocalConfig,
  options: { dryRun?: boolean } = {},
): Promise<MaintenancePaths> {
  if (usesBranchWorktree(localConfig) && options.dryRun) {
    // A dry run reads both checkouts as they are: neither refreshed nor created.
    const { readableReportsWorktree } = await import('../utils/reports-branch.js');
    await readableReportsWorktree(localConfig, { dryRun: true });
    const { learningsBranch } = await import('../utils/learnings-branch.js');
    await learningsBranch.checkOwner(localConfig);
  } else if (usesBranchWorktree(localConfig)) {
    const { refreshReportsWorktree } = await import('../utils/reports-branch.js');
    assertCheckoutReady('reports', await refreshReportsWorktree(localConfig, { pushIfCreated: false }));
    // Maintenance reads and rewrites learnings, so it needs the branch as other
    // members left it. Read-only: it never publishes a branch that is missing.
    const { learningsBranch } = await import('../utils/learnings-branch.js');
    assertCheckoutReady('learnings', await learningsBranch.refresh(localConfig, { pushIfCreated: false }));
  }

  const repoPath = getKnowledgeDir(localConfig);
  const roots = learningsRoots(localConfig);
  return {
    repoPath,
    votesDir: path.join(getReportsDir(localConfig), 'votes'),
    learningsWriteDir: roots.write,
    learningsReadDirs: roots.read,
  };
}
