import path from 'node:path';
import YAML from 'yaml';
import { z } from 'zod';
import { ensureDir, writeFile } from './utils/fs.js';
import {
  NamespaceSegmentSchema, parseManifest, readManifestFile, assertNoCaseAliasedNamespaces, warnUnknownResourceKeys,
  HAND_DECLARED_RESOURCE_TYPES, HandDeclaredNamespacesShape, type NamespaceEntry, parseManifestOnce,
} from './manifest-schema.js';
import { loadRolesManifest, resolveRoleResourceNamespaces, type ResourceNamespaces } from './roles.js';
import type { LocalConfig } from './types.js';

/**
 * Project resource types. Unlike roles, `learnings` is an ACTIVE dimension here:
 * projects are the only carrier of learnings-namespace isolation (roles ignore it
 * on purpose — see src/roles.ts). knowledge/skills mirror the role convention.
 */
export const PROJECT_RESOURCE_TYPES = ['knowledge', 'skills', 'learnings', 'agents'] as const;

export type ProjectResourceType = typeof PROJECT_RESOURCE_TYPES[number];

/** Every type a project can namespace, the hand-declared ones included. */
export const ALL_PROJECT_RESOURCE_TYPES = [...PROJECT_RESOURCE_TYPES, ...HAND_DECLARED_RESOURCE_TYPES] as const;

export type AllProjectResourceType = typeof ALL_PROJECT_RESOURCE_TYPES[number];

/**
 * A project id becomes a path component (`skills/<id>/`, `learnings/<id>/`) just
 * as a resource namespace does, so it is guarded here too — but by its own older
 * rule, not the namespace one. An id is also typed on the command line and split
 * on commas (`teamai projects set a,b`), so its ASCII allowlist already excludes
 * most of what the namespace guard has to test for, and holding it to the rest
 * would reject ids that work today (`...` is a directory POSIX accepts).
 *
 * Both are enforced here at the manifest boundary, the only place they enter the
 * process: an id read from elsewhere (a hand-edited config.yaml `projects`
 * field) is resolved through `getProjectOrThrow`, so it can only ever name a
 * project this manifest already validated. `contribute.ts` and
 * `resources/agents.ts` keep their own `isSafeNamespaceSegment` guards on the
 * resolved namespace as defence in depth.
 */
const SAFE_ID = /^[A-Za-z0-9._-]+$/;

function isSafeProjectId(id: string): boolean {
  return SAFE_ID.test(id) && id !== '.' && id !== '..';
}

// passthrough: a key this CLI does not know (only warned about) is kept, so a
// manifest saved by `projects add/update/remove` does not delete a newer CLI's
// type from the team repo.
const ProjectResourceNamespacesSchema = z.object({
  knowledge: z.array(NamespaceSegmentSchema).default([]),
  skills: z.array(NamespaceSegmentSchema).default([]),
  learnings: z.array(NamespaceSegmentSchema).default([]),
  agents: z.array(NamespaceSegmentSchema).default([]),
  // env, hooks, mcp, models, docs: optional, see HAND_DECLARED_RESOURCE_TYPES.
  ...HandDeclaredNamespacesShape,
}).passthrough();

const ProjectSchema = z.object({
  id: z.string().min(1).refine(isSafeProjectId, {
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

  const entries: unknown[] = projects ?? [];
  for (const project of entries) {
    if (!project || typeof project !== 'object') {
      throw new Error('Invalid projects manifest: every project must be an object');
    }

    const id = 'id' in project && project.id != null ? String(project.id) : '<unknown>';
    const resources = 'resources' in project ? project.resources : undefined;
    if (resources !== undefined && (typeof resources !== 'object' || Array.isArray(resources))) {
      throw new Error(`Invalid projects manifest: project ${id} has invalid resources`);
    }

    if (resources) {
      warnUnknownResourceKeys(resources, new Set<string>(ALL_PROJECT_RESOURCE_TYPES), 'projects', `project ${id}`);
    }
  }

  const manifest = parseManifest(ProjectsManifestSchema, raw, 'projects');
  const ids = new Set<string>();
  for (const project of manifest.projects) {
    if (ids.has(project.id)) {
      throw new Error(`Invalid projects manifest: duplicate project id "${project.id}"`);
    }
    ids.add(project.id);
  }
  assertNoCaseAliasedNamespaces(projectNamespaceEntries(manifest), 'projects manifest');

  return manifest;
}

/** Every namespace a projects manifest puts to use, with the project that declares it. */
export function projectNamespaceEntries(manifest: ProjectsManifest): NamespaceEntry[] {
  return manifest.projects.flatMap((project) =>
    ALL_PROJECT_RESOURCE_TYPES.flatMap((type) =>
      (project.resources[type] ?? []).map((namespace) => ({ type, namespace, owner: `project ${project.id}` })),
    ),
  );
}

/**
 * Load the projects manifest. Returns `null` when the file is absent — projects
 * are optional (a team without partitioning has no projects.yaml), so every
 * project code path short-circuits on `null` and behaves exactly as before.
 * A file that exists but cannot be read or parsed throws, so a caller never
 * mistakes a broken manifest for a team without one.
 */
export async function loadProjectsManifest(repoPath: string): Promise<ProjectsManifest | null> {
  const manifestPath = path.join(repoPath, 'manifest', 'projects.yaml');
  // Only an absent file means "this team has no projects": an unreadable or empty
  // one throws, so the pull fails rather than quietly syncing as if unpartitioned.
  const content = await readManifestFile(manifestPath, 'projects');
  if (content === null) {
    return null;
  }

  return parseManifestOnce(manifestPath, content, (text) => {
    let raw: unknown;
    try {
      raw = YAML.parse(text);
    } catch (error) {
      throw new Error(`Invalid projects manifest YAML: ${(error as Error).message}`);
    }
    return validateManifestShape(raw);
  });
}

/** Validate a manifest built in memory with the same checks a load applies; throws on the first problem. */
export function validateProjectsManifest(manifest: unknown): ProjectsManifest {
  return validateManifestShape(manifest);
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

/** What to tell the user when a project id does not exist in the manifest. */
export function unknownProjectMessage(manifest: ProjectsManifest, projectId: string): string {
  return `Unknown project "${projectId}". Valid projects: ${listProjectIds(manifest).join(', ') || '(none)'}`;
}

function getProjectOrThrow(manifest: ProjectsManifest, projectId: string): TeamProject {
  const project = findProject(manifest, projectId);
  if (!project) {
    throw new Error(unknownProjectMessage(manifest, projectId));
  }
  return project;
}

/**
 * Resolve the resource namespaces contributed by the given active projects, as a
 * deduped union across all three resource types (knowledge/skills/learnings).
 *
 * Both projects and roles contribute learnings namespaces (#1101). The caller
 * unions the result with `resolveRoleResourceNamespaces(...)` on every axis;
 * there is no priority override between the two dimensions (same-named resources
 * across a role and a project namespace are an admin-side duplicate error, not a
 * runtime precedence decision).
 */
export function resolveProjectResourceNamespaces(input: {
  manifest: ProjectsManifest;
  activeProjects: string[];
}): ResourceNamespaces {
  const resolved = input.activeProjects.map((id) => getProjectOrThrow(input.manifest, id));

  // A hand-declared type (env, hooks, mcp, models, docs) is absent until one is active.
  const namespaces: ResourceNamespaces = { knowledge: [], skills: [], learnings: [], agents: [] };

  for (const type of ALL_PROJECT_RESOURCE_TYPES) {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const project of resolved) {
      for (const namespace of project.resources[type] ?? []) {
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
 * Resolve the active **learnings** namespaces for a directory, from the
 * manifests — the SAME sources `pull` uses: the member's roles first, then the
 * active projects, as `mergeNamespaces` orders them. This is the canonical
 * mapping to learnings subdirectories: a learnings namespace is
 * `resources.learnings`, which the schema allows to differ from the role or
 * project id (e.g. project `alpha` → `learnings: [alpha-notes]`). `contribute`
 * must route and index through this, not through the raw id, or its landing
 * point and post-contribute index diverge from what `pull` syncs.
 *
 * Returns `[]` when there is no manifest, no role or active project, or none of
 * them declares a learnings namespace (→ contribution lands at the shared root).
 */
export async function resolveActiveLearningsNamespaces(
  config: { repo: Pick<LocalConfig['repo'], 'localPath'> } & Partial<Pick<LocalConfig, 'projects' | 'primaryRole' | 'additionalRoles'>>,
): Promise<string[]> {
  const repoPath = config.repo.localPath;
  const activeProjects = config.projects ?? [];
  // An unknown role or project id, or a manifest that does not parse, degrades
  // to the shared root rather than throw.
  const fromRoles = async (): Promise<string[]> => {
    if (!config.primaryRole) return [];
    try {
      const manifest = await loadRolesManifest(repoPath);
      return resolveRoleResourceNamespaces({
        manifest, primaryRole: config.primaryRole, additionalRoles: config.additionalRoles ?? [],
      }).learnings;
    } catch {
      return [];
    }
  };
  const fromProjects = async (): Promise<string[]> => {
    if (activeProjects.length === 0) return [];
    const manifest = await loadProjectsManifest(repoPath);
    if (!manifest) return [];
    try {
      return resolveProjectResourceNamespaces({ manifest, activeProjects }).learnings;
    } catch {
      return [];
    }
  };
  return [...new Set([...await fromRoles(), ...await fromProjects()])];
}

/**
 * Merge role and project namespaces into the final active set. knowledge/skills
 * are the deduped union of both dimensions; learnings comes from projects only.
 * There is deliberately no priority override — see the module-level note.
 */
export function mergeNamespaces(
  roleNamespaces: ResourceNamespaces,
  projectNamespaces: ResourceNamespaces,
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

  const merged: ResourceNamespaces = {
    knowledge: dedupe(roleNamespaces.knowledge, projectNamespaces.knowledge),
    skills: dedupe(roleNamespaces.skills, projectNamespaces.skills),
    learnings: dedupe(roleNamespaces.learnings, projectNamespaces.learnings),
    agents: dedupe(roleNamespaces.agents, projectNamespaces.agents),
  };
  for (const type of HAND_DECLARED_RESOURCE_TYPES) {
    const namespaces = dedupe(roleNamespaces[type] ?? [], projectNamespaces[type] ?? []);
    if (namespaces.length > 0) merged[type] = namespaces;
  }
  return merged;
}
