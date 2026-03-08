import path from 'node:path';
import { loadLocalConfig, loadTeamConfig } from './config.js';
import { pathExists, readFileSafe } from './utils/fs.js';
import { isGfInstalled, gfIsAuthenticated } from './utils/gf-cli.js';
import { log } from './utils/logger.js';
import type { GlobalOptions } from './types.js';
import { TeamaiConfigSchema, TEAMAI_ENV_START, type TeamaiConfig } from './types.js';

interface Check {
  name: string;
  check: () => Promise<boolean>;
  fix?: string;
}

function buildHookChecks(toolPaths: TeamaiConfig['toolPaths']): Check[] {
  const checks: Check[] = [];
  for (const [tool, paths] of Object.entries(toolPaths)) {
    if (!paths.settings) continue;
    checks.push({
      name: `teamai hook in ${tool} settings`,
      check: async () => {
        const settingsPath = path.join(process.env.HOME ?? '', paths.settings!);
        if (!await pathExists(settingsPath)) return false;
        const content = await readFileSafe(settingsPath);
        return content?.includes('[teamai]') ?? false;
      },
      fix: 'Run `teamai init` to inject hooks',
    });
  }
  return checks;
}

export async function doctor(options: GlobalOptions): Promise<void> {
  log.info('Running diagnostics...\n');
  const localConfig = await loadLocalConfig();

  // Try to load team config for dynamic tool paths
  let teamConfig: TeamaiConfig | null = null;
  if (localConfig) {
    teamConfig = await loadTeamConfig(localConfig.repo.localPath);
  }
  // Fall back to schema defaults if team config is unavailable
  const toolPaths = teamConfig?.toolPaths ?? TeamaiConfigSchema.shape.toolPaths.parse(undefined);

  const checks: Check[] = [
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
    {
      name: 'Local config exists (~/.teamai/config.yaml)',
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
    ...buildHookChecks(toolPaths),
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
  ];

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
