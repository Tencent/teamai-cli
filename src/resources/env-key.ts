/**
 * A key env.sh writes (`generateEnvFile`) and the only shape it reads back
 * (`parseEnvFile`), in resources/env.ts.
 *
 * Shared by both on purpose: the write side has to reject exactly what the
 * read side skips, or a variable can exist in env.sh that the CLI can never
 * see again. Its own module so secrets.ts and secret-store.ts can import it
 * without importing env.ts, which imports them.
 */
export const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * A table keyed by env names, built without a prototype: `__proto__` passes
 * ENV_KEY_RE, and on an ordinary object assigning it hits the inherited
 * setter and reading it when unset returns `Object.prototype`.
 */
export function envTable<V>(entries: Iterable<readonly [string, V]> = []): Record<string, V> {
  const table: Record<string, V> = Object.create(null);
  for (const [key, value] of entries) table[key] = value;
  return table;
}

/** `env[key]` when `key` is set: an unset `__proto__` would read `Object.prototype`. */
export function envValue(env: NodeJS.ProcessEnv, key: string): string | undefined {
  return Object.hasOwn(env, key) ? env[key] : undefined;
}

/** `key` as the platform compares environment names: case-insensitively on Windows. */
export function envName(key: string): string {
  return process.platform === 'win32' ? key.toUpperCase() : key;
}

/** The name in `names` that is the same environment variable as `key` (in any case on Windows), if any. */
export function sameEnvName(names: Iterable<string>, key: string): string | undefined {
  const name = envName(key);
  for (const other of names) if (envName(other) === name) return other;
  return undefined;
}
