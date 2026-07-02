import path from 'node:path';
import YAML from 'yaml';
import { requireInit, detectProjectConfig } from './config.js';
import { pullRepo } from './utils/git.js';
import { ensureDir, readFileSafe, writeFile, pathExists } from './utils/fs.js';
import { log, spinner } from './utils/logger.js';
import { EnvHandler } from './resources/env.js';
import type { GlobalOptions } from './types.js';

const envHandler = new EnvHandler();

/**
 * Mask an env variable value for display.
 * Shows first 2 chars + "****", or "****" for very short values.
 *
 * @param value  Original value string.
 * @returns      Masked string.
 */
function maskValue(value: string): string {
  if (value.length < 4) return '****';
  return `${value.slice(0, 2)}****`;
}

/**
 * List all team env variables from env.yaml.
 *
 * By default, values are masked. Pass `reveal: true` to show plaintext.
 */
export async function envList(options: GlobalOptions & { reveal?: boolean }): Promise<void> {
  const projectConfig = await detectProjectConfig();
  const localConfig = projectConfig ?? (await requireInit()).localConfig;
  const envYamlPath = path.join(localConfig.repo.localPath, 'env', 'env.yaml');

  if (!await pathExists(envYamlPath)) {
    log.info('No env variables defined (env/env.yaml not found)');
    return;
  }

  const envConfig = await envHandler.parseEnvYaml(envYamlPath);
  if (envConfig.variables.length === 0) {
    log.info('No env variables defined');
    return;
  }

  if (options.reveal) {
    process.stderr.write('[warn] 敏感信息将明文输出，请确认环境无录屏\n');
  }

  console.log('');
  console.log(`Team env variables (${envConfig.variables.length}):`);
  console.log('');
  for (const v of envConfig.variables) {
    const displayValue = options.reveal ? v.value : maskValue(v.value);
    console.log(`  ${v.key}=${displayValue}`);
    if (v.description && options.verbose) {
      log.dim(`    ${v.description}`);
    }
  }
  console.log('');
}

/**
 * Add or update an env variable locally.
 * Changes are deferred — run `teamai push` to sync to team repo.
 */
export async function envAdd(
  key: string,
  value: string,
  options: GlobalOptions & { description?: string },
): Promise<void> {
  const projectConfig = await detectProjectConfig();
  const localConfig = projectConfig ?? (await requireInit()).localConfig;
  const repoPath = localConfig.repo.localPath;
  const envYamlPath = path.join(repoPath, 'env', 'env.yaml');

  // Pull latest
  const pullSpin = spinner('Pulling latest...').start();
  try {
    await pullRepo(repoPath);
    pullSpin.succeed('Up to date');
  } catch (e) {
    pullSpin.warn(`Pull failed: ${(e as Error).message}`);
  }

  // Parse existing env.yaml (or create new)
  const envConfig = await envHandler.parseEnvYaml(envYamlPath);

  // Check if key already exists
  const existingIdx = envConfig.variables.findIndex(v => v.key === key);
  const isUpdate = existingIdx !== -1;

  if (isUpdate) {
    envConfig.variables[existingIdx].value = value;
    if (options.description) {
      envConfig.variables[existingIdx].description = options.description;
    }
  } else {
    const newVar: { key: string; value: string; description?: string } = { key, value };
    if (options.description) {
      newVar.description = options.description;
    }
    envConfig.variables.push(newVar);
  }

  if (options.dryRun) {
    log.info(`[dry-run] Would ${isUpdate ? 'update' : 'add'} env variable: ${key}=${value}`);
    return;
  }

  // Write updated env.yaml
  await ensureDir(path.join(repoPath, 'env'));
  await envHandler.writeEnvYaml(envYamlPath, envConfig);

  const action = isUpdate ? 'Updated' : 'Added';
  log.success(`${action} env variable: ${key}=${value}`);
  log.info('Run `teamai push` to sync to team repo.');
}

/**
 * Remove an env variable locally.
 * Changes are deferred — run `teamai push` to sync to team repo.
 */
export async function envRemove(key: string, options: GlobalOptions): Promise<void> {
  const projectConfig = await detectProjectConfig();
  const localConfig = projectConfig ?? (await requireInit()).localConfig;
  const repoPath = localConfig.repo.localPath;
  const envYamlPath = path.join(repoPath, 'env', 'env.yaml');

  // Pull latest
  const pullSpin = spinner('Pulling latest...').start();
  try {
    await pullRepo(repoPath);
    pullSpin.succeed('Up to date');
  } catch (e) {
    pullSpin.warn(`Pull failed: ${(e as Error).message}`);
  }

  if (!await pathExists(envYamlPath)) {
    log.error('No env variables defined (env/env.yaml not found)');
    return;
  }

  const envConfig = await envHandler.parseEnvYaml(envYamlPath);
  const idx = envConfig.variables.findIndex(v => v.key === key);

  if (idx === -1) {
    log.error(`Env variable "${key}" not found`);
    return;
  }

  if (options.dryRun) {
    log.info(`[dry-run] Would remove env variable: ${key}`);
    return;
  }

  envConfig.variables.splice(idx, 1);
  await envHandler.writeEnvYaml(envYamlPath, envConfig);

  log.success(`Removed env variable: ${key}`);
  log.info('Run `teamai push` to sync to team repo.');
}
