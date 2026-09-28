/**
 * The values a member keeps for their team's declared secrets (#875), on their
 * own machine and never in the team repo: one file per team repo at
 * `~/.teamai/secrets/teams/<hash>.json`, named by the hash of the repository
 * identity alone so renaming `team:` in `teamai.yaml` keeps the values, and
 * one for every team on the machine at `~/.teamai/secrets/machine.json`. `~/.teamai/env` is not used: it is
 * already the user scope's env backup file.
 *
 * Each entry is exactly one of a literal value or the name of a variable to
 * read when the value is used (`--from-env`), so no copy of it is stored, and
 * says what it is (`kind`): a secret's value, or the member's override of an
 * env variable, as the scope declared the key when `env set` wrote it. A
 * secret's value stays one after the team stops declaring the key, so it is
 * never exported as a variable. An entry without `kind` (earlier builds) is a
 * secret's.
 */
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { getTeamRepoHash } from './models/profile.js';
import { ENV_KEY_RE, envTable, envValue } from './resources/env-key.js';
import { getTeamaiHomeDir, type LocalConfig } from './types.js';
import { acquireLock, releaseLock } from './update.js';
import { writeJsonAtomic } from './utils/fs.js';

const StoredEntryKindSchema = z.enum(['secret', 'variable']);
export type StoredEntryKind = z.infer<typeof StoredEntryKindSchema>;

const StoredSecretSchema = z.union([
  z.object({ value: z.string(), kind: StoredEntryKindSchema.optional() }).strict(),
  z.object({ env: z.string().regex(ENV_KEY_RE), kind: StoredEntryKindSchema.optional() }).strict(),
]);
export type StoredSecret = z.infer<typeof StoredSecretSchema>;

/** What an entry is; one without `kind` is a secret's, the side that never exports it. */
export function storedEntryKind(entry: StoredSecret): StoredEntryKind {
  return entry.kind ?? 'secret';
}

// Not z.record: it drops a `__proto__` key, which ENV_KEY_RE accepts.
const SecretStoreSchema = z
  .custom<object>((raw) => raw !== null && typeof raw === 'object' && !Array.isArray(raw))
  .transform((raw) => Object.entries(raw))
  .pipe(z.array(z.tuple([z.string().regex(ENV_KEY_RE), StoredSecretSchema])))
  .transform((entries) => envTable(entries));
export type SecretStore = z.infer<typeof SecretStoreSchema>;

/** A store file's entries, or why it cannot be used. A missing file holds none. */
export type SecretStoreRead =
  | { readonly ok: true; readonly values: SecretStore }
  | { readonly ok: false; readonly reason: string };

/** This team's values file. */
export function getTeamSecretsPath(localConfig: LocalConfig): string {
  return path.join(getTeamaiHomeDir(), 'secrets', 'teams', `${getTeamRepoHash(localConfig)}.json`);
}

/** The values file for every team on this machine (`teamai env set --global`). */
export function getMachineSecretsPath(): string {
  return path.join(getTeamaiHomeDir(), 'secrets', 'machine.json');
}

/**
 * Read a store file. A file that does not parse is reported by its path only,
 * one with an entry that is not one `value` or one `env` by the entry's
 * number: the parser's own message quotes the text around the problem, which
 * may be a value.
 */
export async function readSecretStore(filePath: string): Promise<SecretStoreRead> {
  let content: string;
  try {
    content = await fs.promises.readFile(filePath, 'utf8');
  } catch (error) {
    const code = error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : undefined;
    if (code === 'ENOENT') return { ok: true, values: {} };
    return {
      ok: false,
      reason: `Cannot read your secret values at ${filePath} (${code ?? 'unknown error'}). Check that the file is yours and `
        + `readable (\`ls -l ${filePath}\`), or delete it and set the values again with \`teamai env set\`.`,
    };
  }
  const fix = 'Fix the file, or delete it and set the values again with `teamai env set`.';
  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch {
    return { ok: false, reason: `${filePath} is not valid JSON. ${fix}` };
  }
  const parsed = SecretStoreSchema.safeParse(raw);
  if (parsed.success) return { ok: true, values: parsed.data };
  const index = parsed.error.issues[0]?.path[0];
  const entry = typeof index === 'number' ? index + 1 : 0;
  return {
    ok: false,
    reason: `${filePath} ${entry > 0 ? `has an invalid entry (entry ${entry})` : 'is not a JSON object'}: `
      + `each entry maps a variable name to {"value": "..."} or {"env": "VAR"}, with an optional "kind" of "secret" or "variable". ${fix}`,
  };
}

/** Write a store file atomically, readable by this user only. */
export async function writeSecretStore(filePath: string, values: SecretStore): Promise<void> {
  await writeJsonAtomic(filePath, SecretStoreSchema.parse(values), { mode: 0o600 });
}

/** What `updateSecretStore` did. */
export type SecretStoreUpdate =
  | { readonly kind: 'written' }
  | { readonly kind: 'unchanged' }
  | { readonly kind: 'failed'; readonly reason: string };

/**
 * Change a store file under its lock (`<file>.lock`), so two `env set` or
 * `env unset` runs at once both land: the file is read inside the lock, and
 * `change` returns the new entries, or null to leave it as it is.
 */
export async function updateSecretStore(
  filePath: string,
  change: (values: SecretStore) => SecretStore | null,
): Promise<SecretStoreUpdate> {
  const lock = `${filePath}.lock`;
  let held = false;
  for (let attempt = 0; attempt < 100 && !held; attempt++) {
    held = await acquireLock(lock);
    if (!held) await new Promise((resolve) => setTimeout(resolve, 50));
  }
  if (!held) {
    return {
      kind: 'failed',
      reason: `Another teamai command is changing ${filePath}. Run the command again once it has finished.`,
    };
  }
  try {
    const store = await readSecretStore(filePath);
    if (!store.ok) return { kind: 'failed', reason: store.reason };
    const next = change(store.values);
    if (!next) return { kind: 'unchanged' };
    await writeSecretStore(filePath, next);
    return { kind: 'written' };
  } finally {
    await releaseLock(lock);
  }
}

/** The value an entry stands for now: a `--from-env` reference is read from `env` each time. Empty is none. */
export function storedSecretValue(entry: StoredSecret, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const value = 'value' in entry ? entry.value : envValue(env, entry.env);
  return value === undefined || value === '' ? undefined : value;
}
