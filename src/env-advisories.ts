/**
 * What a member should know about this scope's env and team secrets (#875):
 * one result that `pull`, `doctor`, `mcp list` and `env list` print from, so
 * each says the same thing. None is a failure; `doctor` reports them as notes.
 */
import { keptMcpEntries } from './mcp-reconcile.js';
import { envEntryReader, type EnvVariable } from './resources/env.js';
import { memberEnvironment } from './member-env.js';
import { referencedVars } from './resources/mcp-format.js';
import { mcpEntryReader, teamMcpToDef } from './resources/mcp.js';
import {
  declaredSecretKeys, resolveSecretDeclarations, resolveSecretValues, resolveVariableValues, secretState,
} from './resources/secrets.js';
import { resolveEntriesFor, type ResolvedEntry } from './namespaced-entries.js';
import type { LocalConfig, TeamaiConfig } from './types.js';

export type EnvAdvisory =
  /** A declared secret with no value; `servers` are the team MCP servers that use it. */
  | { readonly kind: 'missing-secret'; readonly key: string; readonly url?: string; readonly servers: readonly string[] }
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
 */
export async function envAdvisories(localConfig: LocalConfig, teamConfig: TeamaiConfig | null): Promise<EnvAdvisory[]> {
  if (localConfig.repo.kind === 'http') return [];
  const declarations = await resolveSecretDeclarations(localConfig);
  if (declarations.kind === 'failed') return [];
  const env = await resolveEntriesFor(envEntryReader, localConfig);
  const variables = env.kind === 'resolved' ? env.entries : [];
  const ignored = await ignoredExports(localConfig, variables, declaredSecretKeys(declarations));
  if (declarations.kind === 'absent' || declarations.entries.length === 0) return ignored;
  const secretKeys = new Set(declarations.entries.map((secret) => secret.name));
  const values = await resolveSecretValues(localConfig, secretKeys, variables);
  const mcp = await resolveEntriesFor(mcpEntryReader, localConfig);
  const excluded = new Set(localConfig.excludedSkills ?? []);
  const servers = (mcp.kind === 'resolved' ? mcp.entries : [])
    .map((entry) => teamMcpToDef(entry.entry))
    .filter((server) => !excluded.has(server.name));
  const usedBy = (key: string): string[] =>
    servers.filter((server) => referencedVars(server).includes(key)).map((server) => server.name);

  const advisories: EnvAdvisory[] = [];
  if (values.kind === 'resolved') {
    for (const secret of declarations.entries) {
      if (secretState(values, secret.name) !== 'missing') continue;
      advisories.push({ kind: 'missing-secret', key: secret.name, url: secret.entry.url, servers: usedBy(secret.name) });
    }
  }
  if (teamConfig) {
    for (const [server, tools] of await keptMcpEntries(teamConfig, localConfig)) {
      const def = servers.find((candidate) => candidate.name === server);
      const keys = def ? referencedVars(def).filter((key) => secretKeys.has(key)) : [];
      advisories.push({ kind: 'kept-entry', server, tools, keys });
    }
  }
  for (const variable of variables) {
    if (secretKeys.has(variable.name)) advisories.push({ kind: 'secret-also-variable', key: variable.name, source: variable.source });
  }
  return [...advisories, ...ignored];
}

/**
 * The variables whose export the MCP servers and `env exec` no longer use: the
 * member's own value (see member-env.ts), differing from the team's, for a key
 * they set no value for with `teamai env set`. A store that cannot be read
 * gives none.
 */
async function ignoredExports(
  localConfig: LocalConfig,
  variables: readonly ResolvedEntry<EnvVariable>[],
  secretKeys: ReadonlySet<string>,
): Promise<EnvAdvisory[]> {
  const values = await resolveVariableValues(localConfig, variables, secretKeys);
  if (values.kind === 'store-unreadable' || values.values.size === 0) return [];
  const envYaml = new Map(variables.map((variable) => [variable.name, variable.entry.value]));
  const member = await memberEnvironment(localConfig, { secretKeys, envYaml });
  return variables.flatMap((variable): EnvAdvisory[] => {
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
