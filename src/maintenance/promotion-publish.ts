import path from 'node:path';

import { z } from 'zod';
import type { LocalConfig, TeamaiConfig } from '../types.js';
import { getDataHome, SYNC_LOCK_FILENAME } from '../types.js';
import { assertNotReadOnly } from '../read-only.js';
import { acquireLock, releaseLock } from '../update.js';
import { commitSkippingHooks, createGit, unusedBranchName } from '../utils/git.js';
import { withKnowledgeWorktree } from '../utils/reports-branch.js';
import { publishLearningsMaintenance } from '../utils/learnings-publish.js';
import { listLearningFiles } from '../utils/learnings-roots.js';
import { parseJson } from '../utils/json.js';
import { createPrWithFallback } from '../push.js';
import { getProvider } from '../providers/index.js';
import { log } from '../utils/logger.js';
import { resolveMaintenancePaths } from './paths.js';
import { fetchPromotionRefs, findPromotionCandidates, markPromoted, writePromotion, type PromotionCandidate, type PromotionCategory } from './promote.js';

/** What `publish` writes: the learning rewritten for its category, or the learning as written when the AI could not rewrite it. */
export type PromotedContent = { kind: 'rewritten'; text: string } | { kind: 'as-written'; why: string };

/** Refuses a promotion where nothing it publishes could be kept. */
export function assertCanPromote(localConfig: LocalConfig): void {
  assertNotReadOnly(localConfig, 'teamai recall promote');

  if (localConfig.repo.ref !== undefined) {
    throw new Error('This workspace follows a pinned team ref. Follow the default branch before promoting a learning.');
  }
}

/** The candidate `learningId` names, or a failure that says it is not one. */
export function promotionCandidate(candidates: readonly PromotionCandidate[], learningId: string): PromotionCandidate {
  const candidate = candidates.find((entry) => entry.docId === learningId);

  if (!candidate) throw new Error(`Learning "${learningId}" not found or not eligible for promotion.`);

  return candidate;
}

/** Runs `fn` holding the sync lock, so no pull or push moves the checkouts it reads and writes. */
async function withSyncLock<T>(localConfig: LocalConfig, fn: () => Promise<T>): Promise<T> {
  const lock = path.join(getDataHome(localConfig), SYNC_LOCK_FILENAME);

  if (!await acquireLock(lock)) {
    throw new Error('Another teamai pull/push/migration is in progress. Retry promotion once it finishes.');
  }

  try {
    return await fn();
  } finally {
    await releaseLock(lock);
  }
}

/**
 * The `publish` step: writes the promoted entry of `learningId` in a disposable worktree, pushes it on a
 * `teamai/push/<user>/<ts>` review branch, and opens a pull request whose body says the category and why, without
 * changing the active checkout. `exit_code` is 1 when the branch is pushed but no pull request could be opened.
 */
async function publish(
  learningId: string,
  localConfig: LocalConfig,
  teamConfig: TeamaiConfig,
  options: { category: PromotionCategory; reason: string; content: PromotedContent; namespaces?: readonly string[] },
): Promise<{ target: string; exit_code: number }> {
  assertCanPromote(localConfig);

  return withSyncLock(localConfig, async () => {
    const { repoPath: knowledgeCheckout, votesDir, learningsReadDirs } = await resolveMaintenancePaths(localConfig, { holdsSyncLock: true });
    await fetchPromotionRefs(knowledgeCheckout);
    const candidate = promotionCandidate(await findPromotionCandidates(learningsReadDirs, votesDir, knowledgeCheckout, { namespaces: options.namespaces }), learningId);
    const message = `[teamai] Promote ${candidate.docId} to ${options.category}`;
    const description = `Category: ${options.category}\n\n${options.reason}`;

    if (options.content.kind === 'as-written') log.warn(`AI content generation failed, using original content: ${options.content.why}`);

    return withKnowledgeWorktree(localConfig, async (checkoutConfig) => {
      const repoPath = checkoutConfig.repo.localPath;
      const content = options.content.kind === 'rewritten' ? options.content.text : undefined;
      const { relativePath } = await writePromotion(candidate, repoPath, { category: options.category, content });
      const branch = await unusedBranchName(repoPath, localConfig.username);
      const git = createGit(repoPath);
      await git.raw(['--literal-pathspecs', 'add', '--', relativePath]);
      await commitSkippingHooks(git, `${message}\n\n${description}`);
      // Push from the detached worktree: a local branch would outlive it in the member's checkout.
      await git.push(['origin', `HEAD:refs/heads/${branch}`]);
      log.success(`Promotion artifact pushed to branch ${branch}`);

      if (getProvider(localConfig.provider ?? teamConfig.provider).name === 'git') {
        log.info(`Create a pull/merge request for ${branch} to review the promoted knowledge.`);

        return { target: relativePath, exit_code: 0 };
      }

      // The artifact is already durable on origin. Keep the marker, and use the existing manual-PR recovery instead
      // of generating it again.
      return { target: relativePath, exit_code: await createPrWithFallback(teamConfig, checkoutConfig, branch, message, description) ? 0 : 1 };
    }, { requireFreshBase: true });
  });
}

const PublishedSchema = z.object({ target: z.string().min(1), exit_code: z.number().int() });

/** What `publish` printed, as `mark` takes it. */
function parsePublished(json: string): z.infer<typeof PublishedSchema> {
  return PublishedSchema.parse(parseJson(json));
}

/**
 * The `mark` step: records `learningId` as promoted to the entry `publish` pushed, and publishes that mark to the
 * learnings branch. `exit_code` is 1 when either the pull request or the mark could not be published.
 */
async function mark(
  learningId: string,
  published: z.infer<typeof PublishedSchema>,
  localConfig: LocalConfig,
  options: { namespaces?: readonly string[] },
): Promise<{ exit_code: number }> {
  return withSyncLock(localConfig, async () => {
    const { learningsReadDirs, learningsWriteDir } = await resolveMaintenancePaths(localConfig, { holdsSyncLock: true });
    const learning = (await listLearningFiles(learningsReadDirs, options.namespaces)).find(({ file }) => file.replace(/\.md$/i, '') === learningId);

    if (!learning) throw new Error(`Learning "${learningId}" not found, so it cannot be marked as promoted to ${published.target}.`);
    const marked = await markPromoted({ docId: learningId, filename: learning.file, path: learning.absPath }, published.target, learningsWriteDir);
    const result = await publishLearningsMaintenance(localConfig, `[teamai] Mark ${learningId} as promoted`, [marked]);

    if (result.status === 'published' || result.status === 'already-present') {
      log.success('Published promotion marker to the learnings branch');

      return { exit_code: published.exit_code };
    }

    log.warn(`The promotion artifact is published; its marker will be retried on the next pull: ${result.status === 'failed' ? result.reason : result.status}`);

    return { exit_code: 1 };
  });
}

/** The verbs a `teamai-promote-learning` run's command steps call. */
export const PromoteLearning = { publish, parsePublished, mark } as const;
