// The skill names the CLI itself ships or once shipped, which are never a member's own skill to push or keep.

/**
 * Names of CLI built-in skills. Used by push to exclude them from team repo
 * push, by pull cleanup, and by uninstall.
 */
export const BUILTIN_SKILL_NAMES = new Set(['teamai']);

/**
 * Built-in skill directories earlier releases deployed, kept only so that pull
 * can remove them from agent skills directories. Retire this set once 0.25.x,
 * the last release to deploy them, is no longer in the field.
 *
 * Only names the CLI actually wrote belong here. `teamai-workflow` and
 * `teamai-import` were reserved in the old BUILTIN_SKILL_NAMES guard but never
 * packaged, so a directory by either name is a user's own skill and must not be
 * removed.
 */
export const LEGACY_BUILTIN_SKILL_NAMES = new Set([
  'teamai-share-learnings',
  'team-wiki-codebase',
]);

/**
 * The legacy directory that depended on recall. `teamai recall disable` still
 * removes it, as it did before the stub, so a member who upgrades and disables
 * recall before their next pull is not left with the old share workflow.
 */
export const LEGACY_RECALL_SKILL_NAMES = new Set(['teamai-share-learnings']);

/**
 * Whether a skill directory by this name is the CLI's, current or legacy, and
 * therefore never a user's own to push. A member who runs `teamai push --all`
 * after upgrading but before pulling still has the legacy trees on disk.
 */
export function isCliOwnedSkillName(name: string): boolean {
  return BUILTIN_SKILL_NAMES.has(name) || LEGACY_BUILTIN_SKILL_NAMES.has(name);
}
