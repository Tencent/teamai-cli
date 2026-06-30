import path from 'node:path';
import { autoDetectInit, loadStateForScope, saveStateForScope } from './config.js';
import { assertNotReadOnly } from './read-only.js';
import { createGit, pullRepo, pushRepoBranch, checkoutMaster, generateBranchName, resetToCleanMaster, getDefaultBranch } from './utils/git.js';
import { syncTeamUpdatesToLocal } from './utils/pre-push-sync.js';
import { getProvider } from './providers/index.js';
import { log, spinner } from './utils/logger.js';
import { getHandler } from './resources/index.js';
import { scanTeamRepoNamespaces } from './resources/skills.js';
import type { GlobalOptions, ResourceItem, ResourceType } from './types.js';
import { isWikiEnabled } from './types.js';
import { assertSafePath, assertSafeResourceName, defaultAllowedRoots } from './utils/path-safety.js';
import { loadRolesManifest, resolveRoleResourceNamespaces } from './roles.js';
import { askQuestion, askSelection } from './utils/prompt.js';
import { pathExists } from './utils/fs.js';

/**
 * Filter a list of repo-root-relative paths (e.g. "rules/", "env/") down to
 * those that actually exist on disk. `git add` throws `pathspec did not match
 * any files` when any argument doesn't exist, so we guard against that when
 * passing "sweeper" directories that may or may not be present in a given
 * team repo (e.g. a pure-wiki team has no rules/ or env/).
 */
export async function filterExistingTopLevelPaths(
  repoPath: string,
  candidates: string[],
): Promise<string[]> {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const candidate of candidates) {
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    const trimmed = candidate.replace(/\/+$/, '');
    // Empty string (e.g. from "/" only) is nonsense; skip.
    if (!trimmed) continue;
    if (await pathExists(path.join(repoPath, trimmed))) {
      result.push(candidate);
    }
  }
  return result;
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

    const targetBranch = await getDefaultBranch(localConfig.repo.localPath);
    const prUrl = await provider.createPullRequest({
      repo: `${repoInfo.owner}/${repoInfo.repo}`,
      source: branchName,
      target: targetBranch,
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
  assertNotReadOnly(localConfig, 'teamai push');
  const scopeLabel = localConfig.scope;

  // Pull latest default branch BEFORE scanning so detection runs against up-to-date repo.
  // The team repo may be in various broken states from previous failed pushes:
  //   - Unmerged (conflicted) files without MERGE_HEAD (incomplete merge)
  //   - Stuck on a stale push branch instead of master
  //   - Uncommitted changes (e.g. votes written by autoUpvote)
  // We recover from all of these before pulling.
  const pullSpin = spinner('Pulling latest changes...').start();
  try {
    const repoPath = localConfig.repo.localPath;
    const git = createGit(repoPath);
    await resetToCleanMaster(git, repoPath);
    await pullRepo(repoPath);
    pullSpin.succeed('Up to date');
  } catch (e) {
    pullSpin.warn(`Pull failed: ${(e as Error).message}`);
  }

  // Sync team repo updates to local tool directories before scanning.
  // This prevents files changed by teammates from being falsely flagged as "modified".
  try {
    const state = await loadStateForScope(localConfig.scope, localConfig.projectRoot);
    await syncTeamUpdatesToLocal(teamConfig, localConfig, state.lastPullRev);
  } catch (e) {
    log.debug(`Pre-push sync skipped: ${(e as Error).message}`);
  }

  const spin = spinner('Scanning local resources...').start();

  // Scan for pushable resources first, then resolve namespace for new skills only.
  // Modified skills already carry their namespace from scanLocalForPush.
  const pushableTypes: ResourceType[] = isWikiEnabled()
    ? ['skills', 'rules', 'env', 'wiki', 'agents']
    : ['skills', 'rules', 'env', 'agents'];
  const allItems: ResourceItem[] = [];

  for (const type of pushableTypes) {
    const handler = getHandler(type);
    const items = await handler.scanLocalForPush(teamConfig, localConfig);
    allItems.push(...items);
  }

  spin.stop();

  // ── Handle --skill parameter: filter to a single specific skill ──────
  if (options.skill) {
    // 校验 skill 名称安全性：从输入路径中提取 basename 作为资源名，
    // 防御路径遍历、URL 编码绕过、非法字符等攻击
    const skillBasename = path.basename(
      options.skill.startsWith('~')
        ? options.skill.slice(1).replace(/^[/\\]+/, '')
        : options.skill,
    );
    try {
      assertSafeResourceName(skillBasename);
    } catch (e) {
      console.error(`[push] --skill 参数不合法: ${(e as Error).message}`);
      process.exitCode = 2;
      return;
    }

    // Normalize the input path (expand ~, resolve to absolute)
    const os = await import('node:os');
    const skillPath = options.skill.startsWith('~')
      ? path.join(os.homedir(), options.skill.slice(1))
      : path.resolve(options.skill);

    // Try to find matching skill from scan results first
    let matchedItem: ResourceItem | undefined;

    for (const item of allItems) {
      if (item.type !== 'skills') continue;

      // Match by sourcePath (absolute path)
      if (path.resolve(item.sourcePath) === skillPath) {
        matchedItem = item;
        break;
      }

      // Match by skill name
      if (item.name === path.basename(skillPath)) {
        matchedItem = item;
        break;
      }

      // Match by partial path (e.g., "skills/namespace/skillname" in sourcePath)
      const skillInput = options.skill.replace(/^~/, os.homedir());
      if (item.sourcePath.endsWith(skillInput) || item.sourcePath.includes(path.sep + skillInput)) {
        matchedItem = item;
        break;
      }
    }

    // If not found in scan results, force-construct a ResourceItem from the
    // specified path. This handles cases where:
    //   - The skill exists in both a subdirectory (with modifications) and
    //     at the top level (pulled copy identical to team repo), causing the
    //     scanner to see the top-level copy first and skip the modified one.
    //   - The skill content is identical to team repo (no diff detected) but
    //     the user explicitly wants to push it anyway.
    if (!matchedItem) {
      if (await pathExists(skillPath) && await pathExists(path.join(skillPath, 'SKILL.md'))) {
        const skillName = path.basename(skillPath);

        // Try to detect existing namespace from team repo
        let namespace: string | undefined;
        let status: 'new' | 'modified' = 'new';
        const teamSkillsDir = path.join(localConfig.repo.localPath, 'skills');
        if (await pathExists(teamSkillsDir)) {
          const { listDirs } = await import('./utils/fs.js');
          const topDirs = await listDirs(teamSkillsDir);
          for (const dir of topDirs) {
            const candidatePath = path.join(teamSkillsDir, dir, skillName);
            if (await pathExists(candidatePath)) {
              // Check if this is a namespace dir (not a direct skill)
              const isNamespace = !await pathExists(path.join(teamSkillsDir, dir, 'SKILL.md'));
              if (isNamespace) {
                namespace = dir;
              }
              status = 'modified';
              break;
            }
          }
          // Also check flat layout
          if (!namespace && await pathExists(path.join(teamSkillsDir, skillName))) {
            status = 'modified';
          }
        }

        const relPath = namespace
          ? `skills/${namespace}/${skillName}`
          : `skills/${skillName}`;

        matchedItem = {
          name: skillName,
          type: 'skills',
          sourcePath: skillPath,
          relativePath: relPath,
          status,
          namespace,
        };
        log.debug(`Force-pushing skill from explicit path: ${skillPath}`);
      } else {
        const skillNames = allItems
          .filter(i => i.type === 'skills')
          .map(i => `  - ${i.name} (from: ${i.sourcePath})`)
          .join('\n');
        log.error(`Skill not found at path: ${options.skill}`);
        if (skillNames) {
          console.log('');
          console.log('Available skills with changes:');
          console.log(skillNames);
        }
        process.exit(1);
      }
    }

    // Replace allItems with just this one skill
    allItems.length = 0;
    allItems.push(matchedItem);
  }

  if (allItems.length === 0) {
    log.info('No new or modified resources to push');
    return;
  }

  // ── Step 1: Display ALL scanned items with numbers ─────────────────
  console.log('');
  console.log(`Found ${allItems.length} resource(s) to push:`);
  console.log('');
  for (let i = 0; i < allItems.length; i++) {
    const item = allItems[i];
    const statusLabel = item.status === 'modified' ? ' (modified)' : ' (new)';
    const num = `${i + 1}.`.padStart(4);
    console.log(`  ${num} [${item.type}] ${item.name}${statusLabel}`);
    console.log(`       from: ${item.sourcePath}`);
    // Show destination for modified skills that already have a namespace
    if (item.type === 'skills' && item.namespace) {
      console.log(`       to:   skills/${item.namespace}/${item.name}`);
    }
  }
  console.log('');

  // ── Step 2: Dry run exits after display ────────────────────────────
  if (options.dryRun) {
    log.info('Dry run — no changes made');
    return;
  }

  // ── Step 3: Item selection (replaces old Y/n confirmation) ─────────
  let selectedItems: ResourceItem[];
  if (options.all || options.silent) {
    selectedItems = [...allItems];
  } else {
    const selectionPrompt = allItems.length === 1
      ? 'Push this resource? [1/all/none] (default: all): '
      : `Select items to push [1-${allItems.length}, or "all"] (default: all): `;
    const indices = await askSelection(selectionPrompt, allItems.length, true);
    if (!indices || indices.length === 0) {
      log.info('Cancelled');
      return;
    }
    selectedItems = indices.map((i) => allItems[i]);
  }

  // ── Step 4: Resolve namespace for NEW skills only (after selection) ─
  const newSkills = selectedItems.filter((i) => i.type === 'skills' && i.status === 'new');
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

  // ── Step 5: Push each selected item to local repo ──────────────────
  // pushItem copies files into the team repo's working tree. If any later
  // step (refreshMarketplace, pushRepoBranch, createPullRequest) fails, we
  // must wipe those copies + any staging so the next `teamai push` scans
  // cleanly instead of reporting "No new resources" (BUG #2).
  const pushSpin = spinner('Pushing resources...').start();
  const pushedFiles: string[] = [];
  let workingTreeDirtied = false;

  try {
    for (const item of selectedItems) {
      const handler = getHandler(item.type);
      await handler.pushItem(item, teamConfig, localConfig);
      workingTreeDirtied = true;
      pushedFiles.push(item.relativePath);
    }

    // Refresh marketplace.json if it exists and skills were pushed
    if (selectedItems.some((i) => i.type === 'skills')) {
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

    // Create branch, commit, and push.
    // Only include "sweeper" directories (rules/, env/, wiki/) that actually
    // exist — otherwise `git add 'rules/'` throws `pathspec did not match
    // any files` and the whole push aborts (BUG #1). Pure-wiki teams may
    // not have rules/ or env/.
    const sweeperCandidates = ['rules/', 'env/', 'wiki/', '.codebuddy-plugin/'];
    const existingSweepers = await filterExistingTopLevelPaths(
      localConfig.repo.localPath,
      sweeperCandidates,
    );
    const gitFiles = [...new Set([...pushedFiles, ...existingSweepers])];
    const branchName = generateBranchName(localConfig.username);
    const commitMsg = `[teamai] Push ${selectedItems.length} resource(s) from ${localConfig.username}`;

    const hasChanges = await pushRepoBranch(
      localConfig.repo.localPath,
      commitMsg,
      gitFiles,
      branchName,
    );
    // pushRepoBranch committed (or deleted the branch) — working tree is
    // clean either way from the branch's perspective.
    workingTreeDirtied = false;

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
      `Pushed ${selectedItems.length} resource(s):\n${selectedItems.map((i) => `- [${i.type}] ${i.name}`).join('\n')}`,
    );

    // Switch back to master after PR creation
    await checkoutMaster(localConfig.repo.localPath);
  } catch (e) {
    pushSpin.fail(`Push failed: ${(e as Error).message}`);
    if (workingTreeDirtied) {
      try {
        const git = createGit(localConfig.repo.localPath);
        await git.reset(['--hard', 'HEAD']);
        await git.clean('f', ['-d']);
        log.debug('Rolled back team repo working tree after failed push');
      } catch (cleanupErr) {
        log.warn(
          `Warning: team repo may be in a dirty state. Run \`git -C ${localConfig.repo.localPath} reset --hard && git clean -fd\` manually. (${(cleanupErr as Error).message})`,
        );
      }
    }
    return;
  }

  // Update state
  const state = await loadStateForScope(localConfig.scope, localConfig.projectRoot);
  state.lastPush = new Date().toISOString();
  for (const item of selectedItems) {
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
