/**
 * What a member should know about this scope's env and team secrets (#875):
 * one result that `pull`, `doctor`, `mcp list` and `env list` print from, so
 * each says the same thing. None is a failure; `doctor` reports them as notes.
 */
import { keptMcpEntries } from './mcp-reconcile.js';
import { resolveTeamEnv, secretState, type TeamEnv, type UnsetReference } from './env-resolution.js';
import { referencedVars } from './resources/mcp-format.js';
import { envName } from './resources/env-key.js';
import { mcpEntryReader, teamMcpToDef } from './resources/mcp.js';
import { declaredSecretKeys } from './resources/secrets.js';
import { isReservedTeamEnvKey } from './env-reserved.js';
import { resolveEntriesFor } from './namespaced-entries.js';
import type { LocalConfig, TeamaiConfig } from './types.js';
import { log } from './utils/logger.js';

export type EnvAdvisory =
  /** A declared secret with no value; `servers` are the team MCP servers that use it. */
  | {
    readonly kind: 'missing-secret';
    readonly key: string;
    readonly url?: string;
    readonly servers: readonly string[];
    /** The member's entry for it reads this variable, which is unset. */
    readonly reference?: UnsetReference;
  }
  /** An entry an earlier pull wrote, kept while its secret is missing, so it may hold an old value. */
  | { readonly kind: 'kept-entry'; readonly server: string; readonly tools: readonly string[]; readonly keys: readonly string[] }
  /** A key declared as a secret and also set as a variable in `source`, whose value is ignored. */
  | { readonly kind: 'secret-also-variable'; readonly key: string; readonly source: string }
  /** A variable the member exports with another value than `source`'s, which this team uses (#875). */
  | { readonly kind: 'ignored-export'; readonly key: string; readonly source: string };

/**
 * The advisories for this scope, from its declarations, so a secret no MCP
 * server uses is reported too. `teamConfig` null leaves out the kept entries,
 * which need the team's tool paths. Declarations or a store that cannot be
 * read give none: the command reading them reports that failure itself.
 * `teamEnv` is for a caller that already resolved it.
 */
export async function envAdvisories(
  localConfig: LocalConfig,
  teamConfig: TeamaiConfig | null,
  teamEnv?: TeamEnv,
): Promise<EnvAdvisory[]> {
  if (localConfig.repo.kind === 'http') return [];
  const resolved = teamEnv ?? await resolveTeamEnv(localConfig);
  const { declarations } = resolved;
  if (declarations.kind === 'failed') return [];
  const variables = resolved.variables.kind === 'resolved' ? resolved.variables.entries : [];
  const ignored = ignoredExports(resolved);
  if (declarations.kind === 'absent' || declarations.entries.length === 0) return ignored;
  const secretKeys = declaredSecretKeys(declarations);
  const mcp = await resolveEntriesFor(mcpEntryReader, localConfig);
  const excluded = new Set(localConfig.excludedSkills ?? []);
  const servers = (mcp.kind === 'resolved' ? mcp.entries : [])
    .map((entry) => teamMcpToDef(entry.entry))
    .filter((server) => !excluded.has(server.name));
  const usedBy = (key: string): string[] =>
    servers.filter((server) => referencedVars(server).some((name) => envName(name) === envName(key))).map((server) => server.name);

  const advisories: EnvAdvisory[] = [];
  for (const secret of declarations.entries) {
    if (isReservedTeamEnvKey(secret.name)) continue;
    const state = secretState(resolved.secrets, secret.name);
    switch (state) {
      case 'missing':
        advisories.push({
          kind: 'missing-secret', key: secret.name, url: secret.entry.url, servers: usedBy(secret.name),
          reference: resolved.unsetReferences.get(secret.name),
        });
        break;
      // Nobody knows while the store can't be read; the command reports that itself.
      case 'unreadable':
      case 'team':
      case 'global':
      case 'environment':
        break;
      default: {
        const unhandled: never = state;
        return unhandled;
      }
    }
  }
  if (teamConfig) {
    for (const [server, tools] of await keptMcpEntries(teamConfig, localConfig, resolved)) {
      const def = servers.find((candidate) => candidate.name === server);
      const keys = def ? referencedVars(def).filter((key) => secretKeys.has(key)) : [];
      advisories.push({ kind: 'kept-entry', server, tools, keys });
    }
  }
  for (const variable of variables) {
    if (!isReservedTeamEnvKey(variable.name) && secretKeys.has(variable.name)) advisories.push({ kind: 'secret-also-variable', key: variable.name, source: variable.source });
  }
  return [...advisories, ...ignored];
}

/** Warn about each declared secret with no value, with the command that sets it (#875). */
export async function reportMissingSecrets(localConfig: LocalConfig, teamEnv?: TeamEnv): Promise<void> {
  for (const advisory of await envAdvisories(localConfig, null, teamEnv)) {
    if (advisory.kind === 'missing-secret') log.warn(describeEnvAdvisory(advisory));
  }
}

/**
 * The variables whose export the MCP servers and `env exec` no longer use: the
 * member's own value (see member-env.ts), differing from the team's, for a key
 * they set no value for with `teamai env set`. A store that cannot be read
 * gives none.
 */
function ignoredExports(teamEnv: TeamEnv): EnvAdvisory[] {
  const { variableValues: values, member } = teamEnv;
  if (values.kind === 'store-unreadable' || values.values.size === 0) return [];
  const variables = teamEnv.variables.kind === 'resolved' ? teamEnv.variables.entries : [];
  return variables.flatMap((variable): EnvAdvisory[] => {
    if (isReservedTeamEnvKey(variable.name)) return [];
    const resolved = values.values.get(variable.name);
    if (!resolved || resolved.source !== 'env.yaml' || resolved.fromEnv) return [];
    const exported = member(variable.name);
    return exported !== undefined && exported !== resolved.value
      ? [{ kind: 'ignored-export', key: variable.name, source: variable.source }]
      : [];
  });
}

/** The line a command prints for `advisory`. It never carries a value. */
export function describeEnvAdvisory(advisory: EnvAdvisory): string {
  switch (advisory.kind) {
    case 'missing-secret': {
      const servers = advisory.servers.length > 0 ? `${advisory.servers.join(', ')}: ` : '';
      const { reference } = advisory;
      if (reference) {
        return `${servers}${advisory.key} reads ${reference.variable}, which is not set. Set ${reference.variable}, `
          + `or run \`teamai env set ${advisory.key}${reference.global ? ' --global' : ''}\` to replace the reference.`;
      }
      const url = advisory.url ? ` (${advisory.url})` : '';
      return `${servers}${advisory.key} is not set. Run \`teamai env set ${advisory.key}\`${url}.`;
    }
    case 'kept-entry':
      return `${advisory.server}: the entry an earlier pull wrote stays in ${advisory.tools.join(', ')} `
        + `and may hold an old ${advisory.keys.join(', ') || 'value'} until a pull finds its value.`;
    case 'ignored-export':
      return `${advisory.key} in your environment differs from the value in ${advisory.source}, which this team uses. `
        + `To use yours for this team, run \`teamai env set ${advisory.key}\`.`;
    case 'secret-also-variable':
      return `${advisory.key} is a team secret and is also set in ${advisory.source}, whose value is ignored. `
        + `Remove it from ${advisory.source} and run \`teamai push\`.`;
    default: {
      const unhandled: never = advisory;
      return unhandled;
    }
  }
}
