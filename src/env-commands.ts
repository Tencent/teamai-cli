import { requireInit, detectProjectConfig } from './config.js';
import { pullRepo } from './utils/git.js';
import { pathExists } from './utils/fs.js';
import { log, spinner } from './utils/logger.js';
import { EnvHandler, maskEnvValue, ENV_KEY_RE, envEntryReader, unknownEnvVariableKeys, type EnvYaml } from './resources/env.js';
import { resolveSecretDeclarations, secretState } from './resources/secrets.js';
import { describeEntryFailure, describeOrigin, entryFileAbsolutePath, entryFilePath, entryNamespaceFromFlags, resolveEntriesFor } from './namespaced-entries.js';
import type { GlobalOptions, LocalConfig } from './types.js';
import { isSelfMode } from './types.js';

const envHandler = new EnvHandler();

/**
 * List the team env variables this directory receives: env/env.yaml plus the
 * active env/<ns>/env.yaml files, each with the namespace it comes from. Then
 * the secrets it declares (env/secrets.yaml and env/<ns>/secrets.yaml), each
 * with where its value comes from, never the value.
 *
 * By default, variable values are masked. Pass `reveal: true` to show plaintext.
 * A file that cannot be used fails its own list only.
 */
export async function envList(options: GlobalOptions & { reveal?: boolean }): Promise<void> {
  const projectConfig = await detectProjectConfig();
  const localConfig = projectConfig ?? (await requireInit()).localConfig;

  const resolution = await resolveEntriesFor(envEntryReader, localConfig);
  const declarations = await resolveSecretDeclarations(localConfig);
  const variables = resolution.kind === 'resolved' ? resolution.entries : [];
  const secrets = declarations.kind === 'resolved' ? declarations.entries : [];

  if (resolution.kind === 'failed') {
    log.error(describeEntryFailure(resolution.failure));
    process.exitCode = 1;
  }
  if (declarations.kind === 'failed') {
    log.error(describeEntryFailure(declarations.failure));
    process.exitCode = 1;
  }
  if (variables.length === 0 && secrets.length === 0) {
    if (resolution.kind !== 'failed' && declarations.kind !== 'failed') log.info('No env variables defined');
    return;
  }

  if (options.reveal && variables.length > 0) {
    process.stderr.write('[warn] Env values will be shown in plaintext\n');
  }

  console.log('');
  if (variables.length > 0) {
    console.log(`Team env variables (${variables.length}):`);
    console.log('');
    for (const v of variables) {
      const displayValue = options.reveal ? v.entry.value : maskEnvValue(v.entry.value);
      console.log(`  ${v.name}=${displayValue}  (${describeOrigin(v)})`);
      if (v.entry.description && options.verbose) {
        log.dim(`    ${v.entry.description}`);
      }
    }
    console.log('');
  }
  if (secrets.length > 0) {
    console.log(`Team secrets (${secrets.length}):`);
    console.log('');
    for (const s of secrets) {
      console.log(`  ${s.name}  ${secretState(s.name)}  (${describeOrigin(s)})`);
      if (options.verbose) {
        if (s.entry.description) log.dim(`    ${s.entry.description}`);
        if (s.entry.url) log.dim(`    ${s.entry.url}`);
      }
    }
    console.log('');
  }
}

/**
 * Add or update an env variable locally.
 * Changes are deferred — run `teamai push` to sync to team repo.
 */
export async function envAdd(
  key: string,
  value: string,
  options: GlobalOptions & { description?: string; role?: string; project?: string },
): Promise<void> {
  // env.sh is generated as `export <key>=...` and sourced by every member, so a
  // key that is not a shell identifier either breaks that line or runs as code.
  // `generateEnvFile` drops such keys, which would make this command report
  // success for a variable that never reaches anyone's shell — reject it here,
  // where the user still sees what they typed.
  if (!ENV_KEY_RE.test(key)) {
    log.error(
      `Invalid env variable name "${key}": use letters, digits and underscores, starting with a letter or underscore.`,
    );
    return;
  }

  const projectConfig = await detectProjectConfig();
  const localConfig = projectConfig ?? (await requireInit()).localConfig;
  const repoPath = localConfig.repo.localPath;

  if (!await refreshTeamRepo(localConfig, options.project)) return;

  const target = await envFileFromFlags(repoPath, options);
  if (!target) return;
  const { envYamlPath, relativePath, where } = target;

  // The target env.yaml, or a new one when it does not exist.
  const envConfig = await readEnvFileForEdit(envYamlPath);
  if (!envConfig) return;

  // Check if key already exists
  const existingIdx = envConfig.variables.findIndex(v => v.key === key);
  const isUpdate = existingIdx !== -1;

  if (isUpdate) {
    envConfig.variables[existingIdx].value = value;
    if (options.description) {
      envConfig.variables[existingIdx].description = options.description;
    }
    // The update keeps an unknown key, so the variable stays undelivered.
    const unknown = unknownEnvVariableKeys(envConfig.variables[existingIdx]);
    if (unknown.length > 0) {
      const one = unknown.length === 1;
      log.warn(
        `${relativePath}: variable "${key}" has unknown ${one ? 'key' : 'keys'} `
          + `${unknown.map((k) => `\`${k}:\``).join(', ')}, so pull does not deliver it. `
          + `Correct the ${one ? 'key' : 'keys'} or remove ${one ? 'it' : 'them'} in ${relativePath}.`,
      );
    }
  } else {
    const newVar: { key: string; value: string; description?: string } = { key, value };
    if (options.description) {
      newVar.description = options.description;
    }
    envConfig.variables.push(newVar);
  }

  if (options.dryRun) {
    log.info(`[dry-run] Would ${isUpdate ? 'update' : 'add'} env variable${where}: ${key}=${value}`);
    return;
  }

  // Write updated env.yaml
  await envHandler.writeEnvYaml(envYamlPath, envConfig);

  const action = isUpdate ? 'Updated' : 'Added';
  log.success(`${action} env variable${where}: ${key}=${value}`);
  log.info('Run `teamai push` to sync to team repo.');
}

/**
 * Remove an env variable locally.
 * Changes are deferred — run `teamai push` to sync to team repo.
 */
export async function envRemove(key: string, options: GlobalOptions & { role?: string; project?: string }): Promise<void> {
  const projectConfig = await detectProjectConfig();
  const localConfig = projectConfig ?? (await requireInit()).localConfig;
  const repoPath = localConfig.repo.localPath;

  if (!await refreshTeamRepo(localConfig, options.project)) return;

  const target = await envFileFromFlags(repoPath, options);
  if (!target) return;
  const { envYamlPath, relativePath, where } = target;

  if (!await pathExists(envYamlPath)) {
    log.error(`No env variables defined (${relativePath} not found)`);
    return;
  }

  const envConfig = await readEnvFileForEdit(envYamlPath);
  if (!envConfig) return;
  const idx = envConfig.variables.findIndex(v => v.key === key);

  if (idx === -1) {
    log.error(`Env variable "${key}" not found${where}`);
    return;
  }

  if (options.dryRun) {
    log.info(`[dry-run] Would remove env variable${where}: ${key}`);
    return;
  }

  envConfig.variables.splice(idx, 1);
  await envHandler.writeEnvYaml(envYamlPath, envConfig);

  log.success(`Removed env variable${where}: ${key}`);
  log.info('Run `teamai push` to sync to team repo.');
}

/**
 * Pull the team repo before an edit. A failure only warns, except with
 * `--project`: that resolves through manifest/projects.yaml, and a stale copy
 * may name a namespace the project no longer uses, whose file push would then
 * publish. Returns false when the edit must not go ahead.
 */
async function refreshTeamRepo(localConfig: LocalConfig, project: string | undefined): Promise<boolean> {
  if (isSelfMode(localConfig)) return true;
  const pullSpin = spinner('Pulling latest...').start();
  try {
    await pullRepo(localConfig.repo.localPath);
    pullSpin.succeed('Up to date');
    return true;
  } catch (e) {
    if (project === undefined) {
      pullSpin.warn(`Pull failed: ${(e as Error).message}`);
      return true;
    }
    pullSpin.fail(`Pull failed: ${(e as Error).message}`);
    log.error(
      `The team repo could not be refreshed (${(e as Error).message}), so the env namespace of project "${project}" `
      + 'may be out of date. Nothing was changed. Fix the pull (run `teamai pull` to see why) and retry, or pass --role <ns>.',
    );
    process.exitCode = 1;
    return false;
  }
}

/**
 * The env file to edit, or null when it does not parse: writing back what
 * could be read would replace every variable it has.
 */
async function readEnvFileForEdit(envYamlPath: string): Promise<EnvYaml | null> {
  const read = await envHandler.readEnvYaml(envYamlPath);
  if (read.ok) return { variables: read.variables };
  log.error(`${read.reason}. Nothing was changed. Fix the file in the team repo, then retry.`);
  process.exitCode = 1;
  return null;
}

/**
 * The env file `--role <ns>` / `--project <id>` name, or env/env.yaml without
 * either. Reports the reason and returns null when the flags name none.
 */
async function envFileFromFlags(
  repoPath: string,
  flags: { role?: string; project?: string },
): Promise<{ envYamlPath: string; relativePath: string; where: string } | null> {
  const target = await entryNamespaceFromFlags(repoPath, 'env', flags);
  if (!target.ok) {
    log.error(target.message);
    process.exitCode = 1;
    return null;
  }
  const relativePath = entryFilePath('env', target.namespace);
  return {
    envYamlPath: entryFileAbsolutePath(repoPath, 'env', target.namespace),
    relativePath,
    // Messages name the file only for a namespace; the root is the default.
    where: target.namespace === null ? '' : ` in ${relativePath}`,
  };
}
