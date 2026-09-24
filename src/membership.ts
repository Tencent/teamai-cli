import { activeRoleIds, listRoleIds, loadRolesManifestIfPresent } from './roles.js';
import { activeProjectIds, listProjectIds, loadProjectsManifest } from './projects.js';
import { log } from './utils/logger.js';

/** The two axes an entry can be scoped on, and a member can be measured against. */
const AXES = ['roles', 'projects'] as const;

type Axis = typeof AXES[number];

/**
 * The two membership axes TeamAI resolves delivery on, for THIS member in THIS
 * directory. Roles come from `primaryRole` + `additionalRoles`; projects from
 * the directory's `projects` list.
 *
 * `null` on an axis means "this member has not configured that axis", which
 * matches every entry scoped on it — the same unfiltered fallback skills and
 * rules use, and the reason adding a `projects:` key changes nothing for a
 * member who has never run `teamai projects set`.
 */
export type Membership = Record<Axis, string[] | null>;

/**
 * The optional scoping keys an entry (hook, MCP server, env variable) may carry.
 * The mirror image of `Membership`: this is what the entry demands, that is what
 * the member holds.
 */
export type EntryScope = Partial<Record<Axis, string[]>>;

/**
 * Both membership axes for this member, resolved once per run. Each axis is
 * read by the module that owns it, so this adds no third spelling of either.
 */
export function resolveMembership(
  localConfig: { primaryRole?: string; additionalRoles?: string[]; roleUnresolved?: true; projects?: string[] },
): Membership {
  return {
    roles: activeRoleIds(localConfig),
    projects: activeProjectIds(localConfig),
  };
}

/**
 * Does one axis of an entry apply to this member? Omitted = everyone, and
 * otherwise the entry and the member must share at least one id.
 *
 * A null active set means the member has not configured that axis, and then
 * everything matches — including an entry scoped `[]`. That is pre-existing
 * `matchesRoles` behaviour, kept deliberately rather than quietly changed: an
 * empty list reaches nobody among members who DO use the axis, which is the
 * case teams actually write it for. See the note on `[]` in the usage guide.
 */
function matchesAxis(entryKeys: string[] | undefined, active: string[] | null): boolean {
  if (!entryKeys || active == null) return true;
  return entryKeys.some((key) => active.includes(key));
}

/**
 * Does an entry with optional `roles:` and `projects:` lists apply to this
 * member? The two axes compose as AND: a `roles: [frontend] projects: [checkout]`
 * entry reaches frontend members of checkout, not everyone on either.
 *
 * That is the same composition `tools:` and `roles:` already have, and it is
 * deliberately NOT the union that `mergeNamespaces` applies to role and project
 * resource namespaces — which answers the different question of which
 * directories to sync, rather than filtering one entry.
 *
 * Taking the whole entry, rather than one axis at a time, is what makes
 * "filtered on roles, forgot projects" unrepresentable at a call site.
 */
export function matchesMembership(entry: EntryScope, membership: Membership): boolean {
  return AXES.every((axis) => matchesAxis(entry[axis], membership[axis]));
}

/**
 * The ids each axis's manifest defines, or `null` when the team has no such
 * manifest. Throws when a manifest exists but does not load, which the caller
 * reports rather than swallows.
 */
const KNOWN_IDS: Record<Axis, (repoPath: string) => Promise<string[] | null>> = {
  roles: async (repoPath) => {
    const manifest = await loadRolesManifestIfPresent(repoPath);
    return manifest ? listRoleIds(manifest) : null;
  },
  projects: async (repoPath) => {
    const manifest = await loadProjectsManifest(repoPath);
    return manifest ? listProjectIds(manifest) : null;
  },
};

/** The manifest file each axis is defined in, for warning text. */
const MANIFEST_FILE: Record<Axis, string> = {
  roles: 'manifest/roles.yaml',
  projects: 'manifest/projects.yaml',
};

/** `${file}:${axis}:${id}` keys already reported in this process (pull runs each
 *  reconciler once per scope; the member should read the warning once). */
const reportedUnknownIds = new Set<string>();

/** Test seam: clear the once-per-process warning memory. */
export function __resetMembershipWarnings(): void {
  reportedUnknownIds.clear();
}

function warnOnce(dedupeKey: string, message: string): void {
  if (reportedUnknownIds.has(dedupeKey)) return;
  reportedUnknownIds.add(dedupeKey);
  log.warn(message);
}

/**
 * Warn once per pull for each id an entry's `roles:` or `projects:` names that
 * the matching manifest does not define. A typo would otherwise ship the entry
 * to nobody in silence. Never fails the run.
 *
 * Three outcomes per axis, because they mean different things to a maintainer:
 *
 *   manifest loads       an id it does not define is a typo; name the valid ones
 *   manifest is absent   nothing to check against. For projects this is worth
 *                        saying, since a directory bound to no project then
 *                        receives every entry. For roles it is ordinary: plenty
 *                        of teams run without roles.yaml, so it stays silent.
 *   manifest is broken   report the loader's own reason. Reducing this to
 *                        "no manifest" would state something false and throw
 *                        away the only message that says what to fix.
 *
 * Note an absent projects manifest does NOT mean the key stops restricting. A
 * directory's active projects come from its own config.yaml, so a directory
 * bound to `billing` still filters out a `projects: [checkout]` entry. What is
 * lost is the ability to validate the ids.
 */
export async function warnUnknownMembershipIds(
  repoPath: string,
  file: string,
  entries: Array<{ kind: string; name: string } & EntryScope>,
): Promise<void> {
  for (const axis of AXES) {
    const scoped = entries.filter((entry) => entry[axis]?.length);
    if (scoped.length === 0) continue;

    let known: string[] | null;
    try {
      known = await KNOWN_IDS[axis](repoPath);
    } catch (error) {
      warnOnce(
        `${file}:${axis}:<unreadable>`,
        `${axis}: ${MANIFEST_FILE[axis]} could not be read, so the "${axis}:" ids in ${file} cannot be checked. `
        + `${error instanceof Error ? error.message : String(error)}`,
      );
      continue;
    }

    if (known === null || known.length === 0) {
      if (axis === 'projects') {
        warnOnce(
          `${file}:projects:<no-manifest>`,
          `projects: ${MANIFEST_FILE.projects} defines no projects, so the "projects:" ids on ${scoped.length} `
          + `${file} ${scoped.length === 1 ? 'entry' : 'entries'} cannot be checked, and every directory bound `
          + 'to no project receives them. Define the projects there, or drop the key.',
        );
      }
      continue;
    }

    for (const entry of scoped) {
      for (const id of entry[axis] ?? []) {
        if (known.includes(id)) continue;
        warnOnce(
          `${file}:${axis}:${id}`,
          `${axis}: unknown ${axis === 'roles' ? 'role' : 'project'} id "${id}" in ${file} ${entry.kind} `
          + `"${entry.name}". Valid ${axis}: ${known.join(', ')}`,
        );
      }
    }
  }
}
