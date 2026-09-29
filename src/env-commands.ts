import { requireInit, detectProjectConfig, describeUnreadableConfig, NotInitializedError } from './config.js';
import { pullRepo } from './utils/git.js';
import { pathExists } from './utils/fs.js';
import { log, spinner } from './utils/logger.js';
import { EnvHandler, envEntryReader, unknownEnvVariableKeys, type EnvYaml } from './resources/env.js';
import { ENV_KEY_RE, envName, envValue, sameEnvName } from './resources/env-key.js';
import {
  SECRETS_LAYOUT, declaredSecretKeys, readSecretsForEdit, resolveSecretDeclarations, unknownSecretDeclarationKeys,
  writeSecretsFile,
} from './resources/secrets.js';
import { getMachineSecretsPath, getTeamSecretsPath, readSecretStore, updateSecretStore, type StoredSecret } from './secret-store.js';
import { askSecret, isInteractive, readStdin } from './utils/prompt.js';
import { reportMissingSecrets } from './env-advisories.js';
import { envListing } from './env-listing.js';
import { resolveTeamEnv } from './env-resolution.js';
import {
  describeEntryFailure, entryFileAbsolutePath, entryFilePath, entryLayout, entryNamespaceFromFlags, moveTo, reportUndeliveredEntryNotices, resolveEntriesFor, TargetFiles,
  type EntryLayout, type EntryType,
} from './namespaced-entries.js';
import type { GlobalOptions, LocalConfig } from './types.js';
import { isSelfMode } from './types.js';

const envHandler = new EnvHandler();

/**
 * List the team env variables this directory receives and the secrets it
 * declares (env-listing.ts). By default, variable values are masked. Pass
 * `reveal: true` to show plaintext. A file that cannot be used fails its own
 * list only, and the command exits non-zero.
 */
export async function envList(options: GlobalOptions & { reveal?: boolean }): Promise<void> {
  // Read-only, so `dryRun: true` unconditionally, as in `status` and `list` (#850).
  const localConfig = await requireScope(true);
  if (!localConfig) return;
  const teamEnv = await resolveTeamEnv(localConfig);
  // An entry an unknown or removed key takes out of the delivered set never
  // appears in the list below, so say why it is missing (#822).
  reportUndeliveredEntryNotices(teamEnv.variables);
  const listing = envListing(teamEnv, options);
  for (const problem of listing.problems) fail(problem);
  if (listing.lines.length === 0) {
    if (listing.problems.length === 0) log.info('No env variables defined');
    return;
  }
  if (listing.revealed) process.stderr.write('[warn] Env values will be shown in plaintext\n');
  console.log('');
  for (const line of listing.lines) {
    if (line.detail) log.dim(line.text);
    else console.log(line.text);
  }
  if (listing.hasSecrets) await reportMissingSecrets(localConfig, teamEnv);
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
  typed: string,
  options: GlobalOptions & { stdin?: boolean; fromEnv?: string; global?: boolean },
): Promise<void> {
  // Stored under the name the scope declares, which on Windows may differ in case from the one typed.
  let key = typed;
  if (!ENV_KEY_RE.test(key)) return fail(invalidKeyMessage(key));
  if (options.stdin && options.fromEnv !== undefined) return fail('Pass either --stdin or --from-env, not both. Nothing was changed.');
  if (options.fromEnv !== undefined && !ENV_KEY_RE.test(options.fromEnv)) {
    return fail(invalidKeyMessage(options.fromEnv, '--from-env variable name'));
  }

  const scope = await scopeHere(options.global, options.dryRun);
  if (scope.kind === 'reported') return;
  const localConfig = scope.kind === 'scope' ? scope.localConfig : null;
  let isVariable = false;
  if (localConfig) {
    const declarations = await resolveSecretDeclarations(localConfig);
    if (declarations.kind === 'failed') {
      log.error(describeEntryFailure(declarations.failure));
      return fail(`Cannot tell whether ${key} is a secret this team declares. Nothing was changed.`);
    }
    const declared = declaredSecretKeys(declarations);
    key = sameEnvName(declared, key) ?? key;
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
      key = sameEnvName(variables, key) ?? key;
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
  // Read before asking for the value, so an unusable store fails first; the write re-reads it under the lock.
  const store = await readSecretStore(file);
  if (!store.ok) return fail(`${store.reason} Nothing was changed.`);
  if (options.dryRun) {
    log.info(`[dry-run] Would set ${key} ${target} in ${file}`);
    return;
  }

  const input = await secretInput(key, options);
  if (!input.ok) return fail(`${input.message} Nothing was changed.`);
  const { entry } = input;

  // The kind the scope declares the key as now, so the value is never used as the other one (#879).
  const kind = isVariable ? 'variable' : 'secret';
  // On Windows an entry under another case of the key is this key's: it is replaced too.
  const update = await updateSecretStore(file, (values) => ({ ...withoutKey(values, key), [key]: { ...entry, kind } }));
  if (update.kind === 'failed') return fail(`${update.reason} Nothing was changed.`);
  if ('env' in entry) {
    log.success(`${key} now reads ${entry.env} from your environment ${target} (${file}).`);
    if (!envValue(process.env, entry.env)) log.warn(`${entry.env} is not set in this shell; ${key} has no value until it is.`);
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
  const scope = await scopeHere(options.global, options.dryRun);
  if (scope.kind === 'reported') return;
  const localConfig = scope.kind === 'scope' ? scope.localConfig : null;

  const { file, value } = valuesFile(localConfig, options.global);
  const hasNoValue = (): void => { log.info(`${key} has no ${value}. Nothing was changed.`); };
  if (options.dryRun) {
    const store = await readSecretStore(file);
    if (!store.ok) return fail(`${store.reason} Nothing was changed.`);
    const stored = sameEnvName(Object.keys(store.values), key);
    if (stored === undefined) return hasNoValue();
    log.info(`[dry-run] Would remove ${stored}'s ${value} from ${file}`);
    return;
  }
  // On Windows the stored name may differ in case from the one typed: it is the same variable.
  const update = await updateSecretStore(file, (values) => (sameEnvName(Object.keys(values), key) === undefined ? null : withoutKey(values, key)));
  switch (update.kind) {
    case 'failed':
      return fail(`${update.reason} Nothing was changed.`);
    case 'unchanged':
      return hasNoValue();
    case 'written':
      break;
    default: {
      const unhandled: never = update;
      return unhandled;
    }
  }
  log.success(`Removed ${key}'s ${value} (${file}).`);
  if (!localConfig) return;
  log.info(`Run \`teamai pull\` to ${await unsetApplies(localConfig, key, options.global)}.`);
}

/**
 * This directory's scope. Outside any scope `env set --global` still has
 * somewhere to write, so there `global` gives `none`; otherwise "not
 * initialized" is reported (exit 1) and gives `reported`. A project config
 * that cannot be read is reported too: detection would answer with the user
 * scope, whose team may not be this project's (the rule `pull` follows, #784).
 * A `dryRun` lookup writes nothing (#866).
 */
async function scopeHere(
  global: boolean | undefined,
  dryRun: boolean | undefined,
): Promise<{ kind: 'scope'; localConfig: LocalConfig } | { kind: 'none' } | { kind: 'reported' }> {
  const unreadable: string[] = [];
  const projectConfig = await detectProjectConfig(
    process.cwd(),
    (configPath, error) => { unreadable.push(`${configPath}: ${error}`); },
    { dryRun },
  );
  const [problem] = unreadable;
  if (problem !== undefined) {
    fail(`Cannot tell which team this directory belongs to: ${describeUnreadableConfig(problem)}`);
    return { kind: 'reported' };
  }
  if (projectConfig) return { kind: 'scope', localConfig: projectConfig };
  try {
    return { kind: 'scope', localConfig: (await requireInit({ dryRun })).localConfig };
  } catch (e) {
    if (!(e instanceof NotInitializedError)) throw e;
    if (global) return { kind: 'none' };
    fail(e.message);
    return { kind: 'reported' };
  }
}

/** This directory's scope, or null once "not initialized" is reported. */
async function requireScope(dryRun: boolean | undefined): Promise<LocalConfig | null> {
  const scope = await scopeHere(false, dryRun);
  return scope.kind === 'scope' ? scope.localConfig : null;
}

/**
 * The store `env set` / `env unset` write, and how their messages name it and
 * a value in it. Without a scope, only the machine's: `global` there, as the
 * flag and `env list` call it.
 */
function valuesFile(
  localConfig: LocalConfig | null,
  global: boolean | undefined,
): { file: string; target: string; value: string } {
  return localConfig && !global
    ? { file: getTeamSecretsPath(localConfig), target: 'for this team', value: 'value for this team' }
    : {
      file: getMachineSecretsPath(),
      target: 'as your global value (every team on this machine)',
      value: 'global value (every team on this machine)',
    };
}

/**
 * What the pull after `env unset` updates: env.sh exports a member's value for
 * a variable (#875), not for a secret. Declarations that fail can't say which
 * the key is.
 */
async function unsetApplies(localConfig: LocalConfig, key: string, global: boolean | undefined): Promise<string> {
  if (global) return 'update MCP servers';
  const declared = declaredSecretKeys(await resolveSecretDeclarations(localConfig));
  if (!declared) return 'apply it';
  return declared.has(key) ? 'update MCP servers' : 'update MCP servers and env.sh';
}

/** The entry `env set` stores: a `--from-env` reference, piped stdin, or the hidden prompt. */
async function secretInput(
  key: string,
  options: { stdin?: boolean; fromEnv?: string },
): Promise<{ ok: true; entry: StoredSecret } | { ok: false; message: string }> {
  if (options.fromEnv !== undefined) return { ok: true, entry: { env: options.fromEnv } };
  if (options.stdin) {
    if (process.stdin.isTTY) return { ok: false, message: '--stdin expects piped stdin; run without it to be prompted.' };
    process.stdin.setEncoding('utf8');
    const value = await readStdin();
    return value ? { ok: true, entry: { value } } : { ok: false, message: 'No value was provided on stdin.' };
  }
  let value: string;
  try {
    value = await askSecret(`Value for ${key}: `);
  } catch (e) {
    if (isInteractive()) throw e;
    return { ok: false, message: `Cannot prompt for ${key} without a terminal. Pipe the value with --stdin, or pass --from-env <VAR>.` };
  }
  return value ? { ok: true, entry: { value } } : { ok: false, message: 'No value was entered.' };
}

function invalidKeyMessage(key: string, what = 'env variable name'): string {
  return `Invalid ${what} "${key}": use letters, digits and underscores, starting with a letter or underscore.`;
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
  if (!ENV_KEY_RE.test(key)) return fail(invalidKeyMessage(key));
  // Every member supplies a secret's value on their own machine; the value
  // passed here is neither stored nor printed.
  if (options.secret && value !== undefined) {
    return fail(
      `A secret has no value in the team repo, so --secret takes none. Nothing was changed. `
        + `Run \`teamai env add ${key} --secret\` without the value.`,
    );
  }
  if (!options.secret && options.url !== undefined) {
    return fail('--url says where a member gets a secret\'s value, so it needs --secret. Nothing was changed.');
  }
  if (!options.secret && value === undefined) {
    return fail(
      `No value for "${key}". Run \`teamai env add ${key} <value>\`, `
        + `or \`teamai env add ${key} --secret\` to declare a secret each member sets.`,
    );
  }

  const localConfig = await requireScope(options.dryRun);
  if (!localConfig) return;
  const repoPath = localConfig.repo.localPath;

  if (!await refreshTeamRepo(localConfig, options.project)) return;
  if (options.secret) {
    await declareSecret(repoPath, key, options);
    return;
  }
  // Refused above: a variable needs a value.
  if (value === undefined) return;

  const target = await envFileFromFlags(repoPath, options);
  if (!target) return;
  const { filePath: envYamlPath, relativePath, where } = target;

  // The target env.yaml, or a new one when it does not exist.
  const envConfig = await readEnvFileForEdit(envYamlPath);
  if (!envConfig) return;

  // Check if key already exists
  // On Windows a key typed in another case is this variable: it is updated, not added a second time.
  const existingIdx = envConfig.variables.findIndex(v => sameEntryKey(v.key, key));
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
    // Same for a removed per-entry key, which the schema keeps so it can be
    // detected rather than stripped: `roles:` on env and `projects:` reach nobody.
    const updated = envConfig.variables[existingIdx];
    const removed: string[] = [];
    if (updated.projects !== undefined) removed.push('projects');
    if (updated.roles !== undefined) removed.push('roles');
    if (removed.length > 0) {
      // The remediation has to name the namespace file, as pull's notice does:
      // dropping a root-scoped key where it sits would deliver the secret to
      // everyone — the outcome the per-entry key was scoping against.
      const targets = new TargetFiles(repoPath, entryLayout('env'));
      const files: string[] = [];
      for (const key of removed) {
        files.push(...await targets.forIds(key as 'roles' | 'projects', updated[key as 'roles' | 'projects'] ?? []));
      }
      log.warn(
        `${relativePath}: variable "${key}" is scoped with per-entry `
          + `${removed.map((k) => `\`${k}:\``).join(' and ')}, which this version no longer reads, `
          + `so pull does not deliver it. ${moveTo(files)}`,
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

  const index = secrets.findIndex((secret) => sameEntryKey(secret.key, key));
  const isUpdate = index !== -1;
  // On Windows a key typed in another case is the declared one: it keeps its declared name.
  if (isUpdate && typeof secrets[index]?.key === 'string') key = secrets[index].key;
  const declaration = {
    ...(isUpdate ? secrets[index] : {}),
    key,
    ...(options.description !== undefined ? { description: options.description } : {}),
    ...(options.url !== undefined ? { url: options.url } : {}),
  };
  if (isUpdate) secrets[index] = declaration;
  else secrets.push(declaration);
  // A key declared twice fails every read of the file, so the update leaves one.
  const duplicates = dropDuplicateSecrets(secrets, key);
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

  const removedToo = duplicates === 0 ? '' : `, and ${options.dryRun ? 'remove' : 'removed'} ${declarationCount(duplicates)} of it`;
  if (options.dryRun) {
    log.info(`[dry-run] Would ${isUpdate ? 'update' : 'declare'} secret${target.where}: ${key}${removedToo}`);
    return;
  }
  await writeSecretsFile(target.filePath, secrets);
  log.success(`${isUpdate ? 'Updated' : 'Declared'} secret${target.where}: ${key}${removedToo}`);
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
  const localConfig = await requireScope(options.dryRun);
  if (!localConfig) return;
  const repoPath = localConfig.repo.localPath;

  if (!await refreshTeamRepo(localConfig, options.project)) return;

  const target = await envFileFromFlags(repoPath, options, options.secret ? SECRETS_LAYOUT : 'env');
  if (!target) return;
  if (options.secret) {
    if (await removeSecret(key, target, options) !== 'absent') return;
    return fail(
      `Secret "${key}" is not declared in ${target.relativePath}. Nothing was changed. For a namespace's file, pass `
      + '--role <ns> or --project <id>; `teamai env list` shows where each secret this directory receives comes from.',
    );
  }
  const { filePath: envYamlPath, relativePath, where } = target;
  const secretsFile = entryFileIn(repoPath, SECRETS_LAYOUT, target.namespace);

  if (!await pathExists(envYamlPath)) {
    if (await removeSecret(key, secretsFile, options) === 'removed') return;
    return fail(`No env variables defined (${relativePath} not found)`);
  }

  const envConfig = await readEnvFileForEdit(envYamlPath);
  if (!envConfig) return;
  const idx = envConfig.variables.findIndex(v => sameEntryKey(v.key, key));

  if (idx === -1) {
    if (await removeSecret(key, secretsFile, options) === 'removed') return;
    return fail(`Env variable "${key}" not found${where}`);
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
 * Remove a declared secret from `file`: `removed` (or would be, on dry-run),
 * `absent` when the file does not declare it, `reported` when the file does
 * not parse and the reason was printed.
 */
async function removeSecret(
  key: string,
  file: EntryFileTarget,
  options: GlobalOptions,
): Promise<'removed' | 'absent' | 'reported'> {
  const secrets = await readSecretsFileForEdit(file);
  if (!secrets) return 'reported';
  const index = secrets.findIndex((secret) => sameEntryKey(secret.key, key));
  if (index === -1) return 'absent';

  // Every declaration of it: one left behind still declares the key.
  const duplicates = dropDuplicateSecrets(secrets, key, 0) - 1;
  const removedToo = duplicates === 0 ? '' : `, and ${declarationCount(duplicates)} of it`;
  if (options.dryRun) {
    log.info(`[dry-run] Would remove secret${file.where}: ${key}${removedToo}`);
    return 'removed';
  }
  await writeSecretsFile(file.filePath, secrets);
  log.success(`Removed secret${file.where}: ${key}${removedToo}`);
  log.info('Run `teamai push` to sync to team repo.');
  return 'removed';
}

/** `values` without `key`, in every case of it on Windows, where they are one environment variable. */
function withoutKey<T>(values: Readonly<Record<string, T>>, key: string): Record<string, T> {
  const rest = { ...values };
  for (const other of Object.keys(rest)) if (envName(other) === envName(key)) delete rest[other];
  return rest;
}

/** Whether an entry's `key` is `key`: the same environment variable, so in any case on Windows. */
function sameEntryKey(declared: unknown, key: string): boolean {
  return typeof declared === 'string' && envName(declared) === envName(key);
}

/** Remove the declarations of `key` after the first `keep` of them from `secrets`; answers how many. */
function dropDuplicateSecrets(secrets: Record<string, unknown>[], key: string, keep = 1): number {
  let seen = 0;
  let removed = 0;
  for (let i = 0; i < secrets.length; i++) {
    if (!sameEntryKey(secrets[i]?.key, key) || ++seen <= keep) continue;
    secrets.splice(i--, 1);
    removed++;
  }
  return removed;
}

function declarationCount(duplicates: number): string {
  return `${duplicates} duplicate declaration${duplicates === 1 ? '' : 's'}`;
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
    fail(
      `The team repo could not be refreshed (${(e as Error).message}), so the env namespace of project "${project}" `
      + 'may be out of date. Nothing was changed. Fix the pull (run `teamai pull` to see why) and retry, or pass --role <ns>.',
    );
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
  fail(`${read.reason}. Nothing was changed. Fix the file in the team repo, then retry.`);
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
  fail(`${read.reason}. Nothing was changed. Fix the file in the team repo, then retry.`);
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
    fail(target.message);
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
