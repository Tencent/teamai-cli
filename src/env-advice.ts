/**
 * What a member is told to do about an env key a workflow step requires and
 * this machine has no value for (#1513).
 *
 * `teamai env set KEY` only works for a key the team declares, as a secret or
 * as an env variable, so advice that names it for a key the team does not
 * declare sends the member to a command that exits 1. The advice here names
 * the command only for the keys it works for, and the environment for the
 * rest, which always works.
 */
import { sameEnvName } from './resources/env-key.js';

/**
 * How to give each of `keys` a value here, as one clause: `teamai env set KEY`
 * for a key the team declares, and the environment for a key it does not, with
 * the team repo named as where such a key is declared.
 *
 * `declared` is the keys the team declares here, as `EnvFacts` holds them.
 */
export function envValueAdvice(keys: readonly string[], declared: ReadonlySet<string>): string {
  const known: string[] = [];
  const unknown: string[] = [];
  for (const key of keys) (sameEnvName(declared, key) === undefined ? unknown : known).push(key);
  const one = keys.length === 1;
  const pronoun = one ? 'it' : 'them';
  const sets = known.map((key) => `teamai env set ${key}`).join(', ');
  const adds = unknown.map((key) => `teamai env add ${key} --secret`).join(', ');
  if (unknown.length === 0) {
    return `Run ${sets}, or set ${pronoun} in the environment`;
  }
  if (known.length === 0) {
    return `Set ${pronoun} in the environment, or declare ${pronoun} in the team repo (${adds})`;
  }
  return `Run ${sets}, or set ${unknown.join(', ')} in the environment, `
    + `or declare ${unknown.join(', ')} in the team repo (${adds})`;
}
