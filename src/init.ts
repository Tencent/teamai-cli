import YAML from 'yaml';
import path from 'node:path';
import { saveLocalConfig, loadTeamConfig, saveLocalConfigForScope, loadStateForScope, saveStateForScope } from './config.js';
import { injectHooksToAllTools } from './hooks.js';
import { configureGitUser, initRepo } from './utils/git.js';
import { pushRepoDirectly } from './utils/git.js';
import { getProvider, detectProvider, RepoNotFoundError } from './providers/index.js';
import { ensureDir, writeFile, pathExists, expandHome, readFileSafe } from './utils/fs.js';
import { log, spinner } from './utils/logger.js';
import { TEAMAI_HOME, type GlobalOptions, type LocalConfig, type Scope, getTeamaiHome, getConfigPath, resolveBaseDir } from './types.js';
import { describeRoles, loadRolesManifest } from './roles.js';
import { askQuestion, askConfirmation, closePrompt } from './utils/prompt.js';

function parseRoleSelection(answer: string, max: number): number[] {
  if (!answer.trim()) return [];

  const selections = answer
    .split(',')
    .map((item) => Number.parseInt(item.trim(), 10))
    .filter((value) => !Number.isNaN(value));

  if (selections.length === 0) {
    throw new Error('Please enter one or more role numbers, separated by commas.');
  }

  for (const selection of selections) {
    if (selection < 1 || selection > max) {
      throw new Error(`Role selection out of range. Choose numbers between 1 and ${max}.`);
    }
  }

  return [...new Set(selections)];
}

async function promptForRoleProfile(
  repoPath: string,
  roleFlag?: string,
): Promise<Pick<LocalConfig, 'primaryRole' | 'additionalRoles' | 'resourceProfileVersion'>> {
  const manifest = await loadRolesManifest(repoPath);
  const roleLabels = describeRoles(manifest.roles);

  // If --role flag provided, resolve it directly by ID
  if (roleFlag) {
    const match = manifest.roles.find((r) => r.id === roleFlag);
    if (!match) {
      throw new Error(
        `Unknown role "${roleFlag}". Available roles: ${manifest.roles.map((r) => r.id).join(', ')}`,
      );
    }
    return {
      primaryRole: match.id,
      additionalRoles: [],
      resourceProfileVersion: manifest.version,
    };
  }

  log.info('Available roles:');
  roleLabels.forEach((label, index) => {
    log.info(`  ${index + 1}. ${label}`);
  });

  const primaryAnswer = await askQuestion('Primary role (number): ');
  const [primaryIndex] = parseRoleSelection(primaryAnswer, manifest.roles.length);
  if (!primaryIndex) {
    throw new Error('A primary role is required.');
  }

  const primaryRole = manifest.roles[primaryIndex - 1];
  const additionalCandidates = manifest.roles.filter((role) => role.id !== primaryRole.id);
  let additionalRoles: string[] = [];

  if (additionalCandidates.length > 0) {
    log.info('Additional roles (optional):');
    additionalCandidates.forEach((role, index) => {
      const suffix = role.description ? `: ${role.description}` : '';
      log.info(`  ${index + 1}. ${role.id}${suffix}`);
    });

    const additionalAnswer = await askQuestion(
      'Additional roles (comma-separated numbers, blank to skip): ',
      '',
    );
    const additionalIndexes = parseRoleSelection(additionalAnswer, additionalCandidates.length);
    additionalRoles = additionalIndexes.map((selection) => additionalCandidates[selection - 1].id);
  }

  return {
    primaryRole: primaryRole.id,
    additionalRoles,
    resourceProfileVersion: manifest.version,
  };
}

/**
 * Validate that the local --scope matches the remote repo's declared scope.
 * Legacy repos (scope undefined) allow any local scope.
 */
export function validateScopeMatch(remoteScope: Scope | undefined, localScope: Scope): void {
  if (remoteScope === undefined) return; // legacy repo — no restriction
  if (remoteScope !== localScope) {
    throw new Error(
      `Scope mismatch: this repo is configured as "${remoteScope}" scope, ` +
      `but you are trying to init with --scope ${localScope}. ` +
      `Please use --scope ${remoteScope}.`,
    );
  }
}

export async function init(options: GlobalOptions & { repo?: string; scope?: string; role?: string; force?: boolean }): Promise<void> {
  log.info('Initializing teamai...');

  // Step 0: Determine scope (user or project)
  let scope: Scope = 'user';
  if (options.scope === 'project' || options.scope === 'user') {
    scope = options.scope as Scope;
  } else {
    const userPath = getTeamaiHome('user');
    const projectPath = getTeamaiHome('project', process.cwd());
    log.info(`  user    → ${userPath}/`);
    log.info(`  project → ${projectPath}/`);
    const scopeAnswer = await askQuestion('Scope [user/project] (default: user): ', 'user');
    if (scopeAnswer.toLowerCase() === 'project') {
      scope = 'project';
    }
  }

  const projectRoot = scope === 'project' ? process.cwd() : undefined;
  const teamaiHome = getTeamaiHome(scope, projectRoot);

  log.info(`Scope: ${scope}${scope === 'project' ? ` (${projectRoot})` : ''}`);

  // Step 0.5: Re-init guard — warn if config already exists
  const existingConfigPath = getConfigPath(scope, projectRoot);
  if (await pathExists(existingConfigPath)) {
    log.warn(`teamai is already initialized for ${scope} scope at ${existingConfigPath}`);
    if (options.force) {
      log.info('Overwriting existing config (--force)');
    } else {
      const confirmed = await askConfirmation('Overwrite existing config? [y/N] ');
      if (!confirmed) {
        log.info('Aborted. Existing config is unchanged.');
        return;
      }
    }
  }

  // Step 1: Get repo input first (needed to detect provider)
  let repoInput = options.repo ?? '';
  if (!repoInput) {
    repoInput = await askQuestion('Team repo (e.g. yourteam/yourproject or https://github.com/org/repo): ');
  }
  if (!repoInput) {
    log.error('Repo is required');
    process.exit(1);
  }

  // Step 1b: Detect and initialize provider from URL
  const providerName = detectProvider(repoInput);
  const provider = getProvider(providerName);
  log.debug(`Detected provider: ${providerName}`);

  let repoInfo;
  try {
    repoInfo = provider.parseRepoInput(repoInput);
  } catch (e) {
    log.error((e as Error).message);
    process.exit(1);
  }

  // Step 2: Ensure provider tools are installed and authenticate
  await provider.ensureInstalled();

  const authSpin = spinner('Checking authentication...').start();
  let username: string;
  try {
    if (provider.isAuthenticated()) {
      username = await provider.authenticate();
      authSpin.succeed(`Authenticated as ${username}`);
    } else {
      authSpin.info('Not logged in — starting authentication');
      username = await provider.authenticate();
      log.success(`Authenticated as ${username}`);
    }
  } catch (e) {
    authSpin.fail(`Authentication failed: ${(e as Error).message}`);
    process.exit(1);
  }

  // Step 3: Clone or link repo
  const defaultLocalPath = path.join(teamaiHome, 'team-repo');
  let localPath: string;

  if (await pathExists(expandHome(defaultLocalPath))) {
    localPath = expandHome(defaultLocalPath);
    log.info(`Repo already exists at ${localPath}, using existing clone`);
  } else {
    localPath = expandHome(defaultLocalPath);
    log.info(`Clone path: ${localPath}`);
  }

  if (!await pathExists(localPath)) {
    const cloneSpin = spinner('Cloning team repo...').start();
    try {
      provider.cloneRepo(`${repoInfo.owner}/${repoInfo.repo}`, localPath);
      cloneSpin.succeed('Team repo cloned');
    } catch (e) {
      if (e instanceof RepoNotFoundError) {
        cloneSpin.info(`Repo ${repoInfo.owner}/${repoInfo.repo} does not exist`);
        const confirmed = await askConfirmation(
          `Create repo ${repoInfo.owner}/${repoInfo.repo}? [Y/n] `,
          true,
        );
        if (!confirmed) {
          log.error('Aborted. Please provide an existing repo or confirm creation.');
          process.exit(1);
        }
        const createSpin = spinner(`Creating repo ${repoInfo.owner}/${repoInfo.repo}...`).start();
        try {
          await provider.createRepo(repoInfo.owner, repoInfo.repo);
          createSpin.succeed(`Repo ${repoInfo.owner}/${repoInfo.repo} created`);
        } catch (ce) {
          createSpin.fail(`Failed to create repo: ${(ce as Error).message}`);
          process.exit(1);
        }
        // Retry clone after creation
        const retryCloneSpin = spinner('Cloning newly created repo...').start();
        try {
          provider.cloneRepo(`${repoInfo.owner}/${repoInfo.repo}`, localPath);
          retryCloneSpin.succeed('Team repo cloned');
        } catch (ce) {
          retryCloneSpin.fail(`Clone failed: ${(ce as Error).message}`);
          process.exit(1);
        }
      } else {
        cloneSpin.fail(`Clone failed: ${(e as Error).message}`);
        process.exit(1);
      }
    }

    // Cloning an empty remote repo may succeed without creating the local directory.
    // Fall back to git init + add remote so subsequent steps can proceed.
    if (!await pathExists(localPath)) {
      const initSpin = spinner('Initializing empty repo...').start();
      try {
        await initRepo(repoInfo.httpsUrl, localPath);
        initSpin.succeed('Empty repo initialized');
      } catch (e) {
        initSpin.fail(`Init failed: ${(e as Error).message}`);
        process.exit(1);
      }
    }
  }

  // Step 3.5: Configure git user for the team repo
  const emailDomain = provider.getDefaultEmailDomain() ?? undefined;
  await configureGitUser(localPath, username, username, undefined, emailDomain);

  // Step 4: Load team config
  const teamConfig = await loadTeamConfig(localPath);
  if (!teamConfig) {
    log.warn('teamai.yaml not found in repo. Creating default config...');
    const defaultConfig = YAML.stringify({
      team: 'my-team',
      scope,
      description: 'TeamAI shared resources',
      repo: repoInfo.httpsUrl,
      provider: providerName,
      sharing: {
        rules: { enforced: [] },
        docs: { localDir: scope === 'project' ? './.teamai/docs' : '~/.teamai/docs' },
        env: { injectShellProfile: true },
      },
    });
    await writeFile(path.join(localPath, 'teamai.yaml'), defaultConfig);

    // Create standard directories
    for (const dir of ['members', 'skills', 'rules', 'docs', 'env']) {
      await ensureDir(path.join(localPath, dir));
      const gitkeep = path.join(localPath, dir, '.gitkeep');
      if (!await pathExists(gitkeep)) {
        await writeFile(gitkeep, '');
      }
    }
  } else {
    // Existing repo — validate that remote scope matches local scope
    try {
      validateScopeMatch(teamConfig.scope, scope);
    } catch (e) {
      log.error((e as Error).message);
      process.exit(1);
    }
  }

  // Step 5: Create member file
  const memberPath = path.join(localPath, 'members', `${username}.yaml`);
  const isNewMember = !await pathExists(memberPath);
  if (isNewMember) {
    const memberYaml = YAML.stringify({
      username,
      displayName: username,
      registeredAt: new Date().toISOString(),
    });
    await writeFile(memberPath, memberYaml);
    log.success(`Registered as team member: ${username}`);

    if (!options.dryRun) {
      try {
        await pushRepoDirectly(localPath, `[teamai] Register member: ${username}`, [
          'members/',
          'teamai.yaml',
          'skills/.gitkeep',
          'rules/.gitkeep',
          'docs/.gitkeep',
          'env/.gitkeep',
        ]);
        log.success('Member registration pushed to team repo');
      } catch (e) {
        log.warn(`Push failed (you can push manually later): ${(e as Error).message}`);
      }
    }
  } else {
    log.info(`Member ${username} already registered`);
  }

  // Step 5.5: Configure default MR reviewers (only for fresh setup with no reviewers yet).
  // --force implies non-interactive: skip reviewer prompts entirely (can be configured later).
  const currentConfig = await loadTeamConfig(localPath);
  const hasReviewers = currentConfig?.reviewers && currentConfig.reviewers.length > 0;
  if (isNewMember && !hasReviewers && !options.force) {
    const wantReviewers = await askConfirmation(
      '\nWould you like to configure default MR reviewers? [y/N] ',
    );
    if (wantReviewers) {
      const reviewerInput = await askQuestion('Reviewers (comma-separated usernames): ', '');
      const reviewers = reviewerInput
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);

      if (reviewers.length > 0) {
        const configPath = path.join(localPath, 'teamai.yaml');
        const configContent = await readFileSafe(configPath);
        if (configContent) {
          const configData = YAML.parse(configContent) as Record<string, unknown>;
          configData.reviewers = reviewers;
          await writeFile(configPath, YAML.stringify(configData));
          log.success(`Configured ${reviewers.length} reviewer(s): ${reviewers.join(', ')}`);

          if (!options.dryRun) {
            try {
              await pushRepoDirectly(localPath, `[teamai] Configure reviewers: ${reviewers.join(', ')}`, [
                'teamai.yaml',
              ]);
              log.success('Reviewer config pushed to team repo');
            } catch (e) {
              log.warn(`Push failed (you can push manually later): ${(e as Error).message}`);
            }
          }
        }
      }
    }
  }

  // Step 6: Save local config
  const localConfig: LocalConfig = {
    repo: { localPath, remote: repoInfo.httpsUrl },
    username,
    scope,
    projectRoot,
    additionalRoles: [],
  };

  try {
    Object.assign(localConfig, await promptForRoleProfile(localPath, options.role));
  } catch (error) {
    const msg = (error as Error).message;
    if (msg.includes('Roles manifest not found')) {
      log.debug('No roles manifest found — skipping role selection');
    } else {
      log.error(msg);
      process.exit(1);
    }
  }

  await ensureDir(teamaiHome);

  if (scope === 'project') {
    await saveLocalConfigForScope(localConfig, scope, projectRoot);
    log.success(`Local config saved to ${teamaiHome}/config.yaml`);

    // Generate .gitignore for project scope to prevent local config from being committed
    const gitignorePath = path.join(teamaiHome, '.gitignore');
    if (!await pathExists(gitignorePath)) {
      const gitignoreContent = [
        '# teamai local config (do not commit)',
        'config.yaml',
        'state.json',
        'token',
        '.update-lock',
        'env',
        'env.sh',
        'sessions/',
        'dashboard/',
        'usage.jsonl',
        'known-skills.json',
        'learnings/',
        'search-index.json',
        'votes/',
        '',
      ].join('\n');
      await writeFile(gitignorePath, gitignoreContent);
      log.debug('Generated .teamai/.gitignore for project scope');
    }
  } else {
    await ensureDir(TEAMAI_HOME);
    await saveLocalConfig(localConfig);
    log.success(`Local config saved to ${TEAMAI_HOME}/config.yaml`);
  }

  // Step 6.5: Invalidate pull cache so next pull does full sync with cleanup
  // This handles re-init scenarios where the user changes their role
  try {
    const state = await loadStateForScope(scope, projectRoot);
    state.lastPullRev = null;
    await saveStateForScope(state, scope, projectRoot);
  } catch {
    // Non-critical: state file may not exist yet on first init
  }

  // Step 7: Inject hooks into AI tools
  const reloadedTeamConfig = await loadTeamConfig(localPath);
  if (reloadedTeamConfig) {
    await injectHooksToAllTools(reloadedTeamConfig.toolPaths, resolveBaseDir(localConfig));
  }

  log.success('teamai initialized successfully!');
  log.info('Skills, rules, env and docs will auto-sync on each session start (via hooks).');
  log.info('Run `teamai status` to check current config.');

  // Close the readline singleton so the process can exit cleanly.
  closePrompt();
}
