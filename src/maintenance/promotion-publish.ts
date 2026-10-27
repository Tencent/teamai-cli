import path from 'node:path';

import type { LocalConfig, TeamaiConfig } from '../types.js';
import { getDataHome, SYNC_LOCK_FILENAME } from '../types.js';
import { assertNotReadOnly } from '../read-only.js';
import { acquireLock, releaseLock } from '../update.js';
import { commitSkippingHooks, createGit, unusedBranchName } from '../utils/git.js';
import { withKnowledgeWorktree } from '../utils/reports-branch.js';
import { publishLearningsMaintenance } from '../utils/learnings-publish.js';
import { createPrWithFallback } from '../push.js';
import { getProvider } from '../providers/index.js';
import { log } from '../utils/logger.js';
import { resolveMaintenancePaths } from './paths.js';
import { executePromotion, fetchPromotionRefs, findPromotionCandidates, type PromoteOptions } from './promote.js';

/** Publish one new knowledge artifact, then its learning marker, without changing the active checkout. */
export async function promoteAndPublish(
  learningId: string,
  localConfig: LocalConfig,
  teamConfig: TeamaiConfig,
  options: Pick<PromoteOptions, 'category'> & { namespaces?: readonly string[] },
): Promise<void> {
  assertNotReadOnly(localConfig, 'teamai recall promote');
  if (localConfig.repo.ref !== undefined) {
    throw new Error('This workspace follows a pinned team ref. Follow the default branch before promoting a learning.');
  }
  const lock = path.join(getDataHome(localConfig), SYNC_LOCK_FILENAME);
  if (!await acquireLock(lock)) {
    throw new Error('Another teamai pull/push/migration is in progress. Retry promotion once it finishes.');
  }
  try {
    const { repoPath: knowledgeCheckout, votesDir, learningsReadDirs, learningsWriteDir } = await resolveMaintenancePaths(localConfig, { holdsSyncLock: true });
    await fetchPromotionRefs(knowledgeCheckout);
    const candidates = await findPromotionCandidates(learningsReadDirs, votesDir, knowledgeCheckout, {
      namespaces: options.namespaces,
    });
    const candidate = candidates.find((entry) => entry.docId === learningId);
    if (!candidate) throw new Error(`Learning "${learningId}" not found or not eligible for promotion.`);

    const message = `[teamai] Promote ${candidate.docId} to ${options.category ?? candidate.suggestedCategory}`;
    const { marked } = await withKnowledgeWorktree(localConfig, async (checkoutConfig) => {
      const repoPath = checkoutConfig.repo.localPath;
      return executePromotion(candidate, repoPath, {
        ...options,
        learningsWriteDir,
        async publish(targetPath) {
          const relativePath = path.relative(repoPath, targetPath).split(path.sep).join('/');
          const branch = await unusedBranchName(repoPath, localConfig.username);
          const git = createGit(repoPath);
          await git.raw(['--literal-pathspecs', 'add', '--', relativePath]);
          await commitSkippingHooks(git, message);
          // Push from the detached worktree: a local branch would outlive it in the member's checkout.
          await git.push(['origin', `HEAD:refs/heads/${branch}`]);
          log.success(`Promotion artifact pushed to branch ${branch}`);
          if (getProvider(localConfig.provider ?? teamConfig.provider).name === 'git') {
            log.info(`Create a pull/merge request for ${branch} to review the promoted knowledge.`);
          } else if (!await createPrWithFallback(teamConfig, checkoutConfig, branch, message, message)) {
            // The artifact is already durable on origin. Keep the marker, and
            // use the existing manual-PR recovery instead of generating it again.
            process.exitCode = 1;
          }
        },
      });
    }, { requireFreshBase: true });

    if (marked) {
      const result = await publishLearningsMaintenance(localConfig, `[teamai] Mark ${candidate.docId} as promoted`, [marked]);
      if (result.status === 'published' || result.status === 'already-present') {
        log.success('Published promotion marker to the learnings branch');
      } else {
        log.warn(`The promotion artifact is published; its marker will be retried on the next pull: ${result.status === 'failed' ? result.reason : result.status}`);
        process.exitCode = 1;
      }
    }
  } finally {
    await releaseLock(lock);
  }
}
