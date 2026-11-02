import path from 'node:path';
import type { LocalConfig } from './types.js';
import {
  findRole,
  listRoleIds,
  loadRolesManifest,
  NAMESPACED_RESOURCE_TYPES,
  resolveRoleResourceNamespaces,
  roleNamespaceEntries,
  RolesManifestNotFoundError,
  type ResourceNamespaces,
  type RolesManifest,
} from './roles.js';
import { loadProjectsManifest, resolveProjectResourceNamespaces, mergeNamespaces, projectNamespaceEntries, type AllProjectResourceType } from './projects.js';
import { isNestedPlaceableType, NAMESPACE_AXIS, type PlaceableType } from './push-namespaces.js';
import { assertNoCaseAliasedNamespaces } from './manifest-schema.js';
import { listDirs } from './utils/fs.js';
import { warnOnce } from './utils/warn-once.js';
import { deliveredMembers } from './workspace-children.js';

type ResolvedResourceNamespaces = NonNullable<Awaited<ReturnType<typeof resolveOwnResourceNamespaces>>>;

/** Every type a role or project namespaces. */
type NamespacedType = (typeof NAMESPACED_RESOURCE_TYPES)[number] | 'learnings';

/**
 * Whose roles each namespaced type follows in a workflow copy that runs with a team role (`stepRole`). `knowledge`, what
 * the agent knows, follows that role; `channel`, what it may execute or reach, and `discovery`, what the member can run
 * or find, follow the member's own roles, so a role never grants a capability the member's roles do not. Projects apply
 * to all three. Exhaustive: a new namespaced type fails to compile until it is classified here.
 */
const STEP_ROLE_PURPOSE = {
  knowledge: 'knowledge', skills: 'knowledge', agents: 'knowledge', docs: 'knowledge', wiki: 'knowledge', learnings: 'knowledge',
  env: 'channel', hooks: 'channel', mcp: 'channel', models: 'channel',
  workflows: 'discovery', prompts: 'discovery', scorers: 'discovery', benchmarks: 'discovery',
} as const satisfies Record<NamespacedType, 'knowledge' | 'channel' | 'discovery'>;

/**
 * Whether the member's personal filters, the tags they subscribe to and the skills they exclude, apply to what `config`
 * delivers. Not in a workflow copy that runs with a team role: it gets the role's knowledge as the role defines it, so
 * the same role knows the same for every member. In a workspace with children this holds for the workspace's own
 * filters and for each child's.
 */
export function usesMemberFilters(config: Pick<LocalConfig, 'stepRole'>): boolean {
  return config.stepRole === undefined;
}

/**
 * The namespaces of `member`'s roles with each knowledge type replaced by `stepRole`'s. A role the manifest does not
 * declare throws: a copy recorded to run with a role never falls back to the member's knowledge or to everything.
 */
export function withStepRoleKnowledge(manifest: RolesManifest | null, stepRole: string, member: ResourceNamespaces): ResourceNamespaces {
  if (!manifest) {
    throw new Error(`This workflow copy runs with role "${stepRole}", but the team repo has no manifest/roles.yaml to declare it, so nothing is delivered for it. Declare the role in manifest/roles.yaml, or run the step without a role.`);
  }

  if (!findRole(manifest, stepRole)) {
    throw new Error(`This workflow copy runs with role "${stepRole}", which manifest/roles.yaml does not declare (it declares ${listRoleIds(manifest).join(', ')}), so nothing is delivered for it. Add the role to manifest/roles.yaml, or run the step with a role it declares.`);
  }

  const step = resolveRoleResourceNamespaces({ manifest, primaryRole: stepRole, additionalRoles: [] });
  const resolved: ResourceNamespaces = { ...member };

  for (const type of [...NAMESPACED_RESOURCE_TYPES, 'learnings' as const]) {
    if (STEP_ROLE_PURPOSE[type] === 'knowledge') resolved[type] = step[type] ?? [];
  }

  return resolved;
}

/**
 * What a member with no role and no project to filter by finds of each discovery type, which a copy of theirs that runs
 * with a team role keeps: every namespace directory of that type in the team repo, as the workflow, prompt and scorer
 * caches read it with no filter, and for benchmarks every namespace a role declares, as the suite cache does. Channels
 * stay empty, as the member's own: with no filter, env, hooks, MCP and models deliver their root file only
 * (`resolveEntries`). Knowledge stays empty: the step role replaces it.
 */
async function everyDiscoveryNamespace(repoPath: string, manifest: RolesManifest | null): Promise<ResourceNamespaces> {
  const every: ResourceNamespaces = { knowledge: [], skills: [], learnings: [], agents: [] };

  for (const type of NAMESPACED_RESOURCE_TYPES) {
    const purpose = STEP_ROLE_PURPOSE[type];

    switch (purpose) {
      case 'knowledge':
      case 'channel':
        break;
      case 'discovery':
        every[type] = type === 'benchmarks'
          ? [...new Set((manifest?.roles ?? []).flatMap((role) => role.resources.benchmarks ?? []))]
          : (await listDirs(path.join(repoPath, type))).toSorted();
        break;
      default: {
        const unhandled: never = purpose;

        return unhandled;
      }
    }
  }

  return every;
}

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
  // The team assigns this member's roles (#1186). Every unfiltered fallback
  // below is then closed: a member the team assigned no roles — or whose
  // assignment names a role the manifest dropped — receives the shared root
  // only. Falling through to "sync everything" would hand back exactly what
  // assigning roles was meant to take away.
  const rolesAssigned = !!localConfig.roleAssignment;

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
  // A copy that runs with a team role is filtered by that role whatever the member holds, but only for knowledge: a
  // member with nothing to filter by keeps the discovery and channels such a member has there too.
  const { stepRole } = localConfig;
  let memberResolvesNoFilter = !rolesAssigned && !hasRole && !hasProjects && !teamHasProjects;

  if (memberResolvesNoFilter && stepRole === undefined) return null;

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
        warnOnce(`Role "${localConfig.primaryRole}" not found in manifest.`
          + (rolesAssigned ? ' Delivering shared resources only.' : ' Falling back to unfiltered sync.'));

        if (!rolesAssigned) warnOnce('Run `teamai roles set <role>` to pick a valid role.');

        // A misconfigured role, with nothing else to scope by, can't filter safely.
        if (!rolesAssigned && !hasProjects && !teamHasProjects) {
          if (stepRole === undefined) return null;
          memberResolvesNoFilter = true;
        }
      }
    } else if (!rolesAssigned && !hasProjects && !teamHasProjects) {
      if (stepRole === undefined) return null;
      memberResolvesNoFilter = true;
    }
  }

  if (stepRole !== undefined) {
    const member = memberResolvesNoFilter ? await everyDiscoveryNamespace(localConfig.repo.localPath, rolesManifest) : roleNamespaces;

    roleNamespaces = withStepRoleKnowledge(rolesManifest, stepRole, member);
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
