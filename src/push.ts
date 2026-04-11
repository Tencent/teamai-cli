import readline from 'node:readline';
import { autoDetectInit, loadStateForScope, saveStateForScope } from './config.js';
import { createGit, pullRepo, pushRepoBranch, checkoutMaster, generateBranchName, resetToCleanMaster } from './utils/git.js';
import { getProvider } from './providers/index.js';
import { log, spinner } from './utils/logger.js';
import { getHandler } from './resources/index.js';
import { scanTeamRepoNamespaces } from './resources/skills.js';
import type { GlobalOptions, ResourceItem, ResourceType } from './types.js';
import { loadRolesManifest, resolveRoleResourceNamespaces } from './roles.js';

function askConfirm(prompt: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(`${prompt} [Y/n] `, (answer) => {
      rl.close();
      resolve(!answer || answer.toLowerCase() === 'y');
    });
  });
}

function askQuestion(prompt: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

/**
 * Resolve available skill namespaces for the current user.
 * Returns the deduplicated list from the manifest (via role config),
 * or falls back to [primaryRole] if no manifest exists.
 */
async function resolveSkillNamespaces(
  repoPath: string,
  primaryRole: string,
  additionalRoles: string[],
): Promise<string[]> {
  try {
    const manifest = await loadRolesManifest(repoPath);
    const namespaces = resolveRoleResourceNamespaces({
      manifest,
      primaryRole,
      additionalRoles,
    });
    return namespaces.skills;
  } catch {
    return [primaryRole];
  }
}

/**
 * Create a PR/MR via the configured provider with standard error handling.
 * Returns the PR URL on success, or null if creation failed (branch is still pushed).
 */
async function createPrWithFallback(
  teamConfig: { repo: string; provider?: string; reviewers?: string[] },
  localConfig: { repo: { remote: string; localPath: string } },
  branchName: string,
  title: string,
  description: string,
): Promise<string | null> {
  const provider = getProvider(teamConfig.provider);
  const mrSpin = spinner('Creating Pull Request...').start();
  try {
    let repoInfo;
    try {
      repoInfo = provider.parseRepoInput(teamConfig.repo);
    } catch {
      repoInfo = provider.parseRepoInput(localConfig.repo.remote);
    }

    const prUrl = provider.createPullRequest({
      repo: `${repoInfo.owner}/${repoInfo.repo}`,
      source: branchName,
      target: 'master',
      title,
      description,
      reviewers: teamConfig.reviewers?.length ? teamConfig.reviewers : undefined,
      cwd: localConfig.repo.localPath,
    });
    mrSpin.succeed(`Pull Request created: ${prUrl}`);
    return prUrl;
  } catch (e) {
    mrSpin.fail(`Failed to create PR: ${(e as Error).message}`);
    log.info(`Branch ${branchName} has been pushed. You can create a PR manually.`);
    return null;
  }
}

export { createPrWithFallback };

export async function push(options: GlobalOptions & { all?: boolean; role?: string }): Promise<void> {
  // Auto-detect scope: project scope if cwd has project config, else user scope
  const { localConfig, teamConfig } = await autoDetectInit();
  const scopeLabel = localConfig.scope;

  // Pull latest master BEFORE scanning so detection runs against up-to-date repo.
  // The team repo may be in various broken states from previous failed pushes:
  //   - Unmerged (conflicted) files without MERGE_HEAD (incomplete merge)
  //   - Stuck on a stale push branch instead of master
  //   - Uncommitted changes (e.g. votes written by autoUpvote)
  // We recover from all of these before pulling.
  const pullSpin = spinner('Pulling latest master...').start();
  try {
    const repoPath = localConfig.repo.localPath;
    const git = createGit(repoPath);
    await resetToCleanMaster(git);
    await pullRepo(repoPath);
    pullSpin.succeed('Master up to date');
  } catch (e) {
    pullSpin.warn(`Pull failed: ${(e as Error).message}`);
  }

  const spin = spinner('Scanning local resources...').start();

  // Scan for pushable resources first, then resolve namespace for new skills only.
  // Modified skills already carry their namespace from scanLocalForPush.
  const pushableTypes: ResourceType[] = ['skills', 'rules', 'env'];
  const allItems: ResourceItem[] = [];

  for (const type of pushableTypes) {
    const handler = getHandler(type);
    const items = await handler.scanLocalForPush(teamConfig, localConfig);
    allItems.push(...items);
  }

  spin.stop();

  if (allItems.length === 0) {
    log.info('No new or modified resources to push');
    return;
  }

  // Resolve namespace for NEW skills only.
  // Modified skills already have their namespace set by scanLocalForPush.
  const newSkills = allItems.filter((i) => i.type === 'skills' && i.status === 'new');
  let resolvedNamespaceForNew: string | undefined;

  if (newSkills.length > 0) {
    if (options.role) {
      // Explicit --role flag: use as namespace directly (backward compat)
      resolvedNamespaceForNew = options.role;
    } else if (localConfig.primaryRole) {
      try {
        const skillNamespaces = await resolveSkillNamespaces(
          localConfig.repo.localPath,
          localConfig.primaryRole,
          localConfig.additionalRoles ?? [],
        );

        if (skillNamespaces.length === 0) {
          resolvedNamespaceForNew = undefined;
        } else if (skillNamespaces.length === 1) {
          resolvedNamespaceForNew = skillNamespaces[0];
        } else if (options.silent) {
          resolvedNamespaceForNew = localConfig.primaryRole;
        } else {
          console.log('');
          console.log('Which namespace should new skills be pushed to?');
          skillNamespaces.forEach((ns, index) => {
            console.log(`  ${index + 1}. ${ns}`);
          });
          console.log('');
          const answer = await askQuestion(
            `Choose namespace [1-${skillNamespaces.length}] (default: 1 = ${skillNamespaces[0]}): `,
          );
          const selection = answer ? Number.parseInt(answer, 10) : 1;
          if (Number.isNaN(selection) || selection < 1 || selection > skillNamespaces.length) {
            log.error(`Invalid selection. Choose a number between 1 and ${skillNamespaces.length}.`);
            return;
          }
          resolvedNamespaceForNew = skillNamespaces[selection - 1];
        }
      } catch (e) {
        log.error((e as Error).message);
        return;
      }
    } else {
      // No role configured — auto-detect namespaces from team repo structure
      try {
        const detectedNamespaces = await scanTeamRepoNamespaces(localConfig.repo.localPath);

        if (detectedNamespaces.length === 0) {
          resolvedNamespaceForNew = undefined;
        } else if (detectedNamespaces.length === 1) {
          resolvedNamespaceForNew = detectedNamespaces[0];
        } else if (options.silent) {
          resolvedNamespaceForNew = detectedNamespaces[0];
        } else {
          console.log('');
          console.log('Which namespace should new skills be pushed to?');
          detectedNamespaces.forEach((ns, index) => {
            console.log(`  ${index + 1}. ${ns}`);
          });
          console.log('');
          const answer = await askQuestion(
            `Choose namespace [1-${detectedNamespaces.length}] (default: 1 = ${detectedNamespaces[0]}): `,
          );
          const selection = answer ? Number.parseInt(answer, 10) : 1;
          if (Number.isNaN(selection) || selection < 1 || selection > detectedNamespaces.length) {
            log.error(`Invalid selection. Choose a number between 1 and ${detectedNamespaces.length}.`);
            return;
          }
          resolvedNamespaceForNew = detectedNamespaces[selection - 1];
        }
      } catch {
        resolvedNamespaceForNew = undefined;
      }
    }

    // Apply namespace to new skills
    for (const item of newSkills) {
      if (resolvedNamespaceForNew) {
        item.namespace = resolvedNamespaceForNew;
        item.relativePath = `skills/${resolvedNamespaceForNew}/${item.name}`;
      }
    }
  }

  // Display items
  console.log('');
  console.log(`Found ${allItems.length} resource(s) to push:`);
  console.log('');
  for (const item of allItems) {
    const statusLabel = item.status === 'modified' ? ' (modified)' : ' (new)';
    console.log(`  [${item.type}] ${item.name}${statusLabel}`);
    console.log(`    from: ${item.sourcePath}`);
    if (item.type === 'skills' && item.namespace) {
      console.log(`    to:   skills/${item.namespace}/${item.name}`);
    }
  }
  console.log('');

  if (options.dryRun) {
    log.info('Dry run — no changes made');
    return;
  }

  // Confirm
  if (!options.all && !options.silent) {
    const confirmed = await askConfirm('Push these resources to team repo?');
    if (!confirmed) {
      log.info('Cancelled');
      return;
    }
  }

  // Push each item to local repo
  const pushSpin = spinner('Pushing resources...').start();
  const pushedFiles: string[] = [];

  for (const item of allItems) {
    const handler = getHandler(item.type);
    await handler.pushItem(item, teamConfig, localConfig);
    pushedFiles.push(item.relativePath);
  }

  // Refresh marketplace.json if it exists and skills were pushed
  if (allItems.some((i) => i.type === 'skills')) {
    try {
      const { refreshMarketplace } = await import('./resources/marketplace.js');
      const updated = await refreshMarketplace(localConfig.repo.localPath);
      if (updated) {
        pushedFiles.push('.codebuddy-plugin/marketplace.json');
        log.debug('Refreshed marketplace.json');
      }
    } catch (e) {
      log.debug(`Marketplace refresh skipped: ${(e as Error).message}`);
    }
  }

  // Create branch, commit, and push
  try {
    const gitFiles = [...new Set([
      ...pushedFiles,
      'rules/',
      'env/',
    ])];
    const branchName = generateBranchName(localConfig.username);
    const commitMsg = `[teamai] Push ${allItems.length} resource(s) from ${localConfig.username}`;

    const hasChanges = await pushRepoBranch(
      localConfig.repo.localPath,
      commitMsg,
      gitFiles,
      branchName,
    );

    if (!hasChanges) {
      pushSpin.succeed('No changes to push (files already up to date)');
      return;
    }

    pushSpin.succeed(`Pushed branch ${branchName}`);

    // Create PR/MR via provider
    await createPrWithFallback(
      teamConfig,
      localConfig,
      branchName,
      commitMsg,
      `Pushed ${allItems.length} resource(s):\n${allItems.map((i) => `- [${i.type}] ${i.name}`).join('\n')}`,
    );

    // Switch back to master after PR creation
    await checkoutMaster(localConfig.repo.localPath);
  } catch (e) {
    pushSpin.fail(`Push failed: ${(e as Error).message}`);
    return;
  }

  // Update state
  const state = await loadStateForScope(localConfig.scope, localConfig.projectRoot);
  state.lastPush = new Date().toISOString();
  for (const item of allItems) {
    if (item.type === 'skills' && !state.pushedSkills.includes(item.name)) {
      state.pushedSkills.push(item.name);
    }
    if (item.type === 'rules' && !state.pushedRules.includes(item.name)) {
      state.pushedRules.push(item.name);
    }
    if (item.type === 'env' && !state.pushedEnvVars.includes(item.name)) {
      state.pushedEnvVars.push(item.name);
    }
  }
  await saveStateForScope(state, localConfig.scope, localConfig.projectRoot);
}
