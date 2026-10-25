/**
 * The dashboard's Distribution APIs (#1124, part of #1028): read the roles and
 * projects a workspace selects, preview what a new selection would deliver,
 * and save it. What pull delivers comes from `delivery.ts`; saving goes
 * through the same helper as `roles set` and `projects set`. Nothing here
 * runs pull, writes the team repo, or returns a file body or an environment
 * value.
 */
import { createHash } from 'node:crypto';
import { loadRolesManifestIfPresent, type RolesManifest } from '../roles.js';
import { loadProjectsManifest, type ProjectsManifest } from '../projects.js';
import { readWorkspaceChildren } from '../workspace-children.js';
import { saveScopeSelection } from '../scope-selection.js';
import { log } from '../utils/logger.js';
import type { LocalConfig } from '../types.js';
import { diffDelivery, pickNamespaces, resolveDelivery, type Delivery } from './delivery.js';
import { HttpError } from './http.js';
import { ROLE_ASSIGNMENTS_FILE } from '../role-assignments.js';

/**
 * The team assigns this workspace's roles (#1186), so the page shows them and
 * edits nothing: a save would be overlaid away on the next load.
 */
function assertRolesEditable(ownConfig: LocalConfig): void {
  if (!ownConfig.roleAssignment) return;
  throw new HttpError(409, `Roles are assigned in ${ROLE_ASSIGNMENTS_FILE} in the team repo and cannot be changed here. `
    + 'Open a merge request against that file, or ask a code owner of manifest/ to.');
}

export interface DistributionSelection {
  primaryRole: string | null;
  additionalRoles: string[];
  projects: string[];
}

function selectionOf(config: Pick<LocalConfig, 'primaryRole' | 'additionalRoles' | 'projects'>): DistributionSelection {
  return {
    primaryRole: config.primaryRole ?? null,
    additionalRoles: [...(config.additionalRoles ?? [])],
    projects: [...(config.projects ?? [])],
  };
}

/**
 * Names this workspace's config and its selection. A save must send back the
 * revision it previewed, so a page left open on one workspace, or one whose
 * selection changed since (another tab, `roles set`), cannot write a stale choice.
 */
function revisionOf(config: LocalConfig): string {
  const identity = { scope: config.scope, dataHome: config.dataHome ?? null, projectRoot: config.projectRoot ?? null };
  return createHash('sha256').update(JSON.stringify({ identity, selection: selectionOf(config) })).digest('hex').slice(0, 16);
}

// ─── Manifests ──────────────────────────────────────────

type ManifestRead<T> = { state: 'ok'; manifest: T } | { state: 'missing' } | { state: 'invalid'; error: string };

/**
 * A manifest, told apart as present, absent, or unreadable. The parser's own
 * message quotes the file around the error and may name absolute paths, and
 * the read route answers any origin, so it goes to the debug log only.
 */
async function readManifest<T>(kind: 'roles' | 'projects', load: (repoPath: string) => Promise<T | null>, repoPath: string): Promise<ManifestRead<T>> {
  try {
    const manifest = await load(repoPath);
    return manifest ? { state: 'ok', manifest } : { state: 'missing' };
  } catch (error) {
    log.debug(`dashboard: manifest/${kind}.yaml: ${(error as Error).message}`);
    return { state: 'invalid', error: `manifest/${kind}.yaml cannot be read or parsed. Run \`teamai ${kind} list\` for details.` };
  }
}

const readRoles = (repoPath: string) => readManifest<RolesManifest>('roles', loadRolesManifestIfPresent, repoPath);
const readProjects = (repoPath: string) => readManifest<ProjectsManifest>('projects', loadProjectsManifest, repoPath);

/** The manifest a save checks ids against; a 409 when the team has none or it cannot be read. */
function manifestOrConflict<T>(kind: 'roles' | 'projects', read: ManifestRead<T>): T {
  if (read.state === 'missing') throw new HttpError(409, `This team repo defines no ${kind} (no manifest/${kind}.yaml).`);
  if (read.state === 'invalid') throw new HttpError(409, read.error);
  return read.manifest;
}

// ─── Delivery ───────────────────────────────────────────

const UNRESOLVED = 'Cannot resolve what pull delivers for this workspace. Run `teamai pull` for details.';

/** What pull delivers, or the safe message the API gives where pull would fail. */
async function deliveryOf(config: LocalConfig): Promise<Delivery | { error: string }> {
  try {
    return await resolveDelivery(config);
  } catch (error) {
    log.debug(`dashboard: distribution resolution failed: ${(error as Error).message}`);
    return { error: UNRESOLVED };
  }
}

// ─── Requests ───────────────────────────────────────────

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

/** An id is one path segment: the manifest names a directory with it. */
function assertSafeId(kind: 'role' | 'project', id: string): void {
  if (id.trim() === '' || /[/\\]/.test(id) || id === '.' || id === '..') {
    throw new HttpError(400, `Invalid ${kind} id "${id}".`);
  }
}

function assertKnown(kind: 'role' | 'project', ids: readonly string[], known: readonly string[]): void {
  for (const id of ids) {
    if (!known.includes(id)) throw new HttpError(400, `Unknown ${kind} "${id}".`);
  }
}

interface RoleChange { primaryRole: string; additionalRoles: string[] }

/** `{ primaryRole, additionalRoles? }`, checked against the roles manifest. */
async function roleChange(repoPath: string, body: Record<string, unknown>): Promise<RoleChange & { version: number }> {
  const { primaryRole, additionalRoles = [] } = body;
  if (typeof primaryRole !== 'string' || !isStringArray(additionalRoles)) {
    throw new HttpError(400, 'Expected { primaryRole: string, additionalRoles?: string[] }.');
  }
  for (const id of [primaryRole, ...additionalRoles]) assertSafeId('role', id);
  const manifest = manifestOrConflict('roles', await readRoles(repoPath));
  const change = { primaryRole, additionalRoles: [...new Set(additionalRoles)].filter((id) => id !== primaryRole) };
  assertKnown('role', [change.primaryRole, ...change.additionalRoles], manifest.roles.map((role) => role.id));
  return { ...change, version: manifest.version };
}

/** `{ projects }`, checked against the projects manifest. An empty list is allowed. */
async function projectChange(repoPath: string, body: Record<string, unknown>): Promise<string[]> {
  const { projects } = body;
  if (!isStringArray(projects)) throw new HttpError(400, 'Expected { projects: string[] }.');
  for (const id of projects) assertSafeId('project', id);
  const manifest = manifestOrConflict('projects', await readProjects(repoPath));
  const ids = [...new Set(projects)];
  assertKnown('project', ids, manifest.projects.map((project) => project.id));
  return ids;
}

function assertRevision(ownConfig: LocalConfig, body: Record<string, unknown>): void {
  if (body.revision !== revisionOf(ownConfig)) {
    throw new HttpError(409, 'The selection changed since it was previewed. Reload and preview again.');
  }
}

// ─── Read, preview, save ────────────────────────────────

/** The read the Distribution page renders for one workspace. */
export async function readDistribution(ownConfig: LocalConfig) {
  const repoPath = ownConfig.repo.localPath;
  const [roles, projects] = await Promise.all([readRoles(repoPath), readProjects(repoPath)]);
  // What pull delivers to a workspace includes its children's selections (#913).
  const withChildren = await readWorkspaceChildren(ownConfig);
  return {
    configured: true as const,
    revision: revisionOf(ownConfig),
    selection: selectionOf(ownConfig),
    // Null when this workspace still picks its own roles.
    rolesAssigned: ownConfig.roleAssignment ? { file: ROLE_ASSIGNMENTS_FILE, source: ownConfig.roleAssignment.source } : null,
    // A workspace saves only its own selection; its children's are shown, not edited.
    children: (withChildren.children?.children ?? []).map((child) => ({ path: child.path, ...selectionOf(child.selection) })),
    roles: roles.state === 'ok'
      ? { state: 'ok' as const, items: roles.manifest.roles.map((role) => ({ id: role.id, description: role.description, namespaces: pickNamespaces(role.resources) })) }
      : roles,
    projects: projects.state === 'ok'
      ? {
        state: 'ok' as const,
        items: projects.manifest.projects.map((project) => ({
          id: project.id, name: project.name, description: project.description, namespaces: pickNamespaces(project.resources),
        })),
      }
      : projects,
    // An invalid manifest fails pull too; say so instead of guessing what it delivers.
    effective: await deliveryOf(withChildren),
  };
}

/**
 * What the next pull would add and remove if this workspace selected `body`
 * instead: `primaryRole`/`additionalRoles`, `projects`, or both. Writes nothing.
 */
export async function previewDistribution(ownConfig: LocalConfig, body: Record<string, unknown>) {
  const repoPath = ownConfig.repo.localPath;
  let candidate: LocalConfig = { ...ownConfig };
  if ('primaryRole' in body || 'additionalRoles' in body) {
    assertRolesEditable(ownConfig);
    const { primaryRole, additionalRoles } = await roleChange(repoPath, body);
    candidate = { ...candidate, primaryRole, additionalRoles };
  }
  if ('projects' in body) candidate = { ...candidate, projects: await projectChange(repoPath, body) };
  const before = await deliveryOf(await readWorkspaceChildren(ownConfig));
  const after = await deliveryOf(await readWorkspaceChildren(candidate));
  if ('error' in before || 'error' in after) throw new HttpError(409, UNRESOLVED);
  const [roles, projects] = await Promise.all([readRoles(repoPath), readProjects(repoPath)]);
  return {
    revision: revisionOf(ownConfig),
    selection: selectionOf(candidate),
    ...diffDelivery(before, after, {
      roles: roles.state === 'ok' ? roles.manifest : null,
      projects: projects.state === 'ok' ? projects.manifest : null,
    }),
  };
}

/** Save this workspace's roles, as `roles set` does. Takes effect on the next pull. */
export async function saveRoles(ownConfig: LocalConfig, body: Record<string, unknown>): Promise<void> {
  assertRolesEditable(ownConfig);
  assertRevision(ownConfig, body);
  const { primaryRole, additionalRoles, version } = await roleChange(ownConfig.repo.localPath, body);
  await saveScopeSelection(ownConfig, { ...ownConfig, primaryRole, additionalRoles, resourceProfileVersion: version });
}

/** Save this workspace's active projects, as `projects set` does. An empty list is allowed. */
export async function saveProjects(ownConfig: LocalConfig, body: Record<string, unknown>): Promise<void> {
  assertRevision(ownConfig, body);
  await saveScopeSelection(ownConfig, { ...ownConfig, projects: await projectChange(ownConfig.repo.localPath, body) });
}
