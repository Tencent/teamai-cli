import path from 'node:path';

import type { LocalConfig } from '../types.js';
import { getKnowledgeDir, getReportsDir, usesReportsBranch } from '../types.js';

export interface MaintenancePaths {
  repoPath: string;
  votesDir: string;
  learningsDir: string;
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
  if (usesReportsBranch(localConfig)) {
    const { refreshReportsWorktree } = await import('../utils/reports-branch.js');
    await refreshReportsWorktree(localConfig, { pushIfCreated: false });
  }

  const repoPath = getKnowledgeDir(localConfig);
  return {
    repoPath,
    votesDir: path.join(getReportsDir(localConfig), 'votes'),
    learningsDir: path.join(repoPath, 'learnings'),
  };
}
