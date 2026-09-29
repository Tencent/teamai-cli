/**
 * Team secrets (#875): env keys a team declares without a value, in
 * `env/secrets.yaml` and `env/<ns>/secrets.yaml`, activated by `resources.env`
 * like `env/<ns>/env.yaml`. A namespace entry replaces the root entry with the
 * same key. Each member supplies the value on their own machine; the repo only
 * says which keys exist, what they are for and where to get one.
 *
 * The file is separate from env.yaml so an older CLI, which reads only
 * env.yaml, ignores it, and `env add` / `env remove` on an older CLI cannot
 * drop it by rewriting env.yaml.
 */
import path from 'node:path';
import YAML from 'yaml';
import { z } from 'zod';
import {
  entryLayout, missingTopLevelKeyReason, readEntryFileText, resolveEntries, resolveEntriesFor, unknownEntryKeys,
  writtenList, type EntryLayout, type EntryReader, type EntryResolution,
} from '../namespaced-entries.js';
import type { LocalConfig } from '../types.js';
import { ensureDir, readFileSafe, writeFile } from '../utils/fs.js';
import { ENV_KEY_RE, envName } from './env-key.js';

const SecretDeclarationSchema = z.object({
  key: z.string().regex(ENV_KEY_RE, 'must be a shell variable name: letters, digits and underscores, not starting with a digit'),
  description: z.string().optional(),
  /** Where a member gets a value. */
  url: z.string().optional(),
});

const SecretsYamlSchema = z.object({
  secrets: z.array(SecretDeclarationSchema).default([]),
});

export type SecretDeclaration = z.infer<typeof SecretDeclarationSchema>;

/** The keys `declaration` was written with that secrets.yaml does not know: that secret is not declared. */
export function unknownSecretDeclarationKeys(declaration: object): string[] {
  return Object.keys(declaration).filter((key) => !Object.hasOwn(SecretDeclarationSchema.shape, key));
}

/** `env/secrets.yaml` and `env/<ns>/secrets.yaml`, active through `resources.env`. */
export const SECRETS_LAYOUT: EntryLayout = {
  ...entryLayout('env'),
  file: 'secrets.yaml',
  label: 'secrets',
  noun: 'secret',
  kept: 'Team secrets were not resolved this run; env variables and MCP servers stay as they are.',
};

/**
 * How the secrets files are read. A file without a top-level `secrets:` key
 * is broken, not empty, as for env.yaml (#662). A key the schema does not
 * know, `value:` included, keeps that secret from being declared: a value
 * does not belong in the repo.
 */
export const secretsEntryReader: EntryReader<SecretDeclaration> = {
  type: 'env',
  layout: SECRETS_LAYOUT,
  async read(absolutePath, relativePath) {
    const file = await readEntryFileText(absolutePath, relativePath);
    if (!file.ok) return file;
    if (file.text === null) return null;
    let raw: unknown;
    try {
      raw = YAML.parse(file.text);
    } catch (e) {
      return { ok: false, reason: `${relativePath} is not valid YAML: ${e instanceof Error ? e.message : String(e)}` };
    }
    if (raw === null || raw === undefined) return { ok: true, entries: [] };
    const shapeProblem = missingTopLevelKeyReason(raw, SecretsYamlSchema);
    if (shapeProblem) return { ok: false, reason: `${relativePath} declares no secrets: ${shapeProblem}` };
    const parsed = SecretsYamlSchema.safeParse(raw);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; ');
      return { ok: false, reason: `${relativePath} does not match the secrets.yaml schema: ${issues}` };
    }
    const entries = parsed.data.secrets;
    return { ok: true, entries, unknownKeys: unknownEntryKeys(raw, 'secrets', entries, SecretDeclarationSchema) };
  },
  nameOf: (secret) => secret.key,
  scopeOf: () => ({}),
};

/**
 * A secrets file's declarations as written, for `env add --secret` and
 * `env remove`: every key an entry was written with is kept, so a rewrite
 * drops nothing the file had. A file that does not parse gives its reason:
 * writing back what could be read would drop every declaration it has.
 */
export async function readSecretsForEdit(
  absolutePath: string,
  relativePath: string,
): Promise<{ ok: true; secrets: Record<string, unknown>[] } | { ok: false; reason: string }> {
  const read = await secretsEntryReader.read(absolutePath, relativePath);
  if (read === null) return { ok: true, secrets: [] };
  if (!read.ok) return read;
  const text = await readFileSafe(absolutePath);
  const written = writtenList(text === null ? null : YAML.parse(text), 'secrets');
  const isEntry = (entry: unknown): entry is Record<string, unknown> => entry !== null && typeof entry === 'object';
  return { ok: true, secrets: Array.isArray(written) ? written.filter(isEntry) : [] };
}

/** Write a secrets file with these declarations and nothing else. */
export async function writeSecretsFile(absolutePath: string, secrets: readonly object[]): Promise<void> {
  await ensureDir(path.dirname(absolutePath));
  await writeFile(absolutePath, YAML.stringify({ secrets }));
}

/**
 * The secrets this member's scope declares: `absent` when none of the files it
 * reads exists, else the resolution. A failed resolution is never "no
 * secrets": a consumer that took it for none would drop what a member set.
 */
export type SecretDeclarations = { readonly kind: 'absent' } | EntryResolution<SecretDeclaration>;

/**
 * Env's active namespaces as a caller that already resolved them has them
 * (pull's role context); `active` is null in legacy mode, which reads the root
 * file alone.
 */
export interface KnownNamespaces {
  readonly active: readonly string[] | null;
}

/**
 * Resolve the secret declarations for this member, in env's active namespaces:
 * `namespaces` when the caller has them, else resolved from `resources.env`.
 */
export async function resolveSecretDeclarations(
  localConfig: LocalConfig,
  namespaces?: KnownNamespaces,
): Promise<SecretDeclarations> {
  let found = false;
  const reader: EntryReader<SecretDeclaration> = {
    ...secretsEntryReader,
    async read(absolutePath, relativePath) {
      const read = await secretsEntryReader.read(absolutePath, relativePath);
      if (read !== null) found = true;
      return read;
    },
  };
  const resolution = namespaces
    ? await resolveEntries(reader, localConfig, namespaces.active)
    : await resolveEntriesFor(reader, localConfig);
  return resolution.kind === 'resolved' && !found ? { kind: 'absent' } : resolution;
}

/**
 * The keys `declarations` declares, or null when they failed: a failed file is
 * never "no secrets". Its `has` matches a key in any case on Windows, where
 * `token` in env.yaml is the same environment variable as a declared `TOKEN`.
 */
export function declaredSecretKeys(declarations: Exclude<SecretDeclarations, { kind: 'failed' }>): ReadonlySet<string>;
export function declaredSecretKeys(declarations: SecretDeclarations): ReadonlySet<string> | null;
export function declaredSecretKeys(declarations: SecretDeclarations): ReadonlySet<string> | null {
  if (declarations.kind === 'failed') return null;
  const keys = new Set(declarations.kind === 'resolved' ? declarations.entries.map((entry) => entry.name) : []);
  const names = new Set([...keys].map(envName));
  return Object.assign(keys, { has: (key: string): boolean => names.has(envName(key)) });
}
