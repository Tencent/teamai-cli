import type { LocalConfig } from './types.js';
import {
  loadRolesManifest,
  resolveRoleResourceNamespaces,
  roleNamespaceEntries,
  RolesManifestNotFoundError,
  type ResourceNamespaces,
  type RolesManifest,
} from './roles.js';
import { loadProjectsManifest, resolveProjectResourceNamespaces, mergeNamespaces, projectNamespaceEntries, type AllProjectResourceType } from './projects.js';
import { isNestedPlaceableType, NAMESPACE_AXIS, type PlaceableType } from './push-namespaces.js';
import { assertNoCaseAliasedNamespaces } from './manifest-schema.js';
import { warnOnce } from './utils/warn-once.js';
import { deliveredMembers } from './workspace-children.js';

type ResolvedResourceNamespaces = NonNullable<Awaited<ReturnType<typeof resolveOwnResourceNamespaces>>>;

/**
 * Resolve the same role/project activation policy for resource pull and push.
 *
 * The fallback warnings are said once per run: a pull resolves this for every
 * type and again for hooks, MCP and models after the scopes.
 */
export async function resolveResourceNamespaces(localConfig: LocalConfig): Promise<ResolvedResourceNamespaces | null> {
  const members = await deliveredMembers(localConfig);
  if (!members) return resolveOwnResourceNamespaces(localConfig);
  // A workspace with children (#913): each member resolves as its own scope
  // would, and the workspace activates what any of them does. A member that
  // receives everything unfiltered makes the workspace receive everything.
  const resolved: ResolvedResourceNamespaces[] = [];
  for (const member of members) {
    const one = await resolveOwnResourceNamespaces(member);
    if (!one) return null;
    resolved.push(one);
  }
  const [first, ...rest] = resolved;
  if (!first) return null;
  const inAll = (lists: readonly (readonly string[])[]): string[] => (lists[0] ?? []).filter((item) => lists.every((list) => list.includes(item)));
  return {
    activeNamespaces: rest.reduce((union, one) => mergeNamespaces(union, one.activeNamespaces), first.activeNamespaces),
    allSkillNamespaces: first.allSkillNamespaces,
    inactiveDocsNamespaces: inAll(resolved.map((one) => one.inactiveDocsNamespaces)),
    inactiveWikiNamespaces: inAll(resolved.map((one) => one.inactiveWikiNamespaces)),
    inactivePromptsNamespaces: inAll(resolved.map((one) => one.inactivePromptsNamespaces)),
    inactiveScorersNamespaces: inAll(resolved.map((one) => one.inactiveScorersNamespaces)),
  };
}

async function resolveOwnResourceNamespaces(localConfig: LocalConfig) {
  const activeProjects = localConfig.projects ?? [];
  const primaryRole = localConfig.primaryRole;
  const hasRole = !!primaryRole;
  const hasProjects = activeProjects.length > 0;

  // Load the projects manifest up front: its mere existence means this team uses
  // project partitioning, which changes the "no active filter" semantics below.
  const projectsManifest = await loadProjectsManifest(localConfig.repo.localPath);
  const teamHasProjects = !!projectsManifest && projectsManifest.projects.length > 0;

  // roles.yaml is read for every member, before any early return. A member with
  // a role is filtered by it; a role-less one is still gated by it twice over:
  // the legacy migration assigns a manifest-declared `hai` role (and skips, with
  // a warning, when the manifest does not parse), and the manifest shares
  // skills/, knowledge/ and agents/ with projects.yaml, so a project's `Common`
  // collides with a role's `common` whether or not this member holds that role.
  let rolesManifest: RolesManifest | null = null;
  try {
    rolesManifest = await loadRolesManifest(localConfig.repo.localPath);
  } catch (error) {
    // Only an ABSENT manifest degrades to unfiltered delivery. One that exists
    // and does not parse must not: every path below this point would treat the
    // roles as "no filter" and deliver the namespaces the manifest was written
    // to gate. Let it fail the scope's pull, as an invalid projects manifest
    // already does.
    if (!(error instanceof RolesManifestNotFoundError)) throw error;
    if (primaryRole) warnOnce('Roles manifest not found. Skipping role-based filtering.');
  }

  // When there is nothing to filter by AND the team does not use project
  // partitioning, keep the legacy unfiltered behavior (null = sync everything).
  //
  // But if the team HAS a projects manifest, a directory with no active project
  // is NOT the same as a pre-project legacy config: deactivating projects (via
  // `teamai projects set` with no ids) must scope down to role-only + shared
  // resources and CLEAN UP the resources of the projects it left — never fall
  // through to an unfiltered sync that reinstalls every project's skills/rules.
  // So we return a real (possibly empty-active) context and let the cleanup path
  // below prune the now-inactive project namespaces.
  if (!hasRole && !hasProjects && !teamHasProjects) return null;

  // ── Role namespaces (optional) ──
  let roleNamespaces: ResourceNamespaces = { knowledge: [], skills: [], learnings: [], agents: [] };
  let allRoleSkillNamespaces = new Set<string>();
  if (rolesManifest && projectsManifest) {
    // Each manifest is checked on its own when it loads; the two together share
    // the same skills/, knowledge/ and agents/ directories, so a role's
    // `frontend` and a project's `Frontend` collide just as two roles' would.
    assertNoCaseAliasedNamespaces(
      [...roleNamespaceEntries(rolesManifest), ...projectNamespaceEntries(projectsManifest)],
      'manifests (roles.yaml with projects.yaml)',
    );
  }
  if (primaryRole) {
    if (rolesManifest) {
      try {
        roleNamespaces = resolveRoleResourceNamespaces({
          manifest: rolesManifest,
          primaryRole,
          additionalRoles: localConfig.additionalRoles ?? [],
        });
        allRoleSkillNamespaces = new Set(rolesManifest.roles.flatMap((role) => role.resources.skills));
      } catch {
        warnOnce(`Role "${localConfig.primaryRole}" not found in manifest. Falling back to unfiltered sync.`);
        warnOnce('Run `teamai roles set <role>` to pick a valid role.');
        // A misconfigured role, with nothing else to scope by, can't filter safely.
        if (!hasProjects && !teamHasProjects) return null;
      }
    } else if (!hasProjects && !teamHasProjects) {
      return null;
    }
  }

  // ── Project namespaces ──
  // Populate the full set of project skill namespaces from the manifest whenever
  // the team defines projects — even with none active — so every non-selected
  // project namespace is treated as inactive and cleaned up below. The ACTIVE
  // namespaces come only from the projects this directory selected.
  let projectNamespaces: ResourceNamespaces = { knowledge: [], skills: [], learnings: [], agents: [] };
  let allProjectSkillNamespaces = new Set<string>();
  if (projectsManifest) {
    allProjectSkillNamespaces = new Set(projectsManifest.projects.flatMap((p) => p.resources.skills));
    if (hasProjects) {
      try {
        projectNamespaces = resolveProjectResourceNamespaces({
          manifest: projectsManifest,
          activeProjects,
        });
      } catch (e) {
        warnOnce(`${e instanceof Error ? e.message : String(e)} Falling back to role-only filtering.`);
      }
    }
  } else if (hasProjects) {
    warnOnce('Active projects configured but no projects manifest found. Skipping project-based filtering.');
  }

  const activeNamespaces = mergeNamespaces(roleNamespaces, projectNamespaces);

  // Skill activation set spans BOTH dimensions: a skill is inactive only if it
  // lives in a namespace that neither an active role nor an active project selects.
  const allSkillNamespaces = new Set<string>([...allRoleSkillNamespaces, ...allProjectSkillNamespaces]);

  // Docs are declared, not held: a docs/<dir>/ that ANY role or project lists is
  // a namespace, whether or not this member holds that role, and reaches only
  // the members who have it active. Every other docs/<dir>/ stays shared.
  const declaredDocsNamespaces = new Set<string>([
    ...(rolesManifest?.roles ?? []).flatMap((role) => role.resources.docs ?? []),
    ...(projectsManifest?.projects ?? []).flatMap((project) => project.resources.docs ?? []),
  ]);
  const activeDocs = new Set(activeNamespaces.docs ?? []);
  const inactiveDocsNamespaces = [...declaredDocsNamespaces].filter((namespace) => !activeDocs.has(namespace));

  // Wiki codebase slugs follow the same declared-vs-active rule as docs (#912):
  // a slug ANY role or project lists under `resources.wiki` reaches only the
  // members who have it active; an undeclared slug stays shared.
  const declaredWikiNamespaces = new Set<string>([
    ...(rolesManifest?.roles ?? []).flatMap((role) => role.resources.wiki ?? []),
    ...(projectsManifest?.projects ?? []).flatMap((project) => project.resources.wiki ?? []),
  ]);
  const activeWiki = new Set(activeNamespaces.wiki ?? []);
  const inactiveWikiNamespaces = [...declaredWikiNamespaces].filter((namespace) => !activeWiki.has(namespace));

  // Prompts follow the same declared-vs-active rule as docs and wiki: a
  // prompts/<dir>/ anyone lists under `resources.prompts` is a namespace, and a
  // workflow resolves a nested prompt below it; every other directory is shared
  // content, which a placement may still move into a namespace.
  const declaredPromptsNamespaces = new Set<string>([
    ...(rolesManifest?.roles ?? []).flatMap((role) => role.resources.prompts ?? []),
    ...(projectsManifest?.projects ?? []).flatMap((project) => project.resources.prompts ?? []),
  ]);
  const activePrompts = new Set(activeNamespaces.prompts ?? []);
  const inactivePromptsNamespaces = [...declaredPromptsNamespaces].filter((namespace) => !activePrompts.has(namespace));

  // Which scorers/<dir>/ is a namespace is `isNamespaceDir`'s rule; the scorer
  // cache withholds this set.
  const declaredScorersNamespaces = new Set<string>([
    ...(rolesManifest?.roles ?? []).flatMap((role) => role.resources.scorers ?? []),
    ...(projectsManifest?.projects ?? []).flatMap((project) => project.resources.scorers ?? []),
  ]);
  const activeScorers = new Set(activeNamespaces.scorers ?? []);
  const inactiveScorersNamespaces = [...declaredScorersNamespaces].filter((namespace) => !activeScorers.has(namespace));

  return {
    activeNamespaces,
    allSkillNamespaces,
    inactiveDocsNamespaces,
    inactiveWikiNamespaces,
    inactivePromptsNamespaces,
    inactiveScorersNamespaces,
  };
}

/** What the roles and projects manifests declare, as far as `isNamespaceDir` needs it. */
export interface NamespaceDeclarations {
  /** True when any role or project declares `namespace` on `axis`. */
  declares(axis: AllProjectResourceType, namespace: string): boolean;
  /** True when there is neither a roles nor a projects manifest. */
  readonly manifestFree: boolean;
}

/**
 * Whether `<type>/<dir>/` is a namespace rather than shared content. Most types namespace their first directory by
 * construction. docs, wiki and prompts nest freely, so a directory is a namespace only where a role or project declares
 * it. Scorers are flat files and follow prompts, except that with no manifest at all every directory is a namespace.
 */
export function isNamespaceDir(type: PlaceableType, dir: string, declarations: NamespaceDeclarations): boolean {
  if (type === 'scorers') return declarations.manifestFree || declarations.declares(NAMESPACE_AXIS.scorers, dir);
  if (isNestedPlaceableType(type)) return declarations.declares(NAMESPACE_AXIS[type], dir);
  return true;
}

/**
 * True in legacy mode: no role and no project filters this directory, so every
 * namespace is delivered beside the shared root. Callers use it to decide
 * whether a legacy-only step applies: withdrawing a placement record that a
 * shared-root file now shadows, or letting that root file keep its path. A
 * manifest that cannot be read answers false, the side that withdraws and
 * overwrites nothing; whatever needs the namespaces themselves reports it.
 */
export async function deliversEveryNamespace(localConfig: LocalConfig): Promise<boolean> {
  try {
    return await resolveResourceNamespaces(localConfig) === null;
  } catch {
    return false;
  }
}
