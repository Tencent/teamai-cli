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
import { memberEnvironment, type MemberEnvironment } from './member-env.js';
import { loadLocalConfigForScope } from './config.js';
import { resolveEntries, resolveEntriesFor, type EntryResolution, type ResolvedEntry } from './namespaced-entries.js';
import { envEntryReader, type EnvVariable } from './resources/env.js';
import { envName, sameEnvName } from './resources/env-key.js';
import { declaredSecretKeys, resolveSecretDeclarations, type KnownNamespaces, type SecretDeclarations } from './resources/secrets.js';
import {
  getMachineSecretsPath, getTeamSecretsPath, readSecretStore, storedEntryKind, storedSecretValue, type SecretStore,
  type SecretStoreRead, type StoredEntryKind, type StoredSecret,
} from './secret-store.js';
import type { LocalConfig } from './types.js';
import { isReservedTeamEnvKey } from './env-reserved.js';

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
  /** User-scope variables inherited by this project, before its own variables. */
  readonly inheritedVariables: readonly ResolvedEntry<EnvVariable>[];
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
  /** The value of each variable that isn't a declared secret (each one when the declarations failed). */
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
  const variables = namespaces
    ? await resolveEntries(envEntryReader, localConfig, namespaces.active)
    : await resolveEntriesFor(envEntryReader, localConfig);
  const declarations = await resolveSecretDeclarations(localConfig, namespaces);
  const secretKeys = declaredSecretKeys(declarations) ?? new Set<string>();
  const received = variables.kind === 'resolved' ? variables.entries : [];
  const plain = received.filter((variable) => !secretKeys.has(variable.name));
  const envYaml = new Map(received.map((variable) => [variable.name, variable.entry.value]));
  const member = await memberEnvironment(localConfig, { secretKeys, envYaml }, env);
  const team = secretKeys.size > 0 || plain.length > 0 ? await readSecretStore(getTeamSecretsPath(localConfig)) : NO_VALUES;
  const machine = secretKeys.size > 0 ? await readSecretStore(getMachineSecretsPath()) : NO_VALUES;
  const secrets = secretValues(secretKeys, team, machine, member, env);
  let resolvedVariables = variableValues(plain, team, env);
  let inheritedVariables: readonly ResolvedEntry<EnvVariable>[] = [];
  if (localConfig.scope === 'project' && localConfig.inheritUserScope === true) {
    const userConfig = await loadLocalConfigForScope('user');
    if (userConfig && userConfig.repo.kind !== 'http') {
      const userEnv = await resolveTeamEnv(userConfig, undefined, env);
      const userSecretKeys = declaredSecretKeys(userEnv.declarations) ?? new Set<string>();
      inheritedVariables = userEnv.variables.kind === 'resolved'
        ? userEnv.variables.entries.filter(({ name }) => sameEnvName(userSecretKeys, name) === undefined)
        : [];
      if (resolvedVariables.kind === 'resolved' && userEnv.variableValues.kind === 'resolved') {
        const inherited = new Map(userEnv.variableValues.values);
        for (const [key, value] of resolvedVariables.values) {
          const previous = sameEnvName(inherited.keys(), key);
          if (previous !== undefined) inherited.delete(previous);
          inherited.set(key, value);
        }
        resolvedVariables = { kind: 'resolved', values: inherited };
      }
    }
  }
  return {
    variables,
    inheritedVariables,
    declarations,
    secrets: secrets.values,
    unsetReferences: secrets.unsetReferences,
    variableValues: resolvedVariables,
    staleEntries: staleEntries(secretKeys, plain, team),
    member,
  };
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
      : ['environment', member(key)];
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

/** What a pull and MCP do while the member's values can't be read: keep what the last pull wrote. */
export function variablesKeptWarning(reason: string): string {
  return `${reason} Team env variables keep the values the last pull wrote until it is fixed.`;
}
