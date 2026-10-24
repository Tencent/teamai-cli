import path from 'node:path';
import YAML from 'yaml';
import { z } from 'zod';
import { caseFoldKey, emptyManifestError, parseManifest, parseManifestOnce, readManifestFile } from './manifest-schema.js';
import { getDefaultBranch, getFileContentAtRev, getHeadCommit } from './utils/git.js';

/** Where a team declares who holds which role. Relative to the team repo root. */
export const ROLE_ASSIGNMENTS_FILE = 'manifest/members.yaml';

/**
 * `manifest/members.yaml`: the roles each member holds, as team data.
 *
 * A role a member sets locally (`teamai roles set`) is their own choice, which
 * is fine while roles only pick what gets delivered. A team that also uses the
 * effective roles to bound what its agents may touch needs the assignment to be
 * a reviewed change in the team repo instead (#1186). Who may change it is the
 * forge's decision, as for `roles.yaml`: protected branch, merge request, code
 * owners for `manifest/`. teamai keeps no access list of its own.
 *
 * ```yaml
 * version: 1
 * members:
 *   alice: [frontend]
 *   bob: [backend, ki]
 * default: []   # roles of a member who is not listed
 * ```
 *
 * The first role listed is the member's primary role; the rest are additional.
 */
const RoleAssignmentsSchema = z.object({
  version: z.number(),
  members: z.record(z.string().min(1), z.array(z.string().min(1))).default({}),
  // A file that exists but lists nobody still governs: an unlisted member gets
  // `default`, which is empty unless the team says otherwise. Absent means the
  // same, never "every namespace" — that is the fail-closed half of #1096.
  default: z.array(z.string().min(1)).default([]),
});

export type RoleAssignments = z.infer<typeof RoleAssignmentsSchema>;

/** Where a member's effective roles came from, as `roles list --json` reports it. */
export type RoleSource = 'assigned' | 'default' | 'local' | 'none';

/**
 * The team repo has no `manifest/members.yaml` — a team that assigns no roles,
 * not a broken one. Only absence may leave the local selection in charge:
 * a file that exists but cannot be read or parsed must not, or an agent could
 * hand itself every role by making the file unreadable.
 */
export class RoleAssignmentsNotFoundError extends Error {
  constructor(manifestPath: string) {
    super(`Role assignments not found: ${manifestPath}`);
    this.name = 'RoleAssignmentsNotFoundError';
  }
}

function validateAssignments(raw: unknown): RoleAssignments {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Invalid members manifest: expected an object');
  }
  const manifest = parseManifest(RoleAssignmentsSchema, raw, 'members');

  // Two keys that differ only by case are one person to a forge that folds
  // usernames, and the member they describe would hold whichever the YAML
  // parser kept last. Say so instead of picking one.
  const seen = new Map<string, string>();
  for (const username of Object.keys(manifest.members)) {
    const key = caseFoldKey(username);
    const prior = seen.get(key);
    if (prior !== undefined && prior !== username) {
      throw new Error(
        `Invalid members manifest: "${prior}" and "${username}" differ only by case or Unicode normalization. `
        + 'Keep one entry per member',
      );
    }
    seen.set(key, username);
  }

  return manifest;
}

/**
 * The fetched default branch of a git-backed team repo, as a ref, or `null`
 * where there is none to read: an HTTP source, a repo with no remote, a clone
 * of an empty remote, a path git cannot open.
 */
async function fetchedDefaultBranch(repoPath: string): Promise<string | null> {
  try {
    const tip = `origin/${await getDefaultBranch(repoPath)}`;
    return (await getHeadCommit(repoPath, tip)) ? tip : null;
  } catch {
    return null;
  }
}

/**
 * The assignments are read from what the forge merged — `origin/<default>` as
 * last fetched — not from the clone's working tree. A local edit, a deletion
 * or an unpushed commit in the clone changes nothing, and a `members.yaml`
 * that only the working tree has is absent. Where no fetched default branch
 * exists, the working tree is all there is.
 */
export async function loadRoleAssignments(repoPath: string, repo: { kind?: string } = {}): Promise<RoleAssignments> {
  const manifestPath = path.join(repoPath, ...ROLE_ASSIGNMENTS_FILE.split('/'));
  // An HTTP source is materialized files with no git of its own; a probe there
  // would find whatever repository the directory sits in, such as the project's.
  const tip = repo.kind === 'http' ? null : await fetchedDefaultBranch(repoPath);
  let content: string | null;
  let where: string;
  if (tip) {
    where = `${ROLE_ASSIGNMENTS_FILE} at ${tip}`;
    // `./`: relative to the directory git runs in, which in single-repo mode
    // is `.teamai/` inside the business repo rather than its root.
    content = (await getFileContentAtRev(repoPath, tip, `./${ROLE_ASSIGNMENTS_FILE}`))?.toString('utf-8') ?? null;
    if (content !== null && content.trim() === '') throw emptyManifestError('members', where);
  } else {
    where = manifestPath;
    content = await readManifestFile(manifestPath, 'members');
  }
  if (content === null) throw new RoleAssignmentsNotFoundError(where);

  return parseManifestOnce(manifestPath, content, (text) => {
    let raw: unknown;
    try {
      raw = YAML.parse(text);
    } catch (error) {
      throw new Error(`Invalid members manifest YAML: ${(error as Error).message}`);
    }
    return validateAssignments(raw);
  });
}

/**
 * The role assignments, or `null` when the team has none. Absent is a value,
 * invalid is an error — the same contract `loadRolesManifestIfPresent` keeps.
 */
export async function loadRoleAssignmentsIfPresent(repoPath: string, repo: { kind?: string } = {}): Promise<RoleAssignments | null> {
  try {
    return await loadRoleAssignments(repoPath, repo);
  } catch (error) {
    if (error instanceof RoleAssignmentsNotFoundError) return null;
    throw error;
  }
}

/**
 * The roles the team assigned to `username`, primary first. A member the file
 * does not list gets `default`, which is usually no roles at all.
 *
 * The key is matched exactly: the manifest is checked for keys that differ only
 * by case when it loads, so an exact match is the only one that can be meant.
 */
export function resolveAssignedRoles(
  manifest: RoleAssignments,
  username: string,
): { roles: string[]; source: 'assigned' | 'default' } {
  const listed = Object.prototype.hasOwnProperty.call(manifest.members, username)
    ? manifest.members[username]
    : undefined;
  const roles = listed ?? manifest.default;
  return { roles: [...new Set(roles)], source: listed ? 'assigned' : 'default' };
}
