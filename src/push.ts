import readline from 'node:readline';
import { requireInit, loadState, saveState } from './config.js';
import { pullRepo, pushRepoBranch, checkoutMaster, generateBranchName } from './utils/git.js';
import { gfMrCreate } from './utils/gf-cli.js';
import { parseRepoInput } from './utils/repo-url.js';
import { log, spinner } from './utils/logger.js';
import { getHandler } from './resources/index.js';
import type { GlobalOptions, ResourceItem, ResourceType } from './types.js';

function askConfirm(prompt: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(`${prompt} [Y/n] `, (answer) => {
      rl.close();
      resolve(!answer || answer.toLowerCase() === 'y');
    });
  });
}

export async function push(options: GlobalOptions & { all?: boolean }): Promise<void> {
  const { localConfig, teamConfig } = await requireInit();

  // Pull latest master BEFORE scanning so detection runs against up-to-date repo
  const pullSpin = spinner('Pulling latest master...').start();
  try {
    await pullRepo(localConfig.repo.localPath);
    pullSpin.succeed('Master up to date');
  } catch (e) {
    pullSpin.warn(`Pull failed: ${(e as Error).message}`);
  }

  const spin = spinner('Scanning local resources...').start();

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
    if (options.verbose) {
      console.log(`    from: ${item.sourcePath}`);
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

  // Create branch, commit, and push
  try {
    const gitFiles = ['skills/', 'rules/', 'env/'];
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

    // Create Merge Request via gf CLI
    // HEAD is still on branchName so gf's internal push sees the right branch
    const mrSpin = spinner('Creating Merge Request...').start();
    try {
      let repoInfo;
      try {
        repoInfo = parseRepoInput(teamConfig.repo);
      } catch {
        repoInfo = parseRepoInput(localConfig.repo.remote);
      }

      const mrUrl = gfMrCreate({
        repo: `${repoInfo.owner}/${repoInfo.repo}`,
        source: branchName,
        target: 'master',
        title: commitMsg,
        description: `Pushed ${allItems.length} resource(s):\n${allItems.map((i) => `- [${i.type}] ${i.name}`).join('\n')}`,
        reviewers: teamConfig.reviewers?.length ? teamConfig.reviewers : undefined,
        cwd: localConfig.repo.localPath,
      });
      mrSpin.succeed(`Merge Request created: ${mrUrl}`);
    } catch (e) {
      mrSpin.fail(`Failed to create MR: ${(e as Error).message}`);
      log.info(`Branch ${branchName} has been pushed. You can create a MR manually.`);
    }

    // Switch back to master after MR creation
    await checkoutMaster(localConfig.repo.localPath);
  } catch (e) {
    pushSpin.fail(`Push failed: ${(e as Error).message}`);
    return;
  }

  // Update state
  const state = await loadState();
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
  await saveState(state);
}
