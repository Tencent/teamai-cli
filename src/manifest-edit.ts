import { DetachedTeamRepoError, pullRepo, pushRepoBranch, checkoutMaster, unusedBranchName } from './utils/git.js';
import { log, spinner } from './utils/logger.js';
import { createPrWithFallback, providerOpensPullRequests } from './push.js';
import type { TeamaiConfig, LocalConfig } from './types.js';

// Shared plumbing for the admin commands that edit `manifest/*.yaml`
// (`roles add/update/remove`, `projects add/update/remove`).

export async function pullLatest(repoPath: string): Promise<void> {
    const pullSpin = (await spinner('Pulling latest changes...')).start();

    try {
        await pullRepo(repoPath);
        pullSpin.succeed('Up to date');
    } catch (e) {
        DetachedTeamRepoError.rethrow(e);
        pullSpin.warn(`Pull failed: ${e instanceof Error ? e.message : String(e)}`);
    }
}

/**
 * Run a manifest admin edit (write manifest + open PR) against the right repo.
 * In single-repo mode the manifest is knowledge on main, so the edit runs inside
 * an isolated knowledge worktree (never the user's active tree); otherwise the
 * team repo clone is pulled first. A dry run reads the post-pull branch contents
 * from a throwaway checkout instead and never pulls, since the pull can reset a clone
 * with unpushed commits (#900). `fn` receives the repoPath to read/write the
 * manifest and the localConfig to use for the PR, both scoped to that checkout.
 */
export async function runManifestEdit(
    localConfig: LocalConfig,
    label: string,
    fn: (repoPath: string, editConfig: LocalConfig) => Promise<void>,
    options: { dryRun?: boolean; skipPull?: boolean } = {},
): Promise<void> {
    if (!options.dryRun && localConfig.repo.kind !== 'self') {
        if (!options.skipPull) await pullLatest(localConfig.repo.localPath);
        await fn(localConfig.repo.localPath, localConfig);

        return;
    }

    const { withKnowledgeWorktree, withDefaultBranchPreview, EmptyRepoError, DirtyPreviewError } = await import('./utils/reports-branch.js');
    const body = (checkoutConfig: LocalConfig) => fn(checkoutConfig.repo.localPath, checkoutConfig);

    try {
        if (options.dryRun) {
            // Real manifest edits also warn and proceed when their pull fails.
            await withDefaultBranchPreview(localConfig, body, { allowStale: true });
        } else {
            await withKnowledgeWorktree(localConfig, body);
        }
    } catch (e) {
        // Every branch is a failed edit: the caller asked for a manifest change
        // and did not get one, so the exit code says so whichever way it failed.
        if (e instanceof DirtyPreviewError || e instanceof DetachedTeamRepoError) {
            log.error(e.message);
        } else if (e instanceof EmptyRepoError) {
            log.error(e.message);
        } else {
            log.error(`${label} update failed: ${e instanceof Error ? e.message : String(e)}`);
        }

        process.exitCode = 1;
    }
}

export async function pushManifestChange(input: {
    repoPath: string;
    teamConfig: TeamaiConfig;
    localConfig: LocalConfig;
    commitMsg: string;
    prDescription: string;
}): Promise<void> {
    const { repoPath, teamConfig, localConfig, commitMsg, prDescription } = input;
    const branchName = await unusedBranchName(repoPath, localConfig.username);

    try {
        const hasChanges = await pushRepoBranch(
            repoPath,
            commitMsg,
            ['manifest/'],
            branchName,
        );

        if (!hasChanges) {
            log.info('No changes to push (manifest unchanged)');

            return;
        }

        log.success(`Pushed branch ${branchName}`);

        const prUrl = await createPrWithFallback(
            teamConfig,
            localConfig,
            branchName,
            commitMsg,
            prDescription,
        );

        // A branch no one reviews does not deliver the edit, so the manifest
        // change is not done — unless nothing here opens pull requests at all:
        // a provider that reaches only git, or a remote that names no hosted
        // repository.
        if (!prUrl && providerOpensPullRequests(teamConfig, localConfig)) process.exitCode = 1;

        await checkoutMaster(repoPath);
    } catch (e) {
        log.error(`Push failed: ${e instanceof Error ? e.message : String(e)}`);
        process.exitCode = 1;
    }
}
