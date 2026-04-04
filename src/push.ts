import readline from 'node:readline';
import { autoDetectInit, loadStateForScope, saveStateForScope } from './config.js';
import { pullRepo, pushRepoBranch, checkoutMaster, generateBranchName } from './utils/git.js';
import { getProvider } from './providers/index.js';
import { log, spinner } from './utils/logger.js';
import { getHandler } from './resources/index.js';
import type { GlobalOptions, ResourceItem, ResourceType } from './types.js';
import { loadRolesManifest, listRoleIds } from './roles.js';

function askConfirm(prompt: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(`${prompt} [Y/n] `, (answer) => {
      rl.close();
      resolve(!answer || answer.toLowerCase() === 'y');
    });
  });
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

  // Pull latest master BEFORE scanning so detection runs against up-to-date repo
  const pullSpin = spinner('Pulling latest master...').start();
  try {
    await pullRepo(localConfig.repo.localPath);
    pullSpin.succeed('Master up to date');
  } catch (e) {
    pullSpin.warn(`Pull failed: ${(e as Error).message}`);
  }

  const spin = spinner('Scanning local resources...').start();

  let resolvedRole: string | undefined;
  if (options.role || localConfig.primaryRole) {
    try {
      const manifest = await loadRolesManifest(localConfig.repo.localPath);
      const validRoles = new Set(listRoleIds(manifest));
      resolvedRole = options.role ?? localConfig.primaryRole;
      if (!resolvedRole || !validRoles.has(resolvedRole)) {
        throw new Error(`Invalid role "${resolvedRole ?? ''}". Valid roles: ${[...validRoles].join(', ')}`);
      }
    } catch (e) {
      spin.fail((e as Error).message);
      return;
    }
  }

  // Scan for pushable resources
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

  // Display items
  console.log('');
  console.log(`Found ${allItems.length} resource(s) to push:`);
  console.log('');
  for (const item of allItems) {
    const statusLabel = item.status === 'modified' ? ' (modified)' : ' (new)';
    console.log(`  [${item.type}] ${item.name}${statusLabel}`);
    console.log(`    from: ${item.sourcePath}`);
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
    if (item.type === 'skills' && resolvedRole) {
      item.bucket = resolvedRole;
      item.relativePath = `skills/${resolvedRole}/${item.name}`;
    }
    const handler = getHandler(item.type);
    await handler.pushItem(item, teamConfig, localConfig);
    pushedFiles.push(item.relativePath);
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
