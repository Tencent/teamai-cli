import path from 'node:path';
import { homedir } from 'node:os';

/**
 * Resolve the Hermes agent home directory.
 *
 * Mirrors Hermes' own `get_hermes_home()` semantics: honor the
 * `HERMES_HOME` environment variable when set, otherwise fall back
 * to `~/.hermes`.
 */
export function getHermesHome(): string {
  const fromEnv = process.env.HERMES_HOME;
  if (fromEnv && fromEnv.trim() !== '') {
    return path.resolve(fromEnv);
  }
  return path.join(homedir(), '.hermes');
}
