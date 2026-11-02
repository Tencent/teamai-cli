import path from 'node:path';
import YAML from 'yaml';
import { parseYaml } from './utils/yaml.js';
import type { JsonValue } from './types.js';
import { z } from 'zod';
import { ensureDir, writeFile } from './utils/fs.js';
import {
  NamespaceSegmentSchema, parseManifest, readManifestFile, assertNoCaseAliasedNamespaces, warnUnknownResourceKeys,
  HAND_DECLARED_RESOURCE_TYPES, HandDeclaredNamespaceFields, type HandDeclaredResourceType, type NamespaceEntry, parseManifestOnce,
} from './manifest-schema.js';

const ROLE_RESOURCE_TYPES = ['knowledge', 'skills', 'agents'] as const;

export type RoleResourceType = typeof ROLE_RESOURCE_TYPES[number];

// passthrough: a key this CLI does not know (only warned about) is kept, so a
// manifest saved by `roles add/update` does not delete a newer CLI's type from the team repo.
const RoleResourceNamespacesSchema = z.object({
  knowledge: z.array(NamespaceSegmentSchema),
  skills: z.array(NamespaceSegmentSchema),
  // Optional: a role without `agents` receives root-level agents only, which
  // is what every manifest written before this key existed already got.
  agents: z.array(NamespaceSegmentSchema).default([]),
  // learnings namespaces: roles and projects both contribute them (#1101).
  learnings: z.array(z.string()).optional(),
  // env, hooks, mcp, models, docs: optional, see HAND_DECLARED_RESOURCE_TYPES.
  ...HandDeclaredNamespaceFields,
}).passthrough();

const RoleSchema = z.object({
  id: z.string().min(1),
  description: z.string().default(''),
  resources: RoleResourceNamespacesSchema,
});

const RolesManifestSchema = z.object({
  version: z.number(),
  roles: z.array(RoleSchema).min(1),
  // defaults.shareTarget was removed: learnings are flat, no namespace routing needed.
  // Old manifests with a defaults block are still parseable (z.passthrough on object level).
  defaults: z.object({}).passthrough().optional(),
});

export type TeamRole = z.infer<typeof RoleSchema>;

export type RolesManifest = z.infer<typeof RolesManifestSchema>;

/**
 * A role id as a workflow step, `defaults.role` or a benchmark arm names one: a token such as `review`, which a copy
 * runs with and a record publishes. `manifest/roles.yaml` itself takes any non-empty id.
 */
const ROLE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export const RoleIdSchema = z.string().regex(ROLE_ID, 'must be the id of a role in manifest/roles.yaml, such as review');

/** Whether `value` is shaped like a role id a workflow or a benchmark names (`RoleIdSchema`). */
export function isRoleId(value: string): boolean {
  return ROLE_ID.test(value);
}

/**
 * Active resource namespaces after resolving roles ∪ projects. Both dimensions
 * contribute `learnings` (#1101). Kept as a superset of the role resource types
 * so role and project resolutions share one shape and can be unioned directly.
 */
export type ResourceNamespaces = Record<RoleResourceType | 'learnings', string[]>
  // Optional so a resolution built before a type existed (or a test double of
  // one) still reads as "nothing active" for it: read with `?? []`.
  & Partial<Record<HandDeclaredResourceType, string[]>>;

/** Every type a role or project can namespace, in the order resolution walks them. */
export const NAMESPACED_RESOURCE_TYPES = [...ROLE_RESOURCE_TYPES, ...HAND_DECLARED_RESOURCE_TYPES] as const;

/**
 * A roles manifest as roles.yaml holds it, or one built in memory, checked with the same rules; throws on the first
 * problem. The structure checks come first so each gets its own message before the schema runs.
 */
function checkRolesManifest(raw: JsonValue | RolesManifest): RolesManifest {
  if (!(raw instanceof Object)) {
    throw new Error('Invalid roles manifest: expected an object');
  }

  const roles = Array.isArray(raw) ? undefined : raw.roles;

  if (!Array.isArray(roles) || roles.length === 0) {
    throw new Error('Invalid roles manifest: roles must be a non-empty array');
  }

  for (const role of roles) {
    if (!(role instanceof Object)) {
      throw new Error('Invalid roles manifest: every role must be an object');
    }

    const id = 'id' in role && role.id != null ? String(role.id) : '<unknown>';
    const resources = 'resources' in role ? role.resources : undefined;

    if (!(resources instanceof Object) || Array.isArray(resources)) {
      throw new Error(`Invalid roles manifest: role ${id} is missing resources`);
    }

    // Accept 'learnings' for backward compatibility but only validate active types
    const ALLOWED_RESOURCE_KEYS = new Set<string>([...NAMESPACED_RESOURCE_TYPES, 'learnings']);
    warnUnknownResourceKeys(Object.keys(resources), ALLOWED_RESOURCE_KEYS, 'roles', `role ${id}`);
  }

  const manifest = parseManifest(RolesManifestSchema, raw, 'roles');
  const ids = new Set<string>();

  for (const role of manifest.roles) {
    if (ids.has(role.id)) {
      throw new Error(`Invalid roles manifest: duplicate role id "${role.id}"`);
    }

    ids.add(role.id);
  }

  assertNoCaseAliasedNamespaces(roleNamespaceEntries(manifest), 'roles manifest');

  return manifest;
}

/** Every namespace a roles manifest puts to use, with the role that declares it. */
export function roleNamespaceEntries(manifest: RolesManifest): NamespaceEntry[] {
  return manifest.roles.flatMap((role) =>
    [...NAMESPACED_RESOURCE_TYPES, 'learnings' as const].flatMap((type) =>
      (role.resources[type] ?? []).map((namespace) => ({ type, namespace, owner: `role ${role.id}` })),
    ),
  );
}

/**
 * The team repo has no `manifest/roles.yaml` at all — a team that does not use
 * roles, not a broken one. Callers that relax filtering must react to this case
 * ONLY: doing the same for a manifest that exists but cannot be read or parsed
 * would hand out every namespace the manifest was written to gate on pull, and
 * send a new rule or agent to the shared root on push (#649).
 */
export class RolesManifestNotFoundError extends Error {
  constructor(manifestPath: string) {
    super(`Roles manifest not found: ${manifestPath}`);
    this.name = 'RolesManifestNotFoundError';
  }
}

export async function loadRolesManifest(repoPath: string): Promise<RolesManifest> {
  const manifestPath = path.join(repoPath, 'manifest', 'roles.yaml');
  // Absence is the only case that may relax filtering downstream, so it is the
  // only one that becomes RolesManifestNotFoundError: an unreadable or empty file
  // throws a plain error and fails the pull or push.
  const content = await readManifestFile(manifestPath, 'roles');

  if (content === null) {
    throw new RolesManifestNotFoundError(manifestPath);
  }

  return parseManifestOnce(manifestPath, content, (text) => {
    let raw: JsonValue;

    try {
      raw = parseYaml(text);
    } catch (error) {
      throw new Error(`Invalid roles manifest YAML: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }

    return checkRolesManifest(raw);
  });
}

/**
 * The roles manifest, or `null` when the team has none.
 *
 * Mirrors `loadProjectsManifest`'s contract: absent is a value, invalid is an
 * error. `loadRolesManifest` throws for both, which callers that must tell them
 * apart cannot use — a team with no roles.yaml is ordinary, while one whose
 * roles.yaml does not parse deserves to be told why.
 */
export async function loadRolesManifestIfPresent(repoPath: string): Promise<RolesManifest | null> {
  // Only absence relaxes to null: a manifest that exists but cannot be read or
  // parsed is a failure to report, not a team without roles.
  try {
    return await loadRolesManifest(repoPath);
  } catch (error) {
    if (error instanceof RolesManifestNotFoundError) return null;
    throw error;
  }
}

/**
 * Whether the team repo at `repoPath` declares a role, as its manifest/roles.yaml reads: `declared`; `undeclared`, with
 * the ids it declares; `unreadable`, a manifest that exists but cannot be read or parsed, with the first line of why;
 * `missing`, no manifest. `role` undefined asks for the declared ids alone, which `declared` then carries.
 */
export type RoleDeclaration =
  | { kind: 'declared'; ids: readonly string[] }
  | { kind: 'undeclared'; ids: readonly string[] }
  | { kind: 'unreadable'; error: string }
  | { kind: 'missing' };

/** Whether `manifest/roles.yaml` in the team repo at `repoPath` declares `role`: see `RoleDeclaration`. */
export async function roleDeclaration(repoPath: string, role?: string): Promise<RoleDeclaration> {
  let manifest: RolesManifest | null;

  try {
    manifest = await loadRolesManifestIfPresent(repoPath);
  } catch (error) {
    // The first line names the problem and where; a YAML error's code frame follows it.
    const message = error instanceof Error ? error.message : String(error);

    return { kind: 'unreadable', error: message.split('\n')[0]?.trim() ?? message };
  }

  if (!manifest) return { kind: 'missing' };
  const ids = listRoleIds(manifest);

  return role === undefined || ids.includes(role) ? { kind: 'declared', ids } : { kind: 'undeclared', ids };
}

export async function saveRolesManifest(repoPath: string, manifest: RolesManifest): Promise<void> {
  // Re-validate before writing to prevent persisting invalid manifests
  checkRolesManifest(manifest);

  const manifestDir = path.join(repoPath, 'manifest');
  const manifestPath = path.join(manifestDir, 'roles.yaml');
  await ensureDir(manifestDir);
  await writeFile(manifestPath, YAML.stringify(manifest));
}

/**
 * Find a role by id without throwing. Returns undefined if not found.
 */
export function findRole(manifest: RolesManifest, roleId: string): TeamRole | undefined {
  return manifest.roles.find((candidate) => candidate.id === roleId);
}

export function listRoleIds(manifest: RolesManifest): string[] {
  return manifest.roles.map((role) => role.id);
}

export function describeRoles(roles: Array<Pick<TeamRole, 'id' | 'description'>>): string[] {
  return roles.map((role) => role.description
    ? `${role.id}: ${role.description}`
    : `${role.id}`);
}

function getRoleOrThrow(manifest: RolesManifest, roleId: string): TeamRole {
  const role = manifest.roles.find((candidate) => candidate.id === roleId);

  if (!role) {
    throw new Error(`Unknown role "${roleId}". Valid roles: ${listRoleIds(manifest).join(', ')}`);
  }

  return role;
}

export function resolveRoleResourceNamespaces(input: {
  manifest: RolesManifest;
  primaryRole: string;
  additionalRoles: string[];
}): ResourceNamespaces {
  const resolvedRoles = [
    getRoleOrThrow(input.manifest, input.primaryRole),
    ...input.additionalRoles.map((roleId) => getRoleOrThrow(input.manifest, roleId)),
  ];

  // Roles and projects both contribute learnings namespaces (#1101 comment:
  // "Learnings should support --project and --role namespaces just like the
  // other resources"). A hand-declared type (env, hooks, mcp, models, docs) is
  // absent until one is active.
  const namespaces: ResourceNamespaces = { knowledge: [], skills: [], learnings: [], agents: [] };

  for (const type of [...NAMESPACED_RESOURCE_TYPES, 'learnings' as const]) {
    const seen = new Set<string>();
    const out: string[] = [];

    for (const role of resolvedRoles) {
      for (const namespace of role.resources[type] ?? []) {
        if (seen.has(namespace)) continue;
        seen.add(namespace);
        out.push(namespace);
      }
    }

    if (out.length > 0 || namespaces[type] !== undefined) namespaces[type] = out;
  }

  return namespaces;
}

/**
 * Role ids this member holds, primary first, or null when no primary role is
 * configured. Null means "no role filter": a member without a role keeps
 * receiving every resource, the same fallback pull applies to skills and rules.
 * A config whose role could not be resolved (`roleUnresolved`) holds none:
 * `[]` matches no role-scoped entry.
 *
 * An assignment (`roleAssignment`, #1186) never reads as "no filter": a member
 * the team assigned no roles holds none, which is the point of assigning them.
 */
export function activeRoleIds(
  localConfig: {
    primaryRole?: string;
    additionalRoles?: string[];
    roleUnresolved?: true;
    roleAssignment?: unknown;
  },
): string[] | null {
  if (localConfig.roleUnresolved) return [];

  if (!localConfig.primaryRole) return localConfig.roleAssignment ? [] : null;

  return [...new Set([localConfig.primaryRole, ...(localConfig.additionalRoles ?? [])])];
}
