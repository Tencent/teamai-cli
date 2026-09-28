/**
 * The values a member keeps for their team's declared secrets (#875), on their
 * own machine and never in the team repo: one file per team repo at
 * `~/.teamai/secrets/teams/<team>-<hash>.json`, named the way `teamai models
 * configure` names its team key files, and one for every team on the machine
 * at `~/.teamai/secrets/machine.json`. `~/.teamai/env` is not used: it is
 * already the user scope's env backup file.
 *
 * Each entry is exactly one of a literal value or the name of a variable to
 * read when the value is used (`--from-env`), so no copy of it is stored.
 */
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { getTeamValuesPath } from './models/profile.js';
import { ENV_KEY_RE } from './resources/env-key.js';
import { getTeamaiHomeDir, type LocalConfig } from './types.js';
import { writeJsonAtomic } from './utils/fs.js';
import { jsonSyntaxErrorOffset, lineAndColumn } from './utils/json-position.js';

const StoredSecretSchema = z.union([
  z.object({ value: z.string() }).strict(),
  z.object({ env: z.string().regex(ENV_KEY_RE) }).strict(),
]);
export type StoredSecret = z.infer<typeof StoredSecretSchema>;

const SecretStoreSchema = z.record(z.string().regex(ENV_KEY_RE), StoredSecretSchema);
export type SecretStore = Record<string, StoredSecret>;

/** A store file's entries, or why it cannot be used. A missing file holds none. */
export type SecretStoreRead =
  | { readonly ok: true; readonly values: SecretStore }
  | { readonly ok: false; readonly reason: string };

/** This team's values file. */
export function getTeamSecretsPath(localConfig: LocalConfig): string {
  return getTeamValuesPath(localConfig, path.join(getTeamaiHomeDir(), 'secrets', 'teams'));
}

/** The values file for every team on this machine (`teamai env set --global`). */
export function getMachineSecretsPath(): string {
  return path.join(getTeamaiHomeDir(), 'secrets', 'machine.json');
}

/**
 * Read a store file. A file that does not parse, or holds an entry that is not
 * one `value` or one `env`, is reported by path and position only: the
 * parser's own message quotes the text around the problem, which may be a
 * value.
 */
export async function readSecretStore(filePath: string): Promise<SecretStoreRead> {
  let content: string;
  try {
    content = await fs.promises.readFile(filePath, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return { ok: true, values: {} };
    return { ok: false, reason: `Cannot read your secret values at ${filePath} (${code ?? 'unknown error'}).` };
  }
  const fix = 'Fix the file, or delete it and set the values again with `teamai env set`.';
  const offset = jsonSyntaxErrorOffset(content);
  if (offset !== null) {
    const { line, column } = lineAndColumn(content, offset);
    return { ok: false, reason: `${filePath} is not valid JSON (line ${line}, column ${column}). ${fix}` };
  }
  const raw: unknown = JSON.parse(content);
  const parsed = SecretStoreSchema.safeParse(raw);
  if (parsed.success) return { ok: true, values: parsed.data };
  const name = parsed.error.issues[0]?.path[0];
  const entry = typeof name === 'string' && raw !== null && typeof raw === 'object' ? Object.keys(raw).indexOf(name) + 1 : 0;
  return {
    ok: false,
    reason: `${filePath} ${entry > 0 ? `has an invalid entry (entry ${entry})` : 'is not a JSON object'}: `
      + `each entry maps a variable name to {"value": "..."} or {"env": "VAR"}. ${fix}`,
  };
}

/** Write a store file atomically, readable by this user only. */
export async function writeSecretStore(filePath: string, values: SecretStore): Promise<void> {
  await writeJsonAtomic(filePath, SecretStoreSchema.parse(values), { mode: 0o600 });
}

/** The value an entry stands for now: a `--from-env` reference is read from `env` each time. Empty is none. */
export function storedSecretValue(entry: StoredSecret, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const value = 'value' in entry ? entry.value : env[entry.env];
  return value === undefined || value === '' ? undefined : value;
}
