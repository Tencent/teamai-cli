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
import YAML from 'yaml';
import { z } from 'zod';
import {
  entryLayout, missingTopLevelKeyReason, readEntryFileText, resolveEntries, resolveEntriesFor, unknownEntryKeys,
  type EntryLayout, type EntryReader, type EntryResolution,
} from '../namespaced-entries.js';
import type { LocalConfig } from '../types.js';
import { ENV_KEY_RE } from './env.js';

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

/** `env/secrets.yaml` and `env/<ns>/secrets.yaml`, active through `resources.env`. */
export const SECRETS_LAYOUT: EntryLayout = {
  ...entryLayout('env'),
  file: 'secrets.yaml',
  label: 'secrets',
  noun: 'secret',
  kept: 'Team secrets were not resolved this run; env variables are not affected.',
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
 * The secrets this member's scope declares: `absent` when none of the files it
 * reads exists, else the resolution. A failed resolution is never "no
 * secrets": a consumer that took it for none would drop what a member set.
 */
export type SecretDeclarations = { readonly kind: 'absent' } | EntryResolution<SecretDeclaration>;

/**
 * Resolve the secret declarations for this member. `active` is env's active
 * namespaces when the caller already has them (pull); otherwise they are
 * resolved from `resources.env`.
 */
export async function resolveSecretDeclarations(
  localConfig: LocalConfig,
  active?: readonly string[] | null,
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
  const resolution = active === undefined
    ? await resolveEntriesFor(reader, localConfig)
    : await resolveEntries(reader, localConfig, active);
  return resolution.kind === 'resolved' && !found ? { kind: 'absent' } : resolution;
}

/**
 * Where a declared secret's value comes from for this member. An empty value
 * in the environment is no value.
 */
export type SecretState = 'environment' | 'missing';

export function secretState(key: string, env: NodeJS.ProcessEnv = process.env): SecretState {
  const value = env[key];
  return value !== undefined && value !== '' ? 'environment' : 'missing';
}
