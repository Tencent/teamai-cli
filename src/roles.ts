import path from 'node:path';
import YAML from 'yaml';
import { z } from 'zod';
import { readFileSafe, ensureDir, writeFile } from './utils/fs.js';
import { log } from './utils/logger.js';

const ROLE_RESOURCE_TYPES = ['knowledge', 'skills'] as const;

export type RoleResourceType = typeof ROLE_RESOURCE_TYPES[number];

const RoleResourceNamespacesSchema = z.object({
  knowledge: z.array(z.string().min(1)),
  skills: z.array(z.string().min(1)),
  // learnings is accepted for backward compatibility but ignored at runtime.
  // All learnings are shared flat across the entire team (no namespace isolation).
  learnings: z.array(z.string()).optional(),
});

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
 * Active resource namespaces after resolving roles ∪ projects. `learnings` is
 * always present but only projects ever populate it (roles leave it empty — see
 * the note on RoleResourceNamespacesSchema). Kept as a superset of the role
 * resource types so role and project resolutions share one shape and can be
 * unioned directly.
 */
export type ResourceNamespaces = {
  knowledge: string[];
  skills: string[];
  learnings: string[];
};

function validateManifestShape(raw: unknown): RolesManifest {
  if (!raw || typeof raw !== 'object') {
    throw new Error('Invalid roles manifest: expected an object');
  }

  const candidate = raw as Record<string, unknown>;
  const roles = candidate.roles;
  if (!Array.isArray(roles) || roles.length === 0) {
    throw new Error('Invalid roles manifest: roles must be a non-empty array');
  }

  for (const role of roles) {
    if (!role || typeof role !== 'object') {
      throw new Error('Invalid roles manifest: every role must be an object');
    }

    const resources = (role as Record<string, unknown>).resources;
    if (!resources || typeof resources !== 'object' || Array.isArray(resources)) {
      throw new Error(`Invalid roles manifest: role ${(role as Record<string, unknown>).id ?? '<unknown>'} is missing resources`);
    }

    // Accept 'learnings' for backward compatibility but only validate active types
    const ALLOWED_RESOURCE_KEYS = new Set<string>([...ROLE_RESOURCE_TYPES, 'learnings']);
    for (const key of Object.keys(resources)) {
      if (!ALLOWED_RESOURCE_KEYS.has(key)) {
        throw new Error(`Invalid roles manifest: unknown resource type "${key}"`);
      }
    }
  }

  const manifest = RolesManifestSchema.parse(raw);
  const ids = new Set<string>();
  for (const role of manifest.roles) {
    if (ids.has(role.id)) {
      throw new Error(`Invalid roles manifest: duplicate role id "${role.id}"`);
    }
    ids.add(role.id);
  }

  return manifest;
}

export async function loadRolesManifest(repoPath: string): Promise<RolesManifest> {
  const manifestPath = path.join(repoPath, 'manifest', 'roles.yaml');
  const content = await readFileSafe(manifestPath);
  if (!content) {
    throw new Error(`Roles manifest not found: ${manifestPath}`);
  }

  let raw: unknown;
  try {
    raw = YAML.parse(content);
  } catch (error) {
    throw new Error(`Invalid roles manifest YAML: ${(error as Error).message}`);
  }

  return validateManifestShape(raw);
}

export async function saveRolesManifest(repoPath: string, manifest: RolesManifest): Promise<void> {
  // Re-validate before writing to prevent persisting invalid manifests
  validateManifestShape(manifest);

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

  const namespaces: ResourceNamespaces = {
    knowledge: [],
    skills: [],
    // Roles never contribute learnings namespaces; only projects do. Kept empty
    // so the shape matches project resolution for a clean union at the call site.
    learnings: [],
  };

  for (const type of ROLE_RESOURCE_TYPES) {
    const seen = new Set<string>();
    for (const role of resolvedRoles) {
      for (const namespace of role.resources[type]) {
        if (seen.has(namespace)) continue;
        seen.add(namespace);
        namespaces[type].push(namespace);
      }
    }
  }

  return namespaces;
}

/**
 * Role ids this member holds, primary first, or null when no primary role is
 * configured. Null means "no role filter": a member without a role keeps
 * receiving every resource, the same fallback pull applies to skills and rules.
 */
export function activeRoleIds(localConfig: { primaryRole?: string; additionalRoles?: string[] }): string[] | null {
  if (!localConfig.primaryRole) return null;
  return [...new Set([localConfig.primaryRole, ...(localConfig.additionalRoles ?? [])])];
}

/**
 * Does an entry with an optional `roles:` list apply to this member? Mirrors
 * the `tools:` filter: omitted = everyone, an empty list = nobody. A null
 * active set (no role configured) matches everything, see activeRoleIds.
 */
export function matchesRoles(entryRoles: string[] | undefined, active: string[] | null | undefined): boolean {
  if (!entryRoles || active == null) return true;
  return entryRoles.some((role) => active.includes(role));
}

/** `${file}:${role}` pairs already reported in this process (pull runs each
 *  reconciler once per scope; the member should read the warning once). */
const reportedUnknownRoles = new Set<string>();

/**
 * Warn once per pull for each role id that an entry's `roles:` names but
 * roles.yaml does not define. A typo would otherwise ship the entry to nobody
 * in silence. Never fails the run: without a readable manifest there is
 * nothing to check against.
 */
export async function warnUnknownRoleIds(
  repoPath: string,
  file: string,
  entries: Array<{ kind: string; name: string; roles?: string[] }>,
): Promise<void> {
  if (!entries.some((entry) => entry.roles && entry.roles.length > 0)) return;
  let known: Set<string>;
  try {
    known = new Set(listRoleIds(await loadRolesManifest(repoPath)));
  } catch {
    return;
  }
  for (const entry of entries) {
    for (const role of entry.roles ?? []) {
      if (known.has(role) || reportedUnknownRoles.has(`${file}:${role}`)) continue;
      reportedUnknownRoles.add(`${file}:${role}`);
      log.warn(`roles: unknown role id "${role}" in ${file} ${entry.kind} "${entry.name}". Valid roles: ${[...known].join(', ')}`);
    }
  }
}
