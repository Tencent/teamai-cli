import YAML from 'yaml';
import path from 'node:path';
import readline from 'node:readline';
import { saveLocalConfig, loadTeamConfig } from './config.js';
import { injectHooksToAllTools } from './hooks.js';
import { configureGitUser, initRepo } from './utils/git.js';
import { pushRepoDirectly } from './utils/git.js';
import { ensureGfInstalled, ensureAuthenticated, gfRepoClone, gfCreateRepo, RepoNotFoundError } from './utils/gf-cli.js';
import { parseRepoInput } from './utils/repo-url.js';
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

export async function init(options: GlobalOptions & { repo?: string }): Promise<void> {
  log.info('Initializing teamai...');

  // Step 1a: Ensure gf CLI is installed
  await ensureGfInstalled();

  // Step 1b: Authenticate via gf
  const spin = spinner('Checking authentication...').start();
  let username: string;
  try {
    const { gfIsAuthenticated, gfAuthWhoami } = await import('./utils/gf-cli.js');
    if (gfIsAuthenticated()) {
      username = gfAuthWhoami()!;
      spin.succeed(`Authenticated as ${username}`);
    } else {
      spin.info('Not logged in — starting authentication');
      username = ensureAuthenticated();
      log.success(`Authenticated as ${username}`);
    }
  } catch (e) {
    spin.fail(`Authentication failed: ${(e as Error).message}`);
    process.exit(1);
  }

  // Step 2: Get repo input
  let repoInput = options.repo ?? '';
  if (!repoInput) {
    repoInput = await askQuestion('Team repo (e.g. yourteam/yourproject): ');
  }
  if (!repoInput) {
    log.error('Repo is required');
    process.exit(1);
  }

  let repoInfo;
  try {
    repoInfo = parseRepoInput(repoInput);
  } catch (e) {
    log.error((e as Error).message);
    process.exit(1);
  }

  // Step 3: Clone or link repo
  const defaultLocalPath = path.join(process.env.HOME ?? '', '.teamai', 'team-repo');
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
      // Use gf repo clone — embeds OAuth token in remote URL for automatic auth
      gfRepoClone(`${repoInfo.owner}/${repoInfo.repo}`, localPath);
      cloneSpin.succeed('Team repo cloned');
    } catch (e) {
      if (e instanceof RepoNotFoundError) {
        cloneSpin.info(`Repo ${repoInfo.owner}/${repoInfo.repo} does not exist on TGit`);
        const answer = await askQuestion(`Create repo ${repoInfo.owner}/${repoInfo.repo}? [Y/n] `);
        if (answer && answer.toLowerCase() !== 'y') {
          log.error('Aborted. Please provide an existing repo or confirm creation.');
          process.exit(1);
        }
        const createSpin = spinner(`Creating repo ${repoInfo.owner}/${repoInfo.repo}...`).start();
        try {
          await gfCreateRepo(repoInfo.owner, repoInfo.repo);
          createSpin.succeed(`Repo ${repoInfo.owner}/${repoInfo.repo} created`);
        } catch (ce) {
          createSpin.fail(`Failed to create repo: ${(ce as Error).message}`);
          process.exit(1);
        }
        // Retry clone after creation
        const retryCloneSpin = spinner('Cloning newly created repo...').start();
        try {
          gfRepoClone(`${repoInfo.owner}/${repoInfo.repo}`, localPath);
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
  await configureGitUser(localPath, username, username);

  // Step 4: Load team config
  const teamConfig = await loadTeamConfig(localPath);
  if (!teamConfig) {
    log.warn('teamai.yaml not found in repo. Creating default config...');
    const defaultConfig = YAML.stringify({
      team: 'my-team',
      description: 'TeamAI shared resources',
      repo: repoInfo.httpsUrl,
      sharing: {
        rules: { enforced: [] },
        docs: { localDir: '~/.teamai/docs' },
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

  // Step 5.5: Configure default MR reviewers (only for fresh setup with no reviewers yet)
  const currentConfig = await loadTeamConfig(localPath);
  const hasReviewers = currentConfig?.reviewers && currentConfig.reviewers.length > 0;
  if (isNewMember && !hasReviewers) {
    const configureReviewers = await askQuestion('\nWould you like to configure default MR reviewers? [y/N] ');
    if (configureReviewers.toLowerCase() === 'y') {
      const reviewerInput = await askQuestion('Reviewers (comma-separated usernames): ');
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
    updatePolicy: 'auto',
  };
  await ensureDir(TEAMAI_HOME);
  await saveLocalConfig(localConfig);
  log.success(`Local config saved to ${TEAMAI_HOME}/config.yaml`);

  // Step 7: Inject hooks into AI tools
  const reloadedTeamConfig = await loadTeamConfig(localPath);
  if (reloadedTeamConfig) {
    await injectHooksToAllTools(reloadedTeamConfig.toolPaths);

    // Deploy CLI built-in skills (e.g. teamai-contribute)
    try {
      const { deployBuiltinSkills } = await import('./builtin-skills.js');
      await deployBuiltinSkills(reloadedTeamConfig);
    } catch {
      // Non-critical — skills will be deployed on next pull
    }
  }

  log.success('teamai initialized successfully!');
  log.info('Skills, rules, env and docs will auto-sync on each session start (via hooks).');
  log.info('Run `teamai status` to check current config.');
}
