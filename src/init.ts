import YAML from 'yaml';
import path from 'node:path';
import readline from 'node:readline';
import { saveLocalConfig, loadTeamConfig } from './config.js';
import { injectHooksToAllTools } from './hooks.js';
import { cloneRepo, configureGitUser } from './utils/git.js';
import { pushRepoDirectly } from './utils/git.js';
import { verifyToken, getCurrentUser, getProject, isRepoEmpty, fileExistsInRepo, createProject, getNamespaceId } from './utils/tgit-api.js';
import { parseRepoInput, type RepoInfo } from './utils/repo-url.js';
import { ensureDir, writeFile, pathExists, expandHome, readFileSafe } from './utils/fs.js';
import { log, spinner } from './utils/logger.js';
import { TEAMAI_HOME, type GlobalOptions, type LocalConfig } from './types.js';

function askQuestion(prompt: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function resolveRepo(info: RepoInfo): Promise<string> {
  const spin = spinner(`Checking repo ${info.owner}/${info.repo}...`).start();

  const project = await getProject(info.projectId);

  if (!project) {
    // Repo does not exist — ask to create
    spin.info(`Repo ${info.owner}/${info.repo} does not exist on TGit`);
    const answer = await askQuestion(`Create repo ${info.owner}/${info.repo}? [Y/n] `);
    if (answer && answer.toLowerCase() !== 'y') {
      log.error('Aborted. Please provide an existing repo or confirm creation.');
      process.exit(1);
    }

    const createSpin = spinner(`Creating repo ${info.owner}/${info.repo}...`).start();
    try {
      const namespaceId = await getNamespaceId(info.owner);
      await createProject(info.repo, namespaceId ?? undefined);
      createSpin.succeed(`Repo ${info.owner}/${info.repo} created`);
    } catch (e) {
      createSpin.fail(`Failed to create repo: ${(e as Error).message}`);
      process.exit(1);
    }
  } else {
    // Repo exists — check if empty
    const empty = await isRepoEmpty(info.projectId);
    if (empty) {
      spin.succeed(`Repo ${info.owner}/${info.repo} exists (empty, ready to use)`);
    } else {
      // Check if repo is already a teamai repo (has teamai.yaml)
      const isTeamaiRepo = await fileExistsInRepo(info.projectId, 'teamai.yaml');
      if (isTeamaiRepo) {
        spin.succeed(`Repo ${info.owner}/${info.repo} is an existing teamai repo`);
      } else {
        spin.warn(`Repo ${info.owner}/${info.repo} exists and is non-empty`);
        const answer = await askQuestion('Continue using this repo? [Y/n] ');
        if (answer && answer.toLowerCase() !== 'y') {
          log.error('Aborted.');
          process.exit(1);
        }
      }
    }
  }

  return info.httpsUrl;
}

export async function init(options: GlobalOptions & { repo?: string }): Promise<void> {
  log.info('Initializing teamai...');

  // Step 1: Verify TGit token
  const spin = spinner('Verifying TGit token...').start();
  let user;
  try {
    user = await verifyToken();
    spin.succeed(`Authenticated as ${user.username} (${user.name})`);
  } catch (e) {
    spin.fail((e as Error).message);
    log.info('Set TGIT_TOKEN via one of these methods:');
    log.info('  1. Shell profile: export TGIT_TOKEN=xxx (in ~/.bashrc or ~/.zshrc)');
    log.info('  2. Env file: echo "TGIT_TOKEN=xxx" > ~/.teamai/env');
    log.info('Get a token from: https://git.woa.com/profile/account');
    process.exit(1);
  }

  // Step 2: Resolve repo
  let repoInput = options.repo ?? '';
  if (!repoInput) {
    repoInput = await askQuestion('Team repo (e.g. yourteam/yourproject): ');
  }
  if (!repoInput) {
    log.error('Repo is required');
    process.exit(1);
  }

  let repoInfo: RepoInfo;
  try {
    repoInfo = parseRepoInput(repoInput);
  } catch (e) {
    log.error((e as Error).message);
    process.exit(1);
  }

  const repoUrl = await resolveRepo(repoInfo);

  // Step 3: Clone or link repo
  const defaultLocalPath = path.join(process.env.HOME ?? '', '.teamai', 'team-repo');
  let localPath = await askQuestion(`Local clone path [${defaultLocalPath}]: `);
  if (!localPath) localPath = defaultLocalPath;
  localPath = expandHome(localPath);

  if (await pathExists(localPath)) {
    log.info(`Repo already exists at ${localPath}, using existing clone`);
  } else {
    const cloneSpin = spinner('Cloning team repo...').start();
    try {
      await cloneRepo(repoUrl, localPath);
      cloneSpin.succeed('Team repo cloned');
    } catch (e) {
      cloneSpin.fail(`Clone failed: ${(e as Error).message}`);
      process.exit(1);
    }
  }

  // Step 3.5: Configure git user for the team repo
  await configureGitUser(localPath, user.username, user.name);

  // Step 4: Load team config
  const teamConfig = await loadTeamConfig(localPath);
  if (!teamConfig) {
    log.warn('teamai.yaml not found in repo. Creating default config...');
    const defaultConfig = YAML.stringify({
      team: 'my-team',
      description: 'Team AI DevKit shared resources',
      repo: repoUrl,
      sharing: {
        skills: { syncTargets: ['claude', 'codex', 'claude-internal', 'cursor', 'codebuddy'] },
        rules: { enforced: [] },
        docs: { localDir: '~/.teamai/docs' },
      },
    });
    await writeFile(path.join(localPath, 'teamai.yaml'), defaultConfig);

    // Create standard directories
    for (const dir of ['members', 'skills', 'rules', 'docs', 'hooks', 'hooks/scripts', 'instincts']) {
      await ensureDir(path.join(localPath, dir));
      // create .gitkeep in empty dirs
      const gitkeep = path.join(localPath, dir, '.gitkeep');
      if (!await pathExists(gitkeep)) {
        await writeFile(gitkeep, '');
      }
    }
  }

  // Step 5: Create member file
  const memberPath = path.join(localPath, 'members', `${user.username}.yaml`);
  const isNewMember = !await pathExists(memberPath);
  if (isNewMember) {
    const memberYaml = YAML.stringify({
      username: user.username,
      displayName: user.name || user.username,
      registeredAt: new Date().toISOString(),
    });
    await writeFile(memberPath, memberYaml);
    log.success(`Registered as team member: ${user.username}`);

    if (!options.dryRun) {
      try {
        await pushRepoDirectly(localPath, `[teamai] Register member: ${user.username}`, [
          'members/',
          'teamai.yaml',
          'skills/.gitkeep',
          'rules/.gitkeep',
          'docs/.gitkeep',
          'hooks/.gitkeep',
          'hooks/scripts/.gitkeep',
          'instincts/.gitkeep',
        ]);
        log.success('Member registration pushed to team repo');
      } catch (e) {
        log.warn(`Push failed (you can push manually later): ${(e as Error).message}`);
      }
    }
  } else {
    log.info(`Member ${user.username} already registered`);
  }

  // Step 5.5: Configure default MR reviewers (only for new members / fresh setup)
  if (isNewMember) {
    const configureReviewers = await askQuestion('\nWould you like to configure default MR reviewers? [y/N] ');
    if (configureReviewers.toLowerCase() === 'y') {
      const reviewerInput = await askQuestion('Reviewers (comma-separated usernames): ');
      const reviewers = reviewerInput
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);

      if (reviewers.length > 0) {
        // Update teamai.yaml with reviewers
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
    repo: { localPath, remote: repoUrl },
    username: user.username,
  };
  await ensureDir(TEAMAI_HOME);
  await saveLocalConfig(localConfig);
  log.success(`Local config saved to ${TEAMAI_HOME}/config.yaml`);

  // Step 7: Inject hooks into AI tools
  const reloadedTeamConfig = await loadTeamConfig(localPath);
  if (reloadedTeamConfig) {
    await injectHooksToAllTools(reloadedTeamConfig.toolPaths);
  }

  log.success('teamai initialized successfully!');
  log.info('Run `teamai pull` to sync team resources, or `teamai status` to check.');
}
