/**
 * This scope's env for the member (#875): the env.yaml variables it receives
 * and the secrets it declares, each with the member's value in the resolution
 * order (docs/designs/team-secrets.md#resolution).
 *
 * `resolveTeamEnv` reads env.yaml, secrets.yaml, both value stores and the
 * env.sh exports once. A command passes the one result to everything that
 * lists, delivers or advises from it, so it reads each file once and every
 * part of its output gives the same answer.
 */
import path from 'node:path';
import { memberEnvironment, type MemberEnvironment } from './member-env.js';
import { loadLocalConfigForScope } from './config.js';
import { describeEntryFailure, resolveEntries, resolveEntriesFor, type EntryResolution, type ResolvedEntry } from './namespaced-entries.js';
import { envEntryReader, parseEnvFileKept, readEnvBackup, type EnvVariable } from './resources/env.js';
import { envName, sameEnvName } from './resources/env-key.js';
import { declaredSecretKeys, resolveSecretDeclarations, type KnownNamespaces, type SecretDeclarations } from './resources/secrets.js';
import {
  getMachineSecretsPath, getTeamSecretsPath, readSecretStore, storedEntryKind, storedSecretValue, type SecretStore,
  type SecretStoreRead, type StoredEntryKind, type StoredSecret,
} from './secret-store.js';
import { getDataHome, getEnvBackupPath, type LocalConfig } from './types.js';
import { readFileSafe } from './utils/fs.js';
import { warnOnce } from './utils/warn-once.js';
import { collectEnvSecrets, MIN_DECLARED_SECRET_LENGTH } from './utils/redact.js';
import { isReservedTeamEnvKey } from './env-reserved.js';
import type { EnvFacts } from './workflow/requirements.js';

export interface SecretValue {
  readonly source: 'team' | 'global' | 'environment';
  readonly value: string;
}

/** Where a declared secret's value comes from; `unreadable` when a value store can't be read, so nobody knows. */
export type SecretState = SecretValue['source'] | 'missing' | 'unreadable';

/**
 * The value of an env.yaml variable this scope receives: the member's value
 * for this team (`teamai env set KEY`), then the team's. The environment
 * doesn't override either, so a value exported for one team doesn't reach
 * another team's servers, and `--global` doesn't apply: it is for secrets only.
 * `fromEnv` says the member's entry reads another variable, so `env.sh` leaves
 * the key out rather than hold a copy of that variable's value. While that
 * variable is unset the team's value is used: unlike a secret's next source,
 * it is the value every other member of the team gets.
 */
export interface VariableValue {
  readonly source: 'team' | 'env.yaml';
  readonly value: string;
  readonly fromEnv: boolean;
}

/** Each key's value, or why the member's values can't be read; `reason` carries no value. */
export type StoreResolution<V> =
  | { readonly kind: 'resolved'; readonly values: ReadonlyMap<string, V> }
  | { readonly kind: 'store-unreadable'; readonly reason: string };

export interface TeamEnv {
  /** The env.yaml variables this scope receives, a declared secret's included. */
  readonly variables: EntryResolution<EnvVariable>;
  /** User-scope variables inherited by this project: those it declares neither as a variable nor as a secret. */
  readonly inheritedVariables: readonly ResolvedEntry<EnvVariable>[];
  /**
   * Their values, decided by the user scope's own state alone: unusable while
   * its env.yaml or secret declarations fail (any of its variables may be a
   * secret) or its values file can't be read, whatever the project's state.
   */
  readonly inheritedValues: StoreResolution<VariableValue>;
  /**
   * While this scope's own variables can't be resolved (its env.yaml, its
   * secret declarations or its values file fails), what its last pull wrote,
   * which pull keeps and shells load: the env backup, empty before a pull,
   * without a key it declares as a secret. Null while they resolve.
   */
  readonly keptValues: ReadonlyMap<string, string> | null;
  /** The same for the inherited part, by the user scope's own state, without a key the project declares. */
  readonly keptInheritedValues: ReadonlyMap<string, string> | null;
  readonly declarations: SecretDeclarations;
  /**
   * Each declared secret's value: the member's value for this team, then for
   * the machine, then their own environment. A key without one is absent. The
   * first entry found decides even when its `--from-env` variable is unset:
   * falling back to the next source would send another account's token to
   * this team. A store that can't be read leaves every secret without a value,
   * for the same reason. None when the declarations failed.
   */
  readonly secrets: StoreResolution<SecretValue>;
  /**
   * The secrets without a value whose deciding entry reads a variable that is
   * unset (`--from-env`): the variable, and whether it is the machine's entry.
   */
  readonly unsetReferences: ReadonlyMap<string, UnsetReference>;
  /** The value of each of this scope's variables that isn't a declared secret (each one when the declarations failed). */
  readonly variableValues: StoreResolution<VariableValue>;
  /**
   * The keys whose entry for this team is of the other kind, so it is not
   * applied: a secret's value for a key now a variable, or a variable override
   * for a key now a secret. The key maps to the entry's kind.
   */
  readonly staleEntries: ReadonlyMap<string, StoredEntryKind>;
  /** The member's own environment (member-env.ts). */
  readonly member: MemberEnvironment;
}

export interface UnsetReference {
  readonly variable: string;
  readonly global: boolean;
}

const NO_VALUES: SecretStoreRead = { ok: true, values: {} };

/**
 * Resolve this scope's env, in env's active namespaces: `namespaces` when the
 * caller has them, else resolved from `resources.env`. A store is read only
 * when a key needs it.
 */
export async function resolveTeamEnv(
  localConfig: LocalConfig,
  namespaces?: KnownNamespaces,
  env: NodeJS.ProcessEnv = process.env,
): Promise<TeamEnv> {
  const variables = await withHeldValues(namespaces
    ? await resolveEntries(envEntryReader, localConfig, namespaces.active)
    : await resolveEntriesFor(envEntryReader, localConfig), localConfig, env);
  const declarations = await resolveSecretDeclarations(localConfig, namespaces);
  const secretKeys = declaredSecretKeys(declarations) ?? new Set<string>();
  const received = variables.kind === 'resolved' ? variables.entries : [];
  const plain = received.filter((variable) => !secretKeys.has(variable.name));
  const envYaml = new Map(received.map((variable) => [variable.name, variable.entry.value]));
  const member = await memberEnvironment(localConfig, { secretKeys, envYaml }, env);
  const team = secretKeys.size > 0 || plain.length > 0 ? await readSecretStore(getTeamSecretsPath(localConfig)) : NO_VALUES;
  const machine = secretKeys.size > 0 ? await readSecretStore(getMachineSecretsPath()) : NO_VALUES;
  const secrets = secretValues(secretKeys, team, machine, member, env);
  const ownValues = variableValues(plain, team, env);
  const ownResolves = variables.kind === 'resolved' && declarations.kind !== 'failed' && ownValues.kind === 'resolved';
  const lastPull = ownResolves ? null : await lastPullOf(localConfig);
  const keptValues = lastPull && new Map([...lastPull.values].filter(([key]) => sameEnvName(secretKeys, key) === undefined && !isReservedTeamEnvKey(key)));
  let inheritedVariables: readonly ResolvedEntry<EnvVariable>[] = [];
  let inheritedValues: StoreResolution<VariableValue> = { kind: 'resolved', values: new Map() };
  let keptInheritedValues: ReadonlyMap<string, string> | null = null;
  if (localConfig.scope === 'project' && localConfig.inheritUserScope === true) {
    // Whatever its source: the user scope's own pull writes its env.sh from
    // this same resolution, an HTTP team repo's included, and shells load it.
    const userConfig = await loadLocalConfigForScope('user');
    if (userConfig) {
      const userEnv = await resolveTeamEnv(userConfig, undefined, env);
      const userSecretKeys = declaredSecretKeys(userEnv.declarations) ?? new Set<string>();
      // A key the project declares, as a variable or a secret, is the project's:
      // a secret without a value stays missing rather than take the user's value.
      // While the project's own part can't be resolved, so is each its last pull declared, as in its shells.
      const projectKeys = [...secretKeys, ...received.map(({ name }) => name), ...lastPull?.values.keys() ?? [], ...lastPull?.kept ?? []];
      const inherits = (key: string): boolean => sameEnvName(userSecretKeys, key) === undefined && sameEnvName(projectKeys, key) === undefined;
      inheritedVariables = userEnv.variables.kind === 'resolved' ? userEnv.variables.entries.filter(({ name }) => inherits(name)) : [];
      const failed = [userEnv.variables, userEnv.declarations].find((entries) => entries.kind === 'failed');
      // Named as pull names the scope, so a file of the same name in the project is not taken for it.
      inheritedValues = failed?.kind === 'failed'
        ? { kind: 'store-unreadable', reason: `[user] ${describeEntryFailure(failed.failure)}` }
        : userEnv.variableValues.kind === 'store-unreadable'
          ? { kind: 'store-unreadable', reason: `[user] ${userEnv.variableValues.reason}` }
          : { kind: 'resolved', values: new Map([...userEnv.variableValues.values].filter(([key]) => inherits(key))) };
      keptInheritedValues = userEnv.keptValues && new Map([...userEnv.keptValues].filter(([key]) => inherits(key)));
    }
  }
  return {
    variables,
    inheritedVariables,
    inheritedValues,
    keptValues,
    keptInheritedValues,
    declarations,
    secrets: secrets.values,
    unsetReferences: secrets.unsetReferences,
    variableValues: ownValues,
    staleEntries: staleEntries(secretKeys, plain, team),
    member,
  };
}

/**
 * Whether this scope has env to resolve. An HTTP team repo has no env files,
 * but a project that inherits the user scope gets the user scope's env from
 * it, as its shells do: pull's env stage resolves every scope.
 */
export function resolvesTeamEnv(localConfig: LocalConfig): boolean {
  return localConfig.repo.kind !== 'http' || (localConfig.scope === 'project' && localConfig.inheritUserScope === true);
}

/** What `teamai env exec` gives a command from a resolution. See `appliedTeamEnv`. */
export interface AppliedTeamEnv {
  /** Each variable it sets, the inherited ones included, with its value. */
  readonly variables: ReadonlyMap<string, string>;
  /** Each declared secret, set to its value or removed; none while the declarations fail. */
  readonly secretKeys: readonly string[];
}

/**
 * What `teamai env exec` applies from this resolution, each part (this
 * scope's own variables, the inherited ones) by its own scope's state: its
 * resolved values, or while it can't be resolved what its last pull wrote,
 * as its shells and MCP servers keep. Every declared secret while the
 * declarations resolve; a secret never comes from a last pull. A reserved key never.
 */
export function appliedTeamEnv(teamEnv: TeamEnv): AppliedTeamEnv {
  const part = (values: StoreResolution<VariableValue>, kept: ReadonlyMap<string, string> | null): [string, string][] =>
    kept ? [...kept] : values.kind === 'resolved' ? [...values.values].map(([key, { value }]) => [key, value]) : [];
  const values = [...part(teamEnv.inheritedValues, teamEnv.keptInheritedValues), ...part(teamEnv.variableValues, teamEnv.keptValues)];
  return {
    variables: new Map(values.filter(([key]) => !isReservedTeamEnvKey(key))),
    secretKeys: [...declaredSecretKeys(teamEnv.declarations) ?? []].filter((key) => !isReservedTeamEnvKey(key)),
  };
}

/**
 * `variables` with each key a workspace holds back (#913) as its last pull
 * exported it, from the env backup, so env.sh, env exec and MCP keep what is
 * installed. A key the member set with `--from-env`, which env.sh and so the
 * backup leave out, is kept while that variable is set, and read from it as
 * when the key is not held. Any other held key the backup lacks stays out. A
 * backup that cannot be read throws, as `lastPullOf` does: nothing is
 * rewritten from a guess.
 */
async function withHeldValues(
  variables: EntryResolution<EnvVariable>,
  localConfig: LocalConfig,
  env: NodeJS.ProcessEnv,
): Promise<EntryResolution<EnvVariable>> {
  if (variables.kind !== 'resolved' || !variables.held?.length) return variables;
  const backup = await readEnvBackup(localConfig);
  const unexported = variables.held.filter((key) => !Object.hasOwn(backup, key));
  const team = unexported.length > 0 ? await readSecretStore(getTeamSecretsPath(localConfig)) : NO_VALUES;
  const fromEnv = (key: string): boolean => {
    const entry = team.ok ? storeEntry(team.values, key, 'variable') : undefined;
    return entry !== undefined && 'env' in entry && storedSecretValue(entry, env) !== undefined;
  };
  const kept = variables.held.flatMap((key): ResolvedEntry<EnvVariable>[] => {
    if (!Object.hasOwn(backup, key) && !fromEnv(key)) return [];
    // Without a backup value, the member's entry decides the value (variableValues): this one is never read.
    const [value, source] = Object.hasOwn(backup, key) ? [backup[key], getEnvBackupPath(localConfig)] : ['', getTeamSecretsPath(localConfig)];
    return [{ entry: { key, value }, name: key, namespace: null, source, replaces: null, replacedEntry: null }];
  });
  return { ...variables, entries: [...variables.entries, ...kept] };
}

/** What this scope's last pull wrote: the values its env backup holds, and the keys its env.sh keeps from the user scope. */
async function lastPullOf(localConfig: LocalConfig): Promise<{ values: ReadonlyMap<string, string>; kept: ReadonlySet<string> }> {
  const envSh = await readFileSafe(path.join(getDataHome(localConfig), 'env.sh'));
  return { values: new Map(Object.entries(await readEnvBackup(localConfig))), kept: envSh ? parseEnvFileKept(envSh) : new Set() };
}

/** The variable declarations a scope delivers, with project declarations taking precedence over inherited user ones. */
export function effectiveTeamEnvVariables(teamEnv: TeamEnv): readonly ResolvedEntry<EnvVariable>[] {
  const effective = new Map<string, ResolvedEntry<EnvVariable>>();
  for (const variable of [...teamEnv.inheritedVariables, ...(teamEnv.variables.kind === 'resolved' ? teamEnv.variables.entries : [])]) {
    const key = envName(variable.name);
    effective.delete(key);
    effective.set(key, variable);
  }
  return [...effective.values()];
}

/** The entry for `key` when it is of this kind: a secret never resolves from a variable override, nor the reverse. */
function storeEntry(store: SecretStore, key: string, kind: StoredEntryKind): StoredSecret | undefined {
  // On Windows a value stored as `token` is `TOKEN`'s: the same environment variable.
  const stored = sameEnvName(Object.keys(store), key);
  const entry = stored === undefined ? undefined : store[stored];
  return entry && storedEntryKind(entry) === kind ? entry : undefined;
}

function staleEntries(
  secretKeys: ReadonlySet<string>,
  variables: readonly ResolvedEntry<EnvVariable>[],
  team: SecretStoreRead,
): ReadonlyMap<string, StoredEntryKind> {
  const stale = new Map<string, StoredEntryKind>();
  if (!team.ok) return stale;
  const check = (key: string, kind: StoredEntryKind): void => {
    const stored = sameEnvName(Object.keys(team.values), key);
    const entry = stored === undefined ? undefined : team.values[stored];
    if (entry && storedEntryKind(entry) !== kind) stale.set(key, storedEntryKind(entry));
  };
  for (const key of secretKeys) check(key, 'secret');
  for (const variable of variables) check(variable.name, 'variable');
  return stale;
}

function secretValues(
  keys: ReadonlySet<string>,
  team: SecretStoreRead,
  machine: SecretStoreRead,
  member: MemberEnvironment,
  env: NodeJS.ProcessEnv,
): { values: StoreResolution<SecretValue>; unsetReferences: ReadonlyMap<string, UnsetReference> } {
  const values = new Map<string, SecretValue>();
  const unsetReferences = new Map<string, UnsetReference>();
  const result = { values: { kind: 'resolved', values }, unsetReferences } as const;
  if (keys.size === 0) return result;
  if (!team.ok) return { values: { kind: 'store-unreadable', reason: team.reason }, unsetReferences };
  if (!machine.ok) return { values: { kind: 'store-unreadable', reason: machine.reason }, unsetReferences };
  for (const key of keys) {
    const teamEntry = storeEntry(team.values, key, 'secret');
    const machineEntry = storeEntry(machine.values, key, 'secret');
    const entry = teamEntry ?? machineEntry;
    const [source, value]: [SecretValue['source'], string | undefined] = teamEntry ? ['team', storedSecretValue(teamEntry, env)]
      : machineEntry ? ['global', storedSecretValue(machineEntry, env)]
      : ['environment', member(key) || undefined];
    if (value !== undefined) values.set(key, { source, value });
    else if (entry && 'env' in entry) unsetReferences.set(key, { variable: entry.env, global: teamEntry === undefined });
  }
  return result;
}

function variableValues(
  variables: readonly ResolvedEntry<EnvVariable>[],
  team: SecretStoreRead,
  env: NodeJS.ProcessEnv,
): StoreResolution<VariableValue> {
  const values = new Map<string, VariableValue>();
  if (variables.length === 0) return { kind: 'resolved', values };
  if (!team.ok) return { kind: 'store-unreadable', reason: team.reason };
  for (const variable of variables) {
    const entry = storeEntry(team.values, variable.name, 'variable');
    const member = entry ? storedSecretValue(entry, env) : undefined;
    const fromEnv = entry !== undefined && 'env' in entry;
    values.set(variable.name, member !== undefined
      ? { source: 'team', value: member, fromEnv }
      : { source: 'env.yaml', value: variable.entry.value, fromEnv });
  }
  return { kind: 'resolved', values };
}

/**
 * The value of each secret the team declares in `env/secrets.yaml`, as this
 * member resolves it, keyed by name, for redaction. A declared name need not
 * look secret, so `collectEnvSecrets` misses these. Empty, with a warning,
 * when the values can't be read. A value too short to tell from ordinary text
 * is left out, with a warning that names it.
 */
export async function collectTeamSecrets(localConfig: LocalConfig, env: NodeJS.ProcessEnv = process.env): Promise<Record<string, string>> {
  if (!resolvesTeamEnv(localConfig)) return {};
  return teamSecretsOf((await resolveTeamEnv(localConfig, undefined, env)).secrets);
}

function teamSecretsOf(secrets: StoreResolution<SecretValue>): Record<string, string> {
  if (secrets.kind !== 'resolved') {
    warnOnce(`${secrets.reason} Until it can be read, teamai does not mask the team's secret values in what it writes.`);
    return {};
  }
  return Object.fromEntries([...secrets.values].flatMap(([key, { value }]) => {
    if (value.length >= MIN_DECLARED_SECRET_LENGTH) return [[key, value]];
    if (value) warnOnce(`Secret ${key} in env/secrets.yaml is shorter than ${MIN_DECLARED_SECRET_LENGTH} characters, so teamai cannot tell it from ordinary text and does not mask it. Give it a longer value.`);
    return [];
  }));
}

/**
 * Every value teamai masks on this machine, keyed by name: environment values that look secret, and the team's
 * declared secrets. Publishing a run, writing its file, and printing a workflow envelope agree on it. A team value
 * replaces the environment's under the same name for a step, but both stay known: the environment's is kept as
 * `<name> (environment)`.
 */
export async function knownSecrets(localConfig: LocalConfig, env: NodeJS.ProcessEnv = process.env): Promise<Record<string, string>> {
  return (await resolveWorkflowEnv(localConfig, env)).secrets;
}

function maskSet(fromEnvironment: Record<string, string>, team: Record<string, string>): Record<string, string> {
  const shadowed = Object.entries(fromEnvironment).flatMap(([key, value]) => (key in team && team[key] !== value ? [[`${key} (environment)`, value]] : []));
  return { ...fromEnvironment, ...team, ...Object.fromEntries(shadowed) };
}

/** The env key a `knownSecrets` name stands for. */
export function secretKey(label: string): string {
  return label.split(' ')[0] ?? label;
}

export function secretState(secrets: StoreResolution<SecretValue>, key: string): SecretState {
  return secrets.kind === 'resolved' ? secrets.values.get(key)?.source ?? 'missing' : 'unreadable';
}

/** The variables `env.sh` exports, with their resolved values: every one in `values` but a `--from-env` override. */
export function envShVariables(
  variables: readonly ResolvedEntry<EnvVariable>[],
  values: ReadonlyMap<string, VariableValue>,
): EnvVariable[] {
  return variables.flatMap((variable) => {
    const resolved = values.get(variable.name);
    return resolved && !resolved.fromEnv && !isReservedTeamEnvKey(variable.name) ? [{ ...variable.entry, value: resolved.value }] : [];
  });
}

/**
 * The keys an inheriting project's env.sh keeps from the user scope's env.sh,
 * which the loader sources first: every key the project declares, as a
 * variable or a secret, that its env.sh does not export. Another spelling of
 * an exported key is unset by the loader before the export, on Windows
 * (`__teamai_env_spellings`, env-loader.ts).
 */
export function keptFromUserScope(localConfig: LocalConfig, teamEnv: TeamEnv, exported: readonly EnvVariable[]): string[] {
  if (localConfig.scope !== 'project' || localConfig.inheritUserScope !== true) return [];
  const exportedKeys = exported.map(({ key }) => key);
  const declared = new Set([
    ...(teamEnv.variables.kind === 'resolved' ? teamEnv.variables.entries.map(({ name }) => name) : []),
    ...(declaredSecretKeys(teamEnv.declarations) ?? []),
  ]);
  return [...declared].filter((key) => !exportedKeys.includes(key) && !isReservedTeamEnvKey(key));
}

/** What a pull and MCP do while the member's values can't be read: keep what the last pull wrote. */
export function variablesKeptWarning(reason: string): string {
  return `${reason} Team env variables keep the values the last pull wrote until it is fixed.`;
}

/** This machine's team env for one workflow operation, resolved once, so what the engine holds and what is masked agree. */
export interface WorkflowEnv {
  /** By name only, which is all the workflow engine may hold. */
  readonly facts: EnvFacts;
  /** Each value a step can be given: the variables `teamai env exec` applies, each declared secret's, else the environment's. */
  readonly values: ReadonlyMap<string, string>;
  /** What every write and print masks, as `knownSecrets` says. */
  readonly secrets: Record<string, string>;
}

/**
 * The team env a workflow step can be given on this machine, and what masking hides. A key nothing here declares takes
 * its value from the environment, as a CI job's token does.
 */
export async function resolveWorkflowEnv(localConfig: LocalConfig, env: NodeJS.ProcessEnv = process.env): Promise<WorkflowEnv> {
  const values = new Map(Object.entries(env).flatMap(([key, value]) => (value ? [[key, value]] : [])));
  if (!resolvesTeamEnv(localConfig)) {
    return { facts: { declared: new Set(), secrets: new Set(), present: new Set(values.keys()) }, values, secrets: collectEnvSecrets(env) };
  }
  const teamEnv = await resolveTeamEnv(localConfig, undefined, env);
  const applied = appliedTeamEnv(teamEnv);
  // The environment's own value of a declared secret is a secret too, whatever its name, even when the team value differs.
  const personalSecrets = environmentValuesOf(applied.secretKeys, values);
  const declared = new Set([...applied.variables.keys(), ...applied.secretKeys]);
  for (const key of declared) values.delete(sameEnvName(values.keys(), key) ?? key);
  for (const [key, value] of applied.variables) values.set(key, value);
  if (teamEnv.secrets.kind === 'resolved') for (const [key, { value }] of teamEnv.secrets.values) values.set(key, value);
  const failed = [teamEnv.variables, teamEnv.declarations].find((entries) => entries.kind === 'failed');
  const unreadable = failed?.kind === 'failed' ? describeEntryFailure(failed.failure)
    : teamEnv.secrets.kind === 'store-unreadable' ? teamEnv.secrets.reason
      : teamEnv.variableValues.kind === 'store-unreadable' ? teamEnv.variableValues.reason : undefined;
  return {
    facts: { declared, secrets: new Set(applied.secretKeys), present: new Set(values.keys()), ...(unreadable !== undefined ? { unreadable } : {}) },
    values,
    secrets: maskSet({ ...collectEnvSecrets(env), ...personalSecrets }, teamSecretsOf(teamEnv.secrets)),
  };
}

/** The environment's value of each of `keys`, long enough to mask. */
function environmentValuesOf(keys: Iterable<string>, values: ReadonlyMap<string, string>): Record<string, string> {
  return Object.fromEntries([...keys].flatMap((key) => {
    const name = sameEnvName(values.keys(), key) ?? key;
    const value = values.get(name);
    return value !== undefined && value.length >= MIN_DECLARED_SECRET_LENGTH ? [[name, value]] : [];
  }));
}
