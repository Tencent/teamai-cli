import path from 'node:path';
import YAML from 'yaml';
import { z } from 'zod';
import { readFileSafe } from './utils/fs.js';

const ROLE_RESOURCE_TYPES = ['knowledge', 'skills', 'learnings'] as const;

export type RoleResourceType = typeof ROLE_RESOURCE_TYPES[number];

const RoleResourceBucketsSchema = z.object({
  knowledge: z.array(z.string().min(1)),
  skills: z.array(z.string().min(1)),
  learnings: z.array(z.string().min(1)),
});

const RoleSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().default(''),
  resources: RoleResourceBucketsSchema,
});

const RolesManifestSchema = z.object({
  version: z.number(),
  roles: z.array(RoleSchema).min(1),
  defaults: z.object({
    shareTarget: z.literal('primary-role').default('primary-role'),
  }).default({ shareTarget: 'primary-role' }),
});

export type TeamRole = z.infer<typeof RoleSchema>;
export type RolesManifest = z.infer<typeof RolesManifestSchema>;
export type ResourceBuckets = Record<RoleResourceType, string[]>;

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

    for (const key of Object.keys(resources)) {
      if (!ROLE_RESOURCE_TYPES.includes(key as RoleResourceType)) {
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

export function listRoleIds(manifest: RolesManifest): string[] {
  return manifest.roles.map((role) => role.id);
}

export function describeRoles(roles: Array<Pick<TeamRole, 'id' | 'name' | 'description'>>): string[] {
  return roles.map((role) => role.description
    ? `${role.id} - ${role.name}: ${role.description}`
    : `${role.id} - ${role.name}`);
}

function getRoleOrThrow(manifest: RolesManifest, roleId: string): TeamRole {
  const role = manifest.roles.find((candidate) => candidate.id === roleId);
  if (!role) {
    throw new Error(`Unknown role "${roleId}". Valid roles: ${listRoleIds(manifest).join(', ')}`);
  }
  return role;
}

export function resolveRoleResourceBuckets(input: {
  manifest: RolesManifest;
  primaryRole: string;
  additionalRoles: string[];
}): ResourceBuckets {
  const resolvedRoles = [
    getRoleOrThrow(input.manifest, input.primaryRole),
    ...input.additionalRoles.map((roleId) => getRoleOrThrow(input.manifest, roleId)),
  ];

  const buckets: ResourceBuckets = {
    knowledge: [],
    skills: [],
    learnings: [],
  };

  for (const type of ROLE_RESOURCE_TYPES) {
    const seen = new Set<string>();
    for (const role of resolvedRoles) {
      for (const bucket of role.resources[type]) {
        if (seen.has(bucket)) continue;
        seen.add(bucket);
        buckets[type].push(bucket);
      }
    }
  }

  return buckets;
}

