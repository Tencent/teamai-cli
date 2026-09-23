/**
 * Namespace placement for `teamai push`.
 *
 * The team repo scopes a resource by its first directory under the resource
 * root: `skills/<ns>/<name>/`, `rules/<ns>/<name>.md`, `agents/<ns>/<name>.yaml`.
 * `pull` filters each of those against the member's active namespaces, and a
 * resource written to the shared root ships to everyone.
 *
 * Push therefore has to decide, per resource type, which namespace a brand-new
 * resource lands in. That decision used to be inlined in `pushCore` for skills
 * alone, which is why a rule or an agent pushed with `--role`/`--project` still
 * reached the whole team (issue #649). It lives here so every type answers the
 * same question the same way, and so the answer can be tested without a repo.
 */
import {
  isSafeNamespaceSegment, findProject, unknownProjectMessage,
  type ProjectResourceType, type ProjectsManifest,
} from './projects.js';
import type { ResourceItem, ResourceType } from './types.js';

/** Resource types `pull` namespaces, and push therefore has to place. */
export type PlaceableType = 'skills' | 'rules' | 'agents';

export const PLACEABLE_TYPES: readonly PlaceableType[] = ['skills', 'rules', 'agents'];

export function isPlaceableType(type: ResourceType): type is PlaceableType {
  return (PLACEABLE_TYPES as readonly ResourceType[]).includes(type);
}

/**
 * The manifest axis each type is namespaced by. A rule is knowledge, not
 * skills: `ProjectResourceNamespacesSchema` lets a project declare different
 * namespaces for the two, so resolving a rule from `resources.skills` would
 * target the wrong directory (issue #649, comment 3).
 */
export const NAMESPACE_AXIS = {
  skills: 'skills',
  rules: 'knowledge',
  agents: 'agents',
} as const satisfies Record<PlaceableType, ProjectResourceType>;

/**
 * True when `item` would be written to the shared root — no namespace segment
 * between the resource root and the resource itself. Those are the only items
 * push places; anything already namespaced keeps the path it came with, since
 * `pushItem` writes rather than moves and relocating would leave the original
 * behind.
 */
export function isAtSharedRoot(item: ResourceItem): boolean {
  return item.relativePath.split('/').length === 2;
}

/**
 * Insert `namespace` after the resource root. Only the directory changes, so
 * the basename — `.yaml` or a legacy `.md` for agents, a bare directory name
 * for skills — survives without the caller knowing which it has.
 */
export function withNamespace(relativePath: string, namespace: string): string {
  const [root, ...rest] = relativePath.split('/');
  return [root, namespace, ...rest].join('/');
}

/**
 * Where a skill lands in `namespace`. Built from the root rather than through
 * `withNamespace`, because a skill's team path is derived from its name alone
 * (`src/resources/skills.ts` keeps the leaf as the name): this REPLACES any
 * namespace the item already carries, where `withNamespace` would insert a
 * second one.
 */
export function skillNamespacePath(namespace: string, name: string): string {
  return `skills/${namespace}/${name}`;
}

/** A namespace, or why one could not be resolved — phrased for the CLI user. */
export type NamespaceResolution =
  | { ok: true; namespace: string }
  | { ok: false; message: string };

/**
 * The namespace `--project <id>` places `type` in, read from that type's own
 * axis in `manifest/projects.yaml`.
 *
 * Returns a failure rather than throwing, and rather than falling back to the
 * shared root: a resource written to the root reaches the whole team, which is
 * the outcome the flag was used to avoid. The caller reports the message and
 * exits without pushing anything.
 */
export function resolveProjectNamespace(
  manifest: ProjectsManifest,
  projectId: string,
  type: PlaceableType,
): NamespaceResolution {
  const project = findProject(manifest, projectId);
  if (!project) {
    return { ok: false, message: unknownProjectMessage(manifest, projectId) };
  }

  const axis = NAMESPACE_AXIS[type];
  const namespaces = project.resources[axis];
  if (namespaces.length === 0) {
    return {
      ok: false,
      message: `Project "${projectId}" declares no ${axis} namespace, so there is nowhere to put the new ${type}. `
        + `Add one to manifest/projects.yaml, or use --role <ns> to target a namespace explicitly.`,
    };
  }
  if (namespaces.length > 1) {
    return {
      ok: false,
      message: `Project "${projectId}" maps ${type} to multiple ${axis} namespaces (${namespaces.join(', ')}); `
        + 'use --role <ns> to pick one.',
    };
  }

  const namespace = namespaces[0];
  if (!isSafeNamespaceSegment(namespace)) {
    return {
      ok: false,
      message: `Project "${projectId}" declares an unusable ${axis} namespace "${namespace}": `
        + "it must be a single path segment (letters, digits, '.', '_', '-'; no '/', '\\', or '..').",
    };
  }

  return { ok: true, namespace };
}

/**
 * Where push put a root-level local resource, from the record it kept in
 * `state.json` (`placedRules`, `placedAgents`). The author's copy stays at the
 * tool's resource root after a push places it under `<root>/<ns>/`, so without
 * this record the next scan reads it as a brand-new resource and sends a second
 * copy to the shared root — where it reaches the whole team (#649).
 *
 * Returns null unless the record is one push could have written: inside `root`,
 * namespaced, free of traversal, and named after `name`. `state.json` is a file
 * on disk, so a record that fails any of those is treated as absent rather than
 * followed. The caller still has to check that the file is there — a record
 * pointing at a removed or renamed resource proves nothing.
 *
 * Both the push scanner and the pre-push sync resolve through this. They must
 * agree: when only one of them followed the record, the sync skipped a
 * teammate's newer version and the scan then pushed the stale copy over it.
 */
export function placedResourcePath(
  placed: Record<string, string> | undefined,
  root: 'rules' | 'agents',
  name: string,
): string | null {
  // A name that already carries a namespace matches its team file by full path
  // and never needs a record.
  if (!placed || name.includes('/')) return null;

  const recorded = placed[name];
  if (!recorded) return null;

  const segments = recorded.split('/');
  if (segments.length !== 3) return null;
  if (segments[0] !== root) return null;
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) return null;
  // The namespace must be the same safe segment push itself would write. A
  // `\` in it is a separator on Windows, where `path.join` then walks out of
  // the resource root that the `/` split above seemed to confine it to.
  if (!isSafeNamespaceSegment(segments[1] ?? '')) return null;
  // Exactly the resource's own file: `<name>.md` for a rule, `<name>.yaml` or a
  // legacy `<name>.md` for an agent. A prefix test would accept
  // `<name>.backup.md` and redirect scanning, syncing and removal onto an
  // unrelated file that happens to sit there.
  const allowed = root === 'rules' ? [`${name}.md`] : [`${name}.yaml`, `${name}.md`];
  if (!allowed.includes(segments[2])) return null;

  return recorded;
}
