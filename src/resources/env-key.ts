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
