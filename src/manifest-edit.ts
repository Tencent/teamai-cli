import { pullRepo, pushRepoBranch, checkoutMaster, generateBranchName } from './utils/git.js';
import { log, spinner } from './utils/logger.js';
import { createPrWithFallback } from './push.js';
import type { TeamaiConfig, LocalConfig } from './types.js';

// Shared plumbing for the admin commands that edit `manifest/*.yaml`
// (`roles add/update/remove`, `projects add/update/remove`).

export async function pullLatest(repoPath: string): Promise<void> {
    const pullSpin = spinner('Pulling latest changes...').start();
    try {
        await pullRepo(repoPath);
        pullSpin.succeed('Up to date');
    } catch (e) {
        pullSpin.warn(`Pull failed: ${(e as Error).message}`);
    }
}

/**
 * Run a manifest admin edit (write manifest + open PR) against the right repo.
 * In single-repo mode the manifest is knowledge on main, so the edit runs inside
 * an isolated knowledge worktree (never the user's active tree); otherwise the
 * team repo clone is pulled first. A dry run reads origin/<default> from a
 * throwaway checkout instead and never pulls, since the pull can reset a clone
 * with unpushed commits (#900). `fn` receives the repoPath to read/write the
 * manifest and the localConfig to use for the PR, both scoped to that checkout.
 */
export async function runManifestEdit(
    localConfig: LocalConfig,
    label: string,
    fn: (repoPath: string, editConfig: LocalConfig) => Promise<void>,
    options: { dryRun?: boolean } = {},
): Promise<void> {
    if (!options.dryRun && localConfig.repo.kind !== 'self') {
        await pullLatest(localConfig.repo.localPath);
        await fn(localConfig.repo.localPath, localConfig);
        return;
    }
    const { withKnowledgeWorktree, withDefaultBranchPreview, EmptyRepoError } = await import('./utils/reports-branch.js');
    const withCheckout = options.dryRun ? withDefaultBranchPreview : withKnowledgeWorktree;
    try {
        await withCheckout(localConfig, (checkoutConfig) => fn(checkoutConfig.repo.localPath, checkoutConfig));
    } catch (e) {
        if (e instanceof EmptyRepoError) {
            log.error(e.message);
        } else {
            log.error(`${label} update failed: ${(e as Error).message}`);
        }
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
    const branchName = generateBranchName(localConfig.username);

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

        await createPrWithFallback(
            teamConfig,
            localConfig,
            branchName,
            commitMsg,
            prDescription,
        );

        await checkoutMaster(repoPath);
    } catch (e) {
        log.error(`Push failed: ${(e as Error).message}`);
    }
}
