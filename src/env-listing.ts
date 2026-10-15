/**
 * One scope's env as `teamai env list` and `teamai list env` show it (#875):
 * the env.yaml variables it receives, each with the value it resolves to and
 * where that comes from (`team` for the member's value, `env.yaml`), then the
 * secrets it declares, each with where its value comes from, never the value.
 * A key declared as a secret is listed only as one: its env.yaml value is not
 * delivered. A project that inherits the user scope lists its variables too.
 *
 * A value nobody can tell is not shown: while its declarations fail, any
 * variable may be a secret whose repo value is ignored, and while the member's
 * values can't be read, a variable's value is `unreadable`, as a secret's is.
 */
import { effectiveTeamEnvVariables, secretState, type TeamEnv } from './env-resolution.js';
import { describeEntryFailure, describeOrigin } from './namespaced-entries.js';
import { maskEnvValue } from './resources/env.js';
import { declaredSecretKeys } from './resources/secrets.js';
import { isReservedTeamEnvKey } from './env-reserved.js';

export interface EnvListingLine {
  readonly text: string;
  /** A description or url, shown with `verbose`. */
  readonly detail: boolean;
}

export interface EnvListing {
  /** Why part of the listing can't be resolved, one message each. */
  readonly problems: readonly string[];
  /** Empty when the scope has no variables and declares no secrets. */
  readonly lines: readonly EnvListingLine[];
  /** A line shows a value in plaintext (`reveal`). */
  readonly revealed: boolean;
  /** The listing has a secrets section. */
  readonly hasSecrets: boolean;
}

export function envListing(teamEnv: TeamEnv, options: { reveal?: boolean; verbose?: boolean }): EnvListing {
  const { variables, declarations, variableValues, secrets, staleEntries } = teamEnv;
  const problems = new Set<string>();
  if (variables.kind === 'failed') problems.add(describeEntryFailure(variables.failure));
  if (declarations.kind === 'failed') problems.add(describeEntryFailure(declarations.failure));
  if (variableValues.kind === 'store-unreadable') problems.add(variableValues.reason);
  if (secrets.kind === 'store-unreadable') problems.add(secrets.reason);
  if (teamEnv.inheritedValues.kind === 'store-unreadable') problems.add(teamEnv.inheritedValues.reason);
  // A part that can't be resolved keeps what its last pull wrote everywhere (`appliedTeamEnv`): by key only.
  for (const [kept, pull] of [[teamEnv.keptValues, 'the last pull'], [teamEnv.keptInheritedValues, "the user scope's last pull"]] as const) {
    if (kept && kept.size > 0) problems.add(`Until it is fixed, shells, MCP servers and \`teamai env exec\` use the values ${pull} wrote for ${[...kept.keys()].join(', ')}.`);
  }

  const declared = declarations.kind === 'resolved' ? declarations.entries.filter(({ name }) => !isReservedTeamEnvKey(name)) : [];
  const secretKeys = declaredSecretKeys(declarations) ?? new Set<string>();
  // What shells, MCP and `env exec` receive: the project's variables and those it inherits from the user scope.
  const inherited = new Set(teamEnv.inheritedVariables);
  // A key a workspace holds back (#913) has the value its last pull installed, which records no file or description.
  const held = new Set(variables.kind === 'resolved' ? variables.held ?? [] : []);
  const received = effectiveTeamEnvVariables(teamEnv).filter((variable) => !secretKeys.has(variable.name) && !isReservedTeamEnvKey(variable.name));
  const lines: EnvListingLine[] = [];
  const line = (text: string): void => { lines.push({ text, detail: false }); };
  const detail = (text: string | undefined): void => { if (text && options.verbose) lines.push({ text: `    ${text}`, detail: true }); };
  let revealed = false;
  // A value set as the other kind is not used (secret-store.ts); `env set` again stores it as this one.
  const stale = (key: string, now: 'secret' | 'env variable'): void => {
    const kind = staleEntries.get(key);
    if (!kind) return;
    line(
      `    Your value for this team was set while ${key} was ${kind === 'secret' ? 'a secret' : 'an env variable'}, so it is not used. `
        + `Run \`teamai env unset ${key}\` to remove it, then \`teamai env set ${key}\` to set one for the ${now}.`,
    );
  };

  if (received.length > 0) {
    line(`Team env variables (${received.length}):`);
    line('');
    for (const variable of received) {
      const isInherited = inherited.has(variable);
      const isHeld = !isInherited && held.has(variable.name);
      const origin = `(${isInherited ? 'user scope' : isHeld ? 'held back' : describeOrigin(variable)})`;
      // Each part by its own scope's state, as `env exec` applies it (`appliedTeamEnv`):
      // what its last pull wrote while its own env can't be resolved, by name only.
      const values = isInherited ? teamEnv.inheritedValues : variableValues;
      if (isInherited ? values.kind === 'store-unreadable' : declarations.kind === 'failed') {
        line(`  ${variable.name}  ${origin}`);
      } else if (values.kind === 'store-unreadable') {
        line(`  ${variable.name}  unreadable  ${origin}`);
      } else {
        const resolved = values.values.get(variable.name);
        const value = resolved?.value ?? variable.entry.value;
        revealed ||= options.reveal === true;
        const source = resolved?.source ?? 'env.yaml';
        line(`  ${variable.name}=${options.reveal ? value : maskEnvValue(value)}  ${isHeld && source === 'env.yaml' ? 'installed' : source}  ${origin}`);
        if (!inherited.has(variable)) stale(variable.name, 'env variable');
      }
      detail(variable.entry.description);
    }
    line('');
  }
  if (declared.length > 0) {
    line(`Team secrets (${declared.length}):`);
    line('');
    for (const secret of declared) {
      line(`  ${secret.name}  ${secretState(secrets, secret.name)}  (${describeOrigin(secret)})`);
      stale(secret.name, 'secret');
      detail(secret.entry.description);
      detail(secret.entry.url);
    }
    line('');
  }
  return { problems: [...problems], lines, revealed, hasSecrets: declared.length > 0 };
}
