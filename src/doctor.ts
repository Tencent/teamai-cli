import path from 'node:path';
import { detectProjectConfig, loadLocalConfig, loadTeamConfig } from './config.js';
import { pathExists, readFileSafe } from './utils/fs.js';
import { log } from './utils/logger.js';
import type { GlobalOptions, Scope } from './types.js';
import {
  TeamaiConfigSchema,
  TEAMAI_ENV_START,
  resolveBaseDir,
  type TeamaiConfig,
} from './types.js';
import { TEAMAI_HOOK_SUBCOMMANDS } from './hooks.js';

interface Check {
  name: string;
  check: () => Promise<boolean>;
  fix?: string;
}

/**
 * Build hook checks only for tools whose settings parent directory already
 * exists (i.e. the tool is installed). Tools that are not installed are skipped.
 */
async function buildHookChecks(toolPaths: TeamaiConfig['toolPaths'], baseDir: string): Promise<Check[]> {
  const checks: Check[] = [];
  for (const [tool, paths] of Object.entries(toolPaths)) {
    if (!paths.settings) continue;
    const settingsPath = path.join(baseDir, paths.settings);
    const parentDir = path.dirname(settingsPath);
    if (!await pathExists(parentDir)) continue;
    checks.push({
      name: `teamai hooks in ${tool} settings`,
      check: async () => {
        if (!await pathExists(settingsPath)) return false;
        const content = await readFileSafe(settingsPath);
        if (!content) return false;

        const missing = TEAMAI_HOOK_SUBCOMMANDS.filter(
          (sub) => !content.includes(`teamai ${sub}`),
        );
        return missing.length === 0;
      },
      fix: 'Run `teamai hooks inject` to inject/update hooks',
    });
  }
  return checks;
}

export async function doctor(options: GlobalOptions): Promise<void> {
  log.info('Running diagnostics...\n');
  const projectConfig = await detectProjectConfig();
  const localConfig = projectConfig ?? (await loadLocalConfig());
  const scope: Scope = localConfig?.scope ?? 'user';
  const configPathLabel = projectConfig
    ? `${projectConfig.projectRoot}/.teamai/config.yaml`
    : '~/.teamai/config.yaml';

  console.log(`  Scope: ${scope}${scope === 'project' && localConfig?.projectRoot ? ` (${localConfig.projectRoot})` : ''}\n`);

  // Try to load team config for dynamic tool paths and provider
  let teamConfig: TeamaiConfig | null = null;
  if (localConfig) {
    teamConfig = await loadTeamConfig(localConfig.repo.localPath);
  }
  // Fall back to schema defaults if team config is unavailable
  const toolPaths = teamConfig?.toolPaths ?? TeamaiConfigSchema.shape.toolPaths.parse(undefined);
  const providerName = teamConfig?.provider ?? 'tgit';
  const baseDir = localConfig ? resolveBaseDir(localConfig) : (process.env.HOME ?? '');

  const checks: Check[] = [];

  // Provider-specific checks: gf CLI only needed for TGit, gh CLI for GitHub
  if (providerName === 'tgit') {
    // Dynamic import to avoid loading gf-cli code when not needed
    const { isGfInstalled, gfIsAuthenticated } = await import('./providers/tgit/index.js');
    checks.push(
      {
        name: 'gf CLI is installed',
        check: async () => isGfInstalled(),
        fix: 'Run `teamai init` to install gf CLI automatically',
      },
      {
        name: 'gf CLI is authenticated',
        check: async () => gfIsAuthenticated(),
        fix: 'Run `teamai init` to authenticate via gf auth login',
      },
    );
  } else if (providerName === 'github') {
    // Dynamic import to avoid loading gh-cli code when not needed
    const { isGhInstalled, ghIsAuthenticated } = await import('./providers/github/index.js');
    checks.push(
      {
        name: 'gh CLI is installed',
        check: async () => isGhInstalled(),
        fix: 'Install from https://cli.github.com/ or run `brew install gh`',
      },
      {
        name: 'gh CLI is authenticated',
        check: async () => ghIsAuthenticated(),
        fix: 'Run `gh auth login` to authenticate',
      },
    );
  }

  checks.push(
    {
      name: `Local config exists (${configPathLabel})`,
      check: async () => localConfig !== null,
      fix: 'Run `teamai init` to initialize',
    },
    {
      name: 'Team repo exists locally',
      check: async () => {
        if (!localConfig) return false;
        return pathExists(localConfig.repo.localPath);
      },
      fix: 'Run `teamai init` to clone the team repo',
    },
    {
      name: 'Team config (teamai.yaml) is valid',
      check: async () => {
        if (!localConfig) return false;
        const config = await loadTeamConfig(localConfig.repo.localPath);
        return config !== null;
      },
      fix: 'Check teamai.yaml in team repo for syntax errors',
    },
    ...await buildHookChecks(toolPaths, baseDir),
    {
      name: 'Env variables injected in shell profile',
      check: async () => {
        const home = process.env.HOME ?? '';

        // Check if env.sh exists
        const envShPath = path.join(home, '.teamai', 'env.sh');
        if (!await pathExists(envShPath)) return false;

        // Check for source line in shell profile
        const shell = process.env.SHELL ?? '';
        const profilePath = shell.includes('zsh')
          ? path.join(home, '.zshrc')
          : path.join(home, '.bashrc');
        if (!await pathExists(profilePath)) return false;
        const content = await readFileSafe(profilePath);
        return content?.includes(TEAMAI_ENV_START) ?? false;
      },
      fix: 'Run `teamai pull` to inject env variables into shell profile',
    },
  );

  let allPassed = true;
  for (const { name, check, fix } of checks) {
    const ok = await check();
    if (ok) {
      console.log(`  ✔ ${name}`);
    } else {
      console.log(`  ✖ ${name}`);
      if (fix) console.log(`    → ${fix}`);
      allPassed = false;
    }
  }

  console.log('');
  if (allPassed) {
    log.success('All checks passed!');
  } else {
    log.warn('Some checks failed. See suggestions above.');
  }
}
