import { requireInit, detectProjectConfig, NotInitializedError } from './config.js';
import { pullRepo } from './utils/git.js';
import { pathExists } from './utils/fs.js';
import { log, spinner } from './utils/logger.js';
import { EnvHandler, maskEnvValue, ENV_KEY_RE, envEntryReader, unknownEnvVariableKeys, type EnvYaml } from './resources/env.js';
import {
  SECRETS_LAYOUT, declaredSecretKeys, readSecretsForEdit, resolveSecretDeclarations, resolveSecretValues, secretState,
  unknownSecretDeclarationKeys, writeSecretsFile,
} from './resources/secrets.js';
import { getMachineSecretsPath, getTeamSecretsPath, readSecretStore, writeSecretStore, type StoredSecret } from './secret-store.js';
import { askSecret, isInteractive, readStdin } from './utils/prompt.js';
import { describeEnvAdvisory, envAdvisories } from './env-advisories.js';
import {
  describeEntryFailure, describeOrigin, entryFileAbsolutePath, entryFilePath, entryNamespaceFromFlags, resolveEntriesFor,
  type EntryLayout, type EntryType,
} from './namespaced-entries.js';
import type { GlobalOptions, LocalConfig } from './types.js';
import { isSelfMode } from './types.js';

const envHandler = new EnvHandler();

/**
 * List the team env variables this directory receives: env/env.yaml plus the
 * active env/<ns>/env.yaml files, each with the namespace it comes from. Then
 * the secrets it declares (env/secrets.yaml and env/<ns>/secrets.yaml), each
 * with where its value comes from, never the value. A key declared as a
 * secret is listed only as one: its env.yaml value is not delivered.
 *
 * By default, variable values are masked. Pass `reveal: true` to show plaintext.
 * A file that cannot be used fails its own list only.
 */
export async function envList(options: GlobalOptions & { reveal?: boolean }): Promise<void> {
  const projectConfig = await detectProjectConfig();
  const localConfig = projectConfig ?? (await requireInit()).localConfig;

  const resolution = await resolveEntriesFor(envEntryReader, localConfig);
  const declarations = await resolveSecretDeclarations(localConfig);
  const received = resolution.kind === 'resolved' ? resolution.entries : [];
  const secrets = declarations.kind === 'resolved' ? declarations.entries : [];
  const secretKeys = new Set(secrets.map((s) => s.name));
  const variables = received.filter((v) => !secretKeys.has(v.name));

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
  const values = await resolveSecretValues(localConfig, secretKeys, received);
  if (values.kind === 'store-unreadable') {
    log.error(`${values.reason} Every team secret is missing until it is fixed.`);
    process.exitCode = 1;
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
      console.log(`  ${s.name}  ${secretState(values, s.name)}  (${describeOrigin(s)})`);
      if (options.verbose) {
        if (s.entry.description) log.dim(`    ${s.entry.description}`);
        if (s.entry.url) log.dim(`    ${s.entry.url}`);
      }
    }
    console.log('');
    const missing = (await envAdvisories(localConfig, null)).filter((advisory) => advisory.kind === 'missing-secret');
    for (const advisory of missing) log.warn(describeEnvAdvisory(advisory));
  }
}

/**
 * Keep this member's value for a secret the scope declares, for this team
 * repo, on this machine (#875); with `global`, for every team on the machine.
 * Without `global`, also for an env variable the scope receives, which then
 * replaces the team's value for this team (a machine value is for secrets only).
 * The value comes from a hidden prompt, from piped stdin, or is a reference to
 * another variable read each time it is used; never from an argument, so it
 * stays out of shell history.
 */
export async function envSet(
  key: string,
  options: GlobalOptions & { stdin?: boolean; fromEnv?: string; global?: boolean },
): Promise<void> {
  if (!ENV_KEY_RE.test(key)) return fail(invalidKeyMessage(key));
  if (options.stdin && options.fromEnv !== undefined) return fail('Pass either --stdin or --from-env, not both. Nothing was changed.');
  if (options.fromEnv !== undefined && !ENV_KEY_RE.test(options.fromEnv)) {
    return fail(`Invalid --from-env variable name "${options.fromEnv}": use letters, digits and underscores, starting with a letter or underscore.`);
  }

  const localConfig = await scopeHere(options.global);
  let isVariable = false;
  if (localConfig) {
    const declarations = await resolveSecretDeclarations(localConfig);
    if (declarations.kind === 'failed') {
      log.error(describeEntryFailure(declarations.failure));
      return fail(`Cannot tell whether ${key} is a secret this team declares. Nothing was changed.`);
    }
    const declared = declaredSecretKeys(declarations);
    if (!declared.has(key)) {
      if (options.global) {
        const list = declared.size > 0 ? ` It declares: ${[...declared].sort().join(', ')}.` : ' It declares none.';
        return fail(
          `${key} is not a secret this directory's team declares, so it was not set.${list} `
          + 'If the team declared it recently, run `teamai pull` first.',
        );
      }
      // #875: without --global, a member may also override a variable the scope receives, for this team.
      const env = await resolveEntriesFor(envEntryReader, localConfig);
      if (env.kind === 'failed') {
        log.error(describeEntryFailure(env.failure));
        return fail(`Cannot tell whether ${key} is an env variable this team sets. Nothing was changed.`);
      }
      const variables = new Set(env.entries.map((variable) => variable.name).filter((name) => !declared.has(name)));
      if (!variables.has(key)) {
        const named = (keys: ReadonlySet<string>): string => (keys.size > 0 ? [...keys].sort().join(', ') : 'none');
        return fail(
          `${key} is neither a secret nor an env variable this directory's team declares, so it was not set. `
          + `Its secrets: ${named(declared)}. Its variables: ${named(variables)}. `
          + 'If the team added it recently, run `teamai pull` first.',
        );
      }
      isVariable = true;
    }
  }

  const { file, target } = valuesFile(localConfig, options.global);
  const store = await readSecretStore(file);
  if (!store.ok) return fail(`${store.reason} Nothing was changed.`);

  let entry: StoredSecret;
  try {
    entry = await secretInput(key, options);
  } catch (e) {
    return fail(`${(e as Error).message} Nothing was changed.`);
  }

  if (options.dryRun) {
    log.info(`[dry-run] Would set ${key} ${target} in ${file}`);
    return;
  }
  await writeSecretStore(file, { ...store.values, [key]: entry });
  if ('env' in entry) {
    log.success(`${key} now reads ${entry.env} from your environment ${target} (${file}).`);
    if (!process.env[entry.env]) log.warn(`${entry.env} is not set in this shell; ${key} has no value until it is.`);
  } else {
    log.success(`Set ${key} ${target} (${file}).`);
  }
  if (localConfig) {
    log.info(isVariable ? 'Run `teamai pull` to update MCP servers and env.sh.' : 'Run `teamai pull` to update MCP servers.');
  } else {
    log.info(`No teamai scope here, so no team declares ${key} yet. The value applies to every team on this machine that declares it.`);
  }
}

/** Remove this member's value for a secret or variable, for this team repo or, with `global`, for the machine. */
export async function envUnset(key: string, options: GlobalOptions & { global?: boolean }): Promise<void> {
  if (!ENV_KEY_RE.test(key)) return fail(invalidKeyMessage(key));
  const localConfig = await scopeHere(options.global);

  const { file } = valuesFile(localConfig, options.global);
  const owner = options.global ? 'machine' : 'team';
  const store = await readSecretStore(file);
  if (!store.ok) return fail(`${store.reason} Nothing was changed.`);
  if (!Object.hasOwn(store.values, key)) {
    log.info(`${key} has no value set for this ${owner}. Nothing was changed.`);
    return;
  }
  if (options.dryRun) {
    log.info(`[dry-run] Would remove the ${owner} value of ${key} from ${file}`);
    return;
  }
  const rest = { ...store.values };
  delete rest[key];
  await writeSecretStore(file, rest);
  log.success(`Removed the ${owner} value of ${key} (${file}).`);
  if (!localConfig) return;
  // env.sh exports a member's value for a variable (#875), not for a secret.
  const secret = options.global || declaredSecretKeys(await resolveSecretDeclarations(localConfig))?.has(key);
  log.info(secret ? 'Run `teamai pull` to update MCP servers.' : 'Run `teamai pull` to update MCP servers and env.sh.');
}

/**
 * This directory's scope. Outside any scope `env set --global` still has
 * somewhere to write, so `global` turns "not initialized" into null.
 */
async function scopeHere(global: boolean | undefined): Promise<LocalConfig | null> {
  const projectConfig = await detectProjectConfig();
  if (projectConfig) return projectConfig;
  try {
    return (await requireInit()).localConfig;
  } catch (e) {
    if (global && e instanceof NotInitializedError) return null;
    throw e;
  }
}

/** The store `env set` / `env unset` write, and how their messages name it. Without a scope, only the machine's. */
function valuesFile(localConfig: LocalConfig | null, global: boolean | undefined): { file: string; target: string } {
  return localConfig && !global
    ? { file: getTeamSecretsPath(localConfig), target: 'for this team' }
    : { file: getMachineSecretsPath(), target: 'for every team on this machine' };
}

/** The entry `env set` stores: a `--from-env` reference, piped stdin, or the hidden prompt. */
async function secretInput(key: string, options: { stdin?: boolean; fromEnv?: string }): Promise<StoredSecret> {
  if (options.fromEnv !== undefined) return { env: options.fromEnv };
  let value: string;
  if (options.stdin) {
    if (process.stdin.isTTY) throw new Error('--stdin expects piped stdin; run without it to be prompted.');
    process.stdin.setEncoding('utf8');
    value = await readStdin();
    if (!value) throw new Error('No value was provided on stdin.');
    return { value };
  }
  try {
    value = await askSecret(`Value for ${key}: `);
  } catch (e) {
    if (!isInteractive()) {
      throw new Error(`Cannot prompt for ${key} without a terminal. Pipe the value with --stdin, or pass --from-env <VAR>.`);
    }
    throw e;
  }
  if (!value) throw new Error('No value was entered.');
  return { value };
}

function invalidKeyMessage(key: string): string {
  return `Invalid env variable name "${key}": use letters, digits and underscores, starting with a letter or underscore.`;
}

function fail(message: string): void {
  log.error(message);
  process.exitCode = 1;
}

/**
 * Add or update an env variable locally, or with `secret` declare a secret:
 * the key, what it is for and where to get a value, never a value.
 * Changes are deferred — run `teamai push` to sync to team repo.
 */
export async function envAdd(
  key: string,
  value: string | undefined,
  options: GlobalOptions & { description?: string; role?: string; project?: string; secret?: boolean; url?: string },
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
  // Every member supplies a secret's value on their own machine; the value
  // passed here is neither stored nor printed.
  if (options.secret && value !== undefined) {
    log.error(
      `A secret has no value in the team repo, so --secret takes none. Nothing was changed. `
        + `Run \`teamai env add ${key} --secret\` without the value.`,
    );
    process.exitCode = 1;
    return;
  }
  if (!options.secret && options.url !== undefined) {
    log.error('--url says where a member gets a secret\'s value, so it needs --secret. Nothing was changed.');
    process.exitCode = 1;
    return;
  }
  if (!options.secret && value === undefined) {
    log.error(
      `No value for "${key}". Run \`teamai env add ${key} <value>\`, `
        + `or \`teamai env add ${key} --secret\` to declare a secret each member sets.`,
    );
    process.exitCode = 1;
    return;
  }

  const projectConfig = await detectProjectConfig();
  const localConfig = projectConfig ?? (await requireInit()).localConfig;
  const repoPath = localConfig.repo.localPath;

  if (!await refreshTeamRepo(localConfig, options.project)) return;
  if (value === undefined) {
    await declareSecret(repoPath, key, options);
    return;
  }

  const target = await envFileFromFlags(repoPath, options);
  if (!target) return;
  const { filePath: envYamlPath, relativePath, where } = target;

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
 * Declare a secret in env/secrets.yaml or env/<ns>/secrets.yaml, or update
 * the description and url of one already declared there.
 */
async function declareSecret(
  repoPath: string,
  key: string,
  options: GlobalOptions & { description?: string; role?: string; project?: string; url?: string },
): Promise<void> {
  const target = await envFileFromFlags(repoPath, options, SECRETS_LAYOUT);
  if (!target) return;
  const secrets = await readSecretsFileForEdit(target);
  if (!secrets) return;

  const index = secrets.findIndex((secret) => secret.key === key);
  const isUpdate = index !== -1;
  const declaration = {
    ...(isUpdate ? secrets[index] : {}),
    key,
    ...(options.description !== undefined ? { description: options.description } : {}),
    ...(options.url !== undefined ? { url: options.url } : {}),
  };
  if (isUpdate) secrets[index] = declaration;
  else secrets.push(declaration);
  // The update keeps an unknown key, so the secret stays undeclared.
  const unknown = unknownSecretDeclarationKeys(declaration);
  if (unknown.length > 0) {
    const one = unknown.length === 1;
    log.warn(
      `${target.relativePath}: secret "${key}" has unknown ${one ? 'key' : 'keys'} `
        + `${unknown.map((k) => `\`${k}:\``).join(', ')}, so it is not declared. `
        + `Correct the ${one ? 'key' : 'keys'} or remove ${one ? 'it' : 'them'} in ${target.relativePath}.`,
    );
  }

  if (options.dryRun) {
    log.info(`[dry-run] Would ${isUpdate ? 'update' : 'declare'} secret${target.where}: ${key}`);
    return;
  }
  await writeSecretsFile(target.filePath, secrets);
  log.success(`${isUpdate ? 'Updated' : 'Declared'} secret${target.where}: ${key}`);
  log.info('Run `teamai push` to sync to team repo.');
}

/**
 * Remove an env variable locally. A key that env.yaml does not set is removed
 * from the secrets file next to it; `secret` removes from the secrets file
 * only, for a key both files carry.
 * Changes are deferred — run `teamai push` to sync to team repo.
 */
export async function envRemove(
  key: string,
  options: GlobalOptions & { role?: string; project?: string; secret?: boolean },
): Promise<void> {
  const projectConfig = await detectProjectConfig();
  const localConfig = projectConfig ?? (await requireInit()).localConfig;
  const repoPath = localConfig.repo.localPath;

  if (!await refreshTeamRepo(localConfig, options.project)) return;

  const target = await envFileFromFlags(repoPath, options, options.secret ? SECRETS_LAYOUT : 'env');
  if (!target) return;
  if (options.secret) {
    if (await removeSecret(key, target, options)) return;
    log.error(`Secret "${key}" is not declared${target.where}`);
    process.exitCode = 1;
    return;
  }
  const { filePath: envYamlPath, relativePath, where } = target;
  const secretsFile = entryFileIn(repoPath, SECRETS_LAYOUT, target.namespace);

  if (!await pathExists(envYamlPath)) {
    if (await removeSecret(key, secretsFile, options)) return;
    log.error(`No env variables defined (${relativePath} not found)`);
    return;
  }

  const envConfig = await readEnvFileForEdit(envYamlPath);
  if (!envConfig) return;
  const idx = envConfig.variables.findIndex(v => v.key === key);

  if (idx === -1) {
    if (await removeSecret(key, secretsFile, options)) return;
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
 * Remove a declared secret from `file`. False when the file does not declare
 * it; true once it is removed, or reported when the file does not parse.
 */
async function removeSecret(key: string, file: EntryFileTarget, options: GlobalOptions): Promise<boolean> {
  const secrets = await readSecretsFileForEdit(file);
  if (!secrets) return true;
  const index = secrets.findIndex((secret) => secret.key === key);
  if (index === -1) return false;

  if (options.dryRun) {
    log.info(`[dry-run] Would remove secret${file.where}: ${key}`);
    return true;
  }
  secrets.splice(index, 1);
  await writeSecretsFile(file.filePath, secrets);
  log.success(`Removed secret${file.where}: ${key}`);
  log.info('Run `teamai push` to sync to team repo.');
  return true;
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

/** A file `env add` / `env remove` edit, and how messages name it. */
interface EntryFileTarget {
  readonly namespace: string | null;
  readonly filePath: string;
  readonly relativePath: string;
  readonly where: string;
}

/**
 * The secrets file to edit, or null when it does not parse, reported as for
 * env.yaml.
 */
async function readSecretsFileForEdit(file: EntryFileTarget): Promise<Record<string, unknown>[] | null> {
  const read = await readSecretsForEdit(file.filePath, file.relativePath);
  if (read.ok) return read.secrets;
  log.error(`${read.reason}. Nothing was changed. Fix the file in the team repo, then retry.`);
  process.exitCode = 1;
  return null;
}

/**
 * The env file (env.yaml, or secrets.yaml for `SECRETS_LAYOUT`) that
 * `--role <ns>` / `--project <id>` name, or the root one without either.
 * Reports the reason and returns null when the flags name none.
 */
async function envFileFromFlags(
  repoPath: string,
  flags: { role?: string; project?: string },
  layout: EntryType | EntryLayout = 'env',
): Promise<EntryFileTarget | null> {
  const target = await entryNamespaceFromFlags(repoPath, layout, flags);
  if (!target.ok) {
    log.error(target.message);
    process.exitCode = 1;
    return null;
  }
  return entryFileIn(repoPath, layout, target.namespace);
}

function entryFileIn(repoPath: string, layout: EntryType | EntryLayout, namespace: string | null): EntryFileTarget {
  const relativePath = entryFilePath(layout, namespace);
  return {
    namespace,
    filePath: entryFileAbsolutePath(repoPath, layout, namespace),
    relativePath,
    // Messages name the file only for a namespace; the root is the default.
    where: namespace === null ? '' : ` in ${relativePath}`,
  };
}
