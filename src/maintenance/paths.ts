import path from 'node:path';

import type { LocalConfig } from '../types.js';
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
 * Resolve the knowledge and report roots used by recall maintenance commands.
 *
 * Knowledge remains on the default branch (or self-mode `.teamai/` on main).
 * Votes live in the teamai-reports worktree for every non-HTTP repo. HTTP keeps
 * both data sets under localConfig.repo.localPath. Maintenance is a report
 * reader, so a cold start may create its local cache but never publishes a new
 * reports branch as a side effect.
 */
export async function resolveMaintenancePaths(
  localConfig: LocalConfig,
): Promise<MaintenancePaths> {
  if (usesBranchWorktree(localConfig)) {
    const { refreshReportsWorktree } = await import('../utils/reports-branch.js');
    await refreshReportsWorktree(localConfig, { pushIfCreated: false });
    // Maintenance reads and rewrites learnings, so it needs the branch as other
    // members left it. Read-only: it never publishes a branch that is missing.
    const { learningsBranch } = await import('../utils/learnings-branch.js');
    await learningsBranch.refresh(localConfig, { pushIfCreated: false });
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
