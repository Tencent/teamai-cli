/**
 * One scope's env as `teamai env list` and `teamai list env` show it (#875):
 * the env.yaml variables it receives, each with the value it resolves to and
 * where that comes from (`team` for the member's value, `env.yaml`), then the
 * secrets it declares, each with where its value comes from, never the value.
 * A key declared as a secret is listed only as one: its env.yaml value is not
 * delivered.
 *
 * A value nobody can tell is not shown: while the declarations fail, any
 * variable may be a secret whose repo value is ignored, and while the member's
 * values can't be read, a variable's value is `unreadable`, as a secret's is.
 */
import { secretState, type TeamEnv } from './env-resolution.js';
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

  const declared = declarations.kind === 'resolved' ? declarations.entries.filter(({ name }) => !isReservedTeamEnvKey(name)) : [];
  const secretKeys = declaredSecretKeys(declarations) ?? new Set<string>();
  const received = (variables.kind === 'resolved' ? variables.entries : []).filter((variable) => !secretKeys.has(variable.name) && !isReservedTeamEnvKey(variable.name));
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
      const origin = `(${describeOrigin(variable)})`;
      if (declarations.kind === 'failed') {
        line(`  ${variable.name}  ${origin}`);
      } else if (variableValues.kind === 'store-unreadable') {
        line(`  ${variable.name}  unreadable  ${origin}`);
      } else {
        const resolved = variableValues.values.get(variable.name);
        const value = resolved?.value ?? variable.entry.value;
        revealed ||= options.reveal === true;
        line(`  ${variable.name}=${options.reveal ? value : maskEnvValue(value)}  ${resolved?.source ?? 'env.yaml'}  ${origin}`);
        stale(variable.name, 'env variable');
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
