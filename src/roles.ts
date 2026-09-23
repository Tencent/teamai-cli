import path from 'node:path';
import YAML from 'yaml';
import { z } from 'zod';
import { ensureDir, writeFile } from './utils/fs.js';
import { NamespaceSegmentSchema, parseManifest, readManifestFile, assertNoCaseAliasedNamespaces, type NamespaceEntry } from './manifest-schema.js';

const ROLE_RESOURCE_TYPES = ['knowledge', 'skills', 'agents'] as const;

export type RoleResourceType = typeof ROLE_RESOURCE_TYPES[number];

const RoleResourceNamespacesSchema = z.object({
  knowledge: z.array(NamespaceSegmentSchema),
  skills: z.array(NamespaceSegmentSchema),
  // Optional: a role without `agents` receives root-level agents only, which
  // is what every manifest written before this key existed already got.
  agents: z.array(NamespaceSegmentSchema).default([]),
  // learnings is accepted for backward compatibility but ignored at runtime.
  // All learnings are shared flat across the entire team (no namespace isolation).
  // It never becomes a directory here, so it stays a plain string: holding an old
  // manifest to the namespace rule would reject it over a field nothing reads.
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
  agents: string[];
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
    ROLE_RESOURCE_TYPES.flatMap((type) =>
      role.resources[type].map((namespace) => ({ type, namespace, owner: `role ${role.id}` })),
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

  let raw: unknown;
  try {
    raw = YAML.parse(content);
  } catch (error) {
    throw new Error(`Invalid roles manifest YAML: ${(error as Error).message}`);
  }

  return validateManifestShape(raw);
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
    agents: [],
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
 * A config whose role could not be resolved (`roleUnresolved`) holds none:
 * `[]` matches no role-scoped entry.
 */
export function activeRoleIds(
  localConfig: { primaryRole?: string; additionalRoles?: string[]; roleUnresolved?: true },
): string[] | null {
  if (localConfig.roleUnresolved) return [];
  if (!localConfig.primaryRole) return null;
  return [...new Set([localConfig.primaryRole, ...(localConfig.additionalRoles ?? [])])];
}
