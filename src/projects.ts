import path from 'node:path';
import YAML from 'yaml';
import { z } from 'zod';
import { readFileSafe, ensureDir, writeFile } from './utils/fs.js';
import type { ResourceNamespaces } from './roles.js';

/**
 * Project resource types. Unlike roles, `learnings` is an ACTIVE dimension here:
 * projects are the only carrier of learnings-namespace isolation (roles ignore it
 * on purpose — see src/roles.ts). knowledge/skills mirror the role convention.
 */
const PROJECT_RESOURCE_TYPES = ['knowledge', 'skills', 'learnings'] as const;

export type ProjectResourceType = typeof PROJECT_RESOURCE_TYPES[number];

const ProjectResourceNamespacesSchema = z.object({
  knowledge: z.array(z.string().min(1)).default([]),
  skills: z.array(z.string().min(1)).default([]),
  learnings: z.array(z.string().min(1)).default([]),
});

/**
 * A project id becomes a path component (skills/<id>/, learnings/<id>/), so it
 * must never contain a path separator or `..`. Enforced here at the manifest
 * boundary; use-sites that read ids from other sources (e.g. a hand-edited
 * config.yaml `projects` field) additionally guard via `isSafeNamespaceSegment`.
 */
const SAFE_ID = /^[A-Za-z0-9._-]+$/;

/** True if `seg` is safe to use as a single path segment (no separators, no `..`). */
export function isSafeNamespaceSegment(seg: string): boolean {
  return SAFE_ID.test(seg) && seg !== '.' && seg !== '..';
}

const ProjectSchema = z.object({
  id: z.string().min(1).refine((v) => isSafeNamespaceSegment(v), {
    message: "project id must be a single path segment (letters, digits, '.', '_', '-'; no '/', '\\\\', or '..')",
  }),
  name: z.string().default(''),
  description: z.string().default(''),
  resources: ProjectResourceNamespacesSchema,
});

const ProjectsManifestSchema = z.object({
  version: z.number(),
  // Unlike roles (`.min(1)`), a repo may define zero projects — a team without
  // project partitioning simply has no projects.yaml, and an empty list is valid.
  projects: z.array(ProjectSchema).default([]),
});

export type TeamProject = z.infer<typeof ProjectSchema>;
export type ProjectsManifest = z.infer<typeof ProjectsManifestSchema>;

function validateManifestShape(raw: unknown): ProjectsManifest {
  if (!raw || typeof raw !== 'object') {
    throw new Error('Invalid projects manifest: expected an object');
  }

  const candidate = raw as Record<string, unknown>;
  const projects = candidate.projects;
  if (projects !== undefined && !Array.isArray(projects)) {
    throw new Error('Invalid projects manifest: projects must be an array');
  }

  for (const project of projects ?? []) {
    if (!project || typeof project !== 'object') {
      throw new Error('Invalid projects manifest: every project must be an object');
    }

    const resources = (project as Record<string, unknown>).resources;
    if (resources !== undefined && (typeof resources !== 'object' || Array.isArray(resources))) {
      throw new Error(`Invalid projects manifest: project ${(project as Record<string, unknown>).id ?? '<unknown>'} has invalid resources`);
    }

    if (resources) {
      const ALLOWED_RESOURCE_KEYS = new Set<string>(PROJECT_RESOURCE_TYPES);
      for (const key of Object.keys(resources)) {
        if (!ALLOWED_RESOURCE_KEYS.has(key)) {
          throw new Error(`Invalid projects manifest: unknown resource type "${key}"`);
        }
      }
    }
  }

  const manifest = ProjectsManifestSchema.parse(raw);
  const ids = new Set<string>();
  for (const project of manifest.projects) {
    if (ids.has(project.id)) {
      throw new Error(`Invalid projects manifest: duplicate project id "${project.id}"`);
    }
    ids.add(project.id);
  }

  return manifest;
}

/**
 * Load the projects manifest. Returns `null` when the file is absent — projects
 * are optional (a team without partitioning has no projects.yaml), so every
 * project code path short-circuits on `null` and behaves exactly as before.
 */
export async function loadProjectsManifest(repoPath: string): Promise<ProjectsManifest | null> {
  const manifestPath = path.join(repoPath, 'manifest', 'projects.yaml');
  const content = await readFileSafe(manifestPath);
  if (!content) {
    return null;
  }

  let raw: unknown;
  try {
    raw = YAML.parse(content);
  } catch (error) {
    throw new Error(`Invalid projects manifest YAML: ${(error as Error).message}`);
  }

  return validateManifestShape(raw);
}

export async function saveProjectsManifest(repoPath: string, manifest: ProjectsManifest): Promise<void> {
  // Re-validate before writing to prevent persisting invalid manifests
  validateManifestShape(manifest);

  const manifestDir = path.join(repoPath, 'manifest');
  const manifestPath = path.join(manifestDir, 'projects.yaml');
  await ensureDir(manifestDir);
  await writeFile(manifestPath, YAML.stringify(manifest));
}

/**
 * Find a project by id without throwing. Returns undefined if not found.
 */
export function findProject(manifest: ProjectsManifest, projectId: string): TeamProject | undefined {
  return manifest.projects.find((candidate) => candidate.id === projectId);
}

export function listProjectIds(manifest: ProjectsManifest): string[] {
  return manifest.projects.map((project) => project.id);
}

export function describeProjects(projects: Array<Pick<TeamProject, 'id' | 'name' | 'description'>>): string[] {
  return projects.map((project) => {
    const label = project.name || project.id;
    return project.description ? `${label}: ${project.description}` : label;
  });
}

function getProjectOrThrow(manifest: ProjectsManifest, projectId: string): TeamProject {
  const project = findProject(manifest, projectId);
  if (!project) {
    throw new Error(`Unknown project "${projectId}". Valid projects: ${listProjectIds(manifest).join(', ')}`);
  }
  return project;
}

/**
 * Resolve the resource namespaces contributed by the given active projects, as a
 * deduped union across all three resource types (knowledge/skills/learnings).
 *
 * This is the ONLY source of learnings namespaces. Roles never contribute them.
 * The caller unions the result with `resolveRoleResourceNamespaces(...)` on the
 * knowledge/skills axes; there is no priority override between the two dimensions
 * (same-named resources across a role and a project namespace are an admin-side
 * duplicate error, not a runtime precedence decision).
 */
export function resolveProjectResourceNamespaces(input: {
  manifest: ProjectsManifest;
  activeProjects: string[];
}): Record<ProjectResourceType, string[]> {
  const resolved = input.activeProjects.map((id) => getProjectOrThrow(input.manifest, id));

  const namespaces: Record<ProjectResourceType, string[]> = {
    knowledge: [],
    skills: [],
    learnings: [],
  };

  for (const type of PROJECT_RESOURCE_TYPES) {
    const seen = new Set<string>();
    for (const project of resolved) {
      for (const namespace of project.resources[type]) {
        if (seen.has(namespace)) continue;
        seen.add(namespace);
        namespaces[type].push(namespace);
      }
    }
  }

  return namespaces;
}

/**
 * Resolve the active **learnings** namespaces for a directory, from the manifest
 * — the SAME source `pull` uses. This is the canonical mapping from active
 * project ids to learnings subdirectories: a project's learnings namespace is
 * `resources.learnings`, which the schema allows to differ from the project id
 * (e.g. project `alpha` → `learnings: [alpha-notes]`). `contribute` must route
 * and index through this, not through the raw project id, or its landing point
 * and post-contribute index diverge from what `pull` syncs.
 *
 * Returns `[]` when there is no manifest, no active project, or the active
 * projects declare no learnings namespace (→ contribution lands at the shared root).
 */
export async function resolveActiveLearningsNamespaces(
  repoPath: string,
  activeProjects: string[],
): Promise<string[]> {
  if (activeProjects.length === 0) return [];
  const manifest = await loadProjectsManifest(repoPath);
  if (!manifest) return [];
  try {
    return resolveProjectResourceNamespaces({ manifest, activeProjects }).learnings;
  } catch {
    // Unknown active project id, etc. — degrade to shared root rather than throw.
    return [];
  }
}

/**
 * Merge role and project namespaces into the final active set. knowledge/skills
 * are the deduped union of both dimensions; learnings comes from projects only.
 * There is deliberately no priority override — see the module-level note.
 */
export function mergeNamespaces(
  roleNamespaces: ResourceNamespaces,
  projectNamespaces: Record<ProjectResourceType, string[]>,
): ResourceNamespaces {
  const dedupe = (a: string[], b: string[]): string[] => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const ns of [...a, ...b]) {
      if (seen.has(ns)) continue;
      seen.add(ns);
      out.push(ns);
    }
    return out;
  };

  return {
    knowledge: dedupe(roleNamespaces.knowledge, projectNamespaces.knowledge),
    skills: dedupe(roleNamespaces.skills, projectNamespaces.skills),
    // Roles never contribute learnings; this is effectively the project set.
    learnings: dedupe(roleNamespaces.learnings, projectNamespaces.learnings),
  };
}
