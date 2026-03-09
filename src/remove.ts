import readline from 'node:readline';
import { requireInit, loadState, saveState } from './config.js';
import { pullRepo, pushRepoBranch, checkoutMaster, generateBranchName } from './utils/git.js';
import { gfMrCreate } from './utils/gf-cli.js';
import { parseRepoInput } from './utils/repo-url.js';
import { log, spinner } from './utils/logger.js';
import { getHandler } from './resources/index.js';
import type { GlobalOptions, ResourceType } from './types.js';

function askConfirm(prompt: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(`${prompt} [y/N] `, (answer) => {
      rl.close();
      resolve(answer.toLowerCase() === 'y');
    });
  });
}

const REMOVABLE_TYPES: ResourceType[] = ['skills', 'rules'];

export async function remove(
  type: string,
  name: string,
  options: GlobalOptions,
): Promise<void> {
  if (!REMOVABLE_TYPES.includes(type as ResourceType)) {
    log.error(`Unsupported resource type: ${type}. Supported types: ${REMOVABLE_TYPES.join(', ')}`);
    return;
  }

  const { localConfig, teamConfig } = await requireInit();

  // Pull latest before making changes
  try {
    await pullRepo(localConfig.repo.localPath);
  } catch { /* continue even if pull fails */ }

  const handler = getHandler(type as ResourceType);

  // Verify the resource exists somewhere
  const teamItems = await handler.scanTeamForPull(teamConfig, localConfig);
  const localItems = await handler.scanLocalForPush(teamConfig, localConfig);
  const allNames = new Set([...teamItems.map((i) => i.name), ...localItems.map((i) => i.name)]);

  if (!allNames.has(name)) {
    log.error(`Resource not found: [${type}] ${name}`);
    log.info(`Available ${type}:`);
    for (const n of allNames) {
      console.log(`  - ${n}`);
    }
    return;
  }

  // Show what will be removed
  console.log('');
  console.log(`Will remove [${type}] ${name} from:`);
  console.log('  - team repo');
  console.log('  - all local AI tool directories');
  console.log('');

  if (options.dryRun) {
    log.info('Dry run — no changes made');
    return;
  }

  const confirmed = await askConfirm('Are you sure?');
  if (!confirmed) {
    log.info('Cancelled');
    return;
  }

  const spin = spinner(`Removing ${type} "${name}"...`).start();

  const removedPaths = await handler.removeItem(name, teamConfig, localConfig);

  if (removedPaths.length === 0) {
    spin.fail('Nothing was removed');
    return;
  }

  // Git commit and push via branch + MR
  try {
    const branchName = generateBranchName(localConfig.username);
    const commitMsg = `[teamai] Remove ${type.replace(/s$/, '')} "${name}" by ${localConfig.username}`;

    const hasChanges = await pushRepoBranch(
      localConfig.repo.localPath,
      commitMsg,
      [`${type}/`, 'rules/'],
      branchName,
    );

    if (!hasChanges) {
      spin.succeed('No changes to push');
    } else {
      spin.succeed(`Removed [${type}] ${name} from ${removedPaths.length} location(s)`);

      // Create MR via gf CLI
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
          description: `Remove [${type}] ${name}`,
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
    }
  } catch (e) {
    spin.fail(`Git push failed: ${(e as Error).message}`);
    return;
  }

  // Clean up state tracking
  const state = await loadState();
  if (type === 'skills') {
    state.pushedSkills = state.pushedSkills.filter((s) => s !== name);
  }
  if (type === 'rules') {
    state.pushedRules = state.pushedRules.filter((r) => r !== name);
  }
  await saveState(state);
}
