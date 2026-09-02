/**
 * Config service — the only writer of local teamai config for both the
 * `teamai config` CLI family and the Config WebUI. Reads go through
 * readConfigBundle(); every write goes through applyConfigPatch(), which
 * enforces the field registry (src/config-fields.ts) + zod validation, so no
 * ad-hoc YAML writes exist anywhere in the UI layer.
 */
import type { Scope, LocalConfig, TeamaiConfig, State } from './types.js';
import { LocalConfigSchema } from './types.js';
import {
  loadLocalConfigForScope,
  saveLocalConfigForScope,
  loadStateForScope,
  loadTeamConfig,
} from './config.js';
import {
  CONFIG_FIELDS,
  ConfigFieldError,
  findFieldSpec,
  type ConfigFieldSpec,
  type DynamicOptions,
} from './config-fields.js';
import { loadRolesManifest, listRoleIds } from './roles.js';
import { loadTagsConfig } from './utils/tags.js';
import { getHandler } from './resources/index.js';
import { createGit } from './utils/git.js';

// ─── Types ────────────────────────────────────────────────

export interface ResolvedField {
  spec: ConfigFieldSpec;
  value: unknown;
  source: 'user' | 'project' | 'team-default' | 'unset';
}

export interface DynamicOptionsBundle {
  roles: string[];
  tags: string[];
  skills: string[];
}

export interface ConfigBundle {
  scope: Scope;
  localConfig: LocalConfig;
  /** Read-only view; null when the clone has no teamai.yaml. */
  teamConfig: TeamaiConfig | null;
  /** Read-only view of state.json. */
  state: State;
  /** Registry resolved for this scope. */
  fields: ResolvedField[];
  /** dynamicOptions sources for select/chips editors. */
  options: DynamicOptionsBundle;
}

export interface ApplyResult {
  ok: boolean;
  config?: LocalConfig;
  /** Per-field errors, incl. mapped zod issues and afterSave failures. */
  errors: Array<{ key: string; message: string }>;
}

/** Thrown by both entry points when the requested scope has no install. */
export class NotInitializedError extends Error {
  constructor(scope: Scope, projectRoot?: string) {
    super(
      scope === 'project'
        ? `teamai is not initialized in project scope${projectRoot ? ` at ${projectRoot}` : ''}. Run \`teamai init\` first.`
        : 'teamai is not initialized. Run `teamai init` first.',
    );
    this.name = 'NotInitializedError';
  }
}

// ─── Deep get/set on plain config objects ─────────────────

function deepGet(obj: unknown, key: string): unknown {
  let cur: unknown = obj;
  for (const part of key.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

function deepSet<T extends object>(obj: T, key: string, value: unknown): T {
  const parts = key.split('.');
  const clone: Record<string, unknown> = { ...(obj as Record<string, unknown>) };
  let cur: Record<string, unknown> = clone;
  for (let i = 0; i < parts.length - 1; i++) {
    const next = cur[parts[i]];
    cur[parts[i]] = { ...((next ?? {}) as Record<string, unknown>) };
    cur = cur[parts[i]] as Record<string, unknown>;
  }
  const last = parts[parts.length - 1];
  if (value === undefined) {
    delete cur[last];
  } else {
    cur[last] = value;
  }
  return clone as T;
}

/** A key counts as "set" only when it holds a real value (empty array = unset). */
function isMeaningful(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (Array.isArray(value) && value.length === 0) return false;
  return true;
}

// ─── Value normalization (by field type) ──────────────────

function normalizeString(spec: ConfigFieldSpec, raw: unknown): string {
  if (typeof raw !== 'string') {
    throw new ConfigFieldError(spec.key, `Expected a string value for ${spec.key}`);
  }
  return raw.trim();
}

function normalizeEnum(spec: ConfigFieldSpec, raw: unknown): string {
  const value = normalizeString(spec, raw);
  if (spec.enumValues && !spec.enumValues.includes(value)) {
    throw new ConfigFieldError(
      spec.key,
      `Invalid value "${value}" for ${spec.key}. Valid: ${spec.enumValues.join(', ')}`,
    );
  }
  return value;
}

function normalizeBoolean(spec: ConfigFieldSpec, raw: unknown): boolean {
  if (raw === true || raw === 'true') return true;
  if (raw === false || raw === 'false') return false;
  throw new ConfigFieldError(spec.key, `Expected true/false for ${spec.key}`);
}

function normalizeBooleanTri(spec: ConfigFieldSpec, raw: unknown): boolean | undefined {
  if (raw === 'unset' || raw === null || raw === '') return undefined;
  return normalizeBoolean(spec, raw);
}

function normalizeStringArray(spec: ConfigFieldSpec, raw: unknown): string[] {
  let list: unknown[];
  if (Array.isArray(raw)) {
    list = raw;
  } else if (typeof raw === 'string') {
    const s = raw.trim();
    if (!s) return [];
    if (s.startsWith('[')) {
      try {
        list = JSON.parse(s);
      } catch {
        throw new ConfigFieldError(spec.key, `Invalid JSON array for ${spec.key}: ${s}`);
      }
      if (!Array.isArray(list)) {
        throw new ConfigFieldError(spec.key, `Expected a JSON array for ${spec.key}`);
      }
    } else {
      list = s.split(',');
    }
  } else {
    throw new ConfigFieldError(spec.key, `Expected an array (or JSON/comma-separated string) for ${spec.key}`);
  }
  const out: string[] = [];
  for (const item of list) {
    if (typeof item !== 'string') {
      throw new ConfigFieldError(spec.key, `Expected string items in ${spec.key}`);
    }
    const trimmed = item.trim();
    if (trimmed && !out.includes(trimmed)) out.push(trimmed);
  }
  return out.sort();
}

/** Parse a raw CLI/UI value into the field's canonical type. */
export function normalizeFieldValue(spec: ConfigFieldSpec, raw: unknown): unknown {
  switch (spec.type) {
    case 'string': return normalizeString(spec, raw);
    case 'enum': return normalizeEnum(spec, raw);
    case 'boolean': return normalizeBoolean(spec, raw);
    case 'boolean-tri': return normalizeBooleanTri(spec, raw);
    case 'string[]': return normalizeStringArray(spec, raw);
  }
}

// ─── Dynamic options ──────────────────────────────────────

export async function resolveDynamicOptions(localConfig: LocalConfig): Promise<DynamicOptionsBundle> {
  let roles: string[] = [];
  try {
    const manifest = await loadRolesManifest(localConfig.repo.localPath);
    roles = listRoleIds(manifest);
  } catch {
    roles = [];
  }

  let tags: string[] = [];
  try {
    const tagsConfig = await loadTagsConfig(localConfig.repo.localPath);
    if (tagsConfig) {
      tags = [...new Set([...Object.values(tagsConfig.skills), ...Object.values(tagsConfig.rules)].flat())].sort();
    }
  } catch {
    tags = [];
  }

  let skills: string[] = [];
  try {
    const items = await getHandler('skills').scanTeamForPull({} as TeamaiConfig, localConfig);
    skills = items.map((i) => i.name).sort();
  } catch {
    skills = [];
  }

  return { roles, tags, skills };
}

/** Membership validation for dynamicOptions fields (roles / tags). */
async function validateDynamicMembership(
  spec: ConfigFieldSpec,
  localConfig: LocalConfig,
  value: unknown,
): Promise<void> {
  if (!spec.dynamicOptions) return;
  const values = Array.isArray(value) ? value : value === undefined || value === '' ? [] : [value];
  if (values.length === 0) return;

  if (spec.dynamicOptions === 'roles') {
    let roleIds: string[];
    try {
      roleIds = listRoleIds(await loadRolesManifest(localConfig.repo.localPath));
    } catch (e) {
      throw new ConfigFieldError(
        spec.key,
        `Cannot validate ${spec.key}: roles manifest unavailable (${(e as Error).message})`,
      );
    }
    for (const v of values) {
      if (!roleIds.includes(String(v))) {
        throw new ConfigFieldError(
          spec.key,
          `Unknown role "${v}" for ${spec.key}. Valid roles: ${roleIds.join(', ')}`,
        );
      }
    }
    return;
  }

  if (spec.dynamicOptions === 'tags') {
    const tagsConfig = await loadTagsConfig(localConfig.repo.localPath);
    if (!tagsConfig) return; // no tags.yaml → nothing to validate against
    const known = new Set([...Object.values(tagsConfig.skills), ...Object.values(tagsConfig.rules)].flat());
    for (const v of values) {
      if (!known.has(String(v))) {
        throw new ConfigFieldError(
          spec.key,
          `Unknown tag "${v}" for ${spec.key}. Valid tags: ${[...known].sort().join(', ')}`,
        );
      }
    }
  }
}

// ─── readConfigBundle ─────────────────────────────────────

function teamDefaultFor(key: string, teamConfig: TeamaiConfig | null): { has: boolean; value?: unknown } {
  if (!teamConfig) return { has: false };
  if (key === 'recallEnabled') {
    return { has: true, value: teamConfig.sharing?.recall?.enabled ?? false };
  }
  if (key === 'coAuthorEnabled') {
    const v = teamConfig.sharing?.coAuthor?.enabled;
    return v === undefined ? { has: false } : { has: true, value: v };
  }
  return { has: false };
}

/**
 * Load the full config view for a scope: local config, team config (read-only),
 * state, registry-resolved fields with source attribution, and dynamicOptions.
 */
export async function readConfigBundle(scope: Scope, projectRoot?: string): Promise<ConfigBundle> {
  const localConfig = await loadLocalConfigForScope(scope, projectRoot);
  if (!localConfig) throw new NotInitializedError(scope, projectRoot);

  const teamConfig = await loadTeamConfig(localConfig.repo.localPath);
  const state = await loadStateForScope(scope, projectRoot);
  const options = await resolveDynamicOptions(localConfig);

  // Source attribution: project scope falls back to the user config for
  // display ("inherited" value); both fall back to the team default.
  const userConfig = scope === 'project' ? await loadLocalConfigForScope('user') : null;

  const fields: ResolvedField[] = CONFIG_FIELDS.map((spec) => {
    const own = deepGet(localConfig, spec.key);
    if (isMeaningful(own)) {
      return { spec, value: own, source: scope } as ResolvedField;
    }
    if (scope === 'project' && userConfig) {
      const inherited = deepGet(userConfig, spec.key);
      if (isMeaningful(inherited)) {
        return { spec, value: inherited, source: 'user' } as ResolvedField;
      }
    }
    const teamDefault = teamDefaultFor(spec.key, teamConfig);
    if (teamDefault.has) {
      return { spec, value: teamDefault.value, source: 'team-default' } as ResolvedField;
    }
    return { spec, value: own ?? undefined, source: 'unset' } as ResolvedField;
  });

  return { scope, localConfig, teamConfig, state, fields, options };
}

// ─── applyConfigPatch ─────────────────────────────────────

/**
 * Ordered pipeline per key: find spec → readOnly/scope reject → normalize →
 * dynamicOptions membership → spec.apply ?? deep-set → LocalConfigSchema.parse
 * → saveLocalConfigForScope → spec.afterSave sequentially.
 *
 * Any pre-save failure aborts the whole patch (nothing written). An afterSave
 * failure is reported in errors[] but the config write stands.
 */
export async function applyConfigPatch(
  scope: Scope,
  updates: Record<string, unknown>,
  projectRoot?: string,
): Promise<ApplyResult> {
  const current = await loadLocalConfigForScope(scope, projectRoot);
  if (!current) throw new NotInitializedError(scope, projectRoot);

  const errors: ApplyResult['errors'] = [];
  const appliedSpecs: ConfigFieldSpec[] = [];
  let next: LocalConfig = { ...current };

  for (const [key, raw] of Object.entries(updates)) {
    const spec = findFieldSpec(key);
    if (!spec) {
      errors.push({ key, message: `Unknown config field "${key}". Run \`teamai config list\` for valid keys.` });
      continue;
    }
    if (spec.readOnly) {
      errors.push({
        key,
        message: `${spec.label} is read-only${spec.readOnlyHint ? ` (managed by \`${spec.readOnlyHint}\`)` : ''}.`,
      });
      continue;
    }
    if (!spec.scopes.includes(scope)) {
      errors.push({ key, message: `${spec.label} is not editable in ${scope} scope.` });
      continue;
    }

    let normalized: unknown;
    try {
      normalized = normalizeFieldValue(spec, raw);
      await validateDynamicMembership(spec, current, normalized);
    } catch (e) {
      const message = e instanceof ConfigFieldError ? e.message : (e as Error).message;
      errors.push({ key, message });
      continue;
    }

    try {
      next = spec.apply
        ? spec.apply(next, normalized)
        : deepSet(next, spec.key, normalized);
    } catch (e) {
      const message = e instanceof ConfigFieldError ? e.message : (e as Error).message;
      errors.push({ key, message });
      continue;
    }
    appliedSpecs.push(spec);
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  const parsed = LocalConfigSchema.safeParse(next);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const path = issue.path.join('.');
      const key = Object.keys(updates).find((k) => k === path || path.startsWith(`${k}.`)) ?? path;
      errors.push({ key, message: `Validation failed for ${path}: ${issue.message}` });
    }
    return { ok: false, errors };
  }

  await saveLocalConfigForScope(parsed.data, scope, projectRoot);

  // Sequential afterSave hooks — config write already stands.
  for (const spec of appliedSpecs) {
    if (!spec.afterSave) continue;
    try {
      await spec.afterSave(parsed.data);
    } catch (e) {
      errors.push({ key: spec.key, message: `Saved, but post-save step failed: ${(e as Error).message}` });
    }
  }

  return { ok: true, config: parsed.data, errors };
}

// ─── Branch helpers shared with the UI layer ──────────────

/**
 * Resolve the remote default branch of a clone via
 * `git ls-remote --symref origin HEAD` (read-only, one round-trip).
 * Returns null for non-git kinds or when the remote is unreachable.
 */
export async function resolveDefaultBranch(localPath: string, kind?: string): Promise<string | null> {
  if (kind && kind !== 'git') return null;
  try {
    const git = createGit(localPath);
    const out = await git.raw(['ls-remote', '--symref', 'origin', 'HEAD']);
    const m = out.match(/ref:\s*refs\/heads\/(\S+)/);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}
