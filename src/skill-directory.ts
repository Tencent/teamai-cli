// Whether delivery may write a skill directory: the path itself, and every link on the way to it from the base.
import path from 'node:path';
import { lstat, realpath } from 'node:fs/promises';
import { resolveAnchors } from './utils/git.js';

/** Why delivery may not write a skill directory: the path itself, or a link on the way to it. */
export type SkillDirectoryBlock =
  | { kind: 'outside-base'; target: string; baseDir: string }
  | { kind: 'not-directory'; path: string }
  | { kind: 'members-link'; link: string }
  | { kind: 'broken-link'; link: string }
  | { kind: 'link-outside-base'; link: string; resolved: string; baseDir: string }
  | { kind: 'link-to-other-repository'; link: string; resolved: string };

/**
 * Root links may share skills under the base within one repository (its checkouts share a project
 * identity); a skill's own link remains the member's.
 * Delivery and every team-skill delete apply it, so a root redirected outside the checkout is neither written nor emptied.
 * Null when `target` may be written; otherwise the reason, naming the path or link that stops it.
 */
export async function findSkillDirectoryBlock(
  baseDir: string,
  target: string,
  { keepSkillLink = false } = {},
): Promise<SkillDirectoryBlock | null> {
  const relative = path.relative(baseDir, target);

  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return { kind: 'outside-base', target, baseDir };
  let walked = baseDir;

  for (const segment of relative.split(path.sep).filter(Boolean)) {
    walked = path.join(walked, segment);
    const entry = await lstat(walked).catch((e: NodeJS.ErrnoException) => e.code === 'ENOENT' ? null : Promise.reject(e));

    if (!entry) break;

    if (!entry.isSymbolicLink()) {
      // A file at the skill itself is judged by ownership, as before.
      if (!entry.isDirectory() && walked !== target) return { kind: 'not-directory', path: walked };
      continue;
    }

    // Team-skill ownership checks name and preserve a leaf link without following it.
    if (walked === target) return keepSkillLink ? null : { kind: 'members-link', link: walked };
    const resolved = await realpath(walked).catch(() => null);

    if (!resolved) return { kind: 'broken-link', link: walked };
    const base = await realpath(baseDir);
    const rel = path.relative(base, resolved);

    if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return { kind: 'link-outside-base', link: walked, resolved, baseDir };
    const [from, to] = await Promise.all([resolveAnchors(base), resolveAnchors(resolved)]);

    // Outside Git (a user-scope home), staying under the base is enough.
    if (from && from.repoAnchor !== to?.repoAnchor) return { kind: 'link-to-other-repository', link: walked, resolved };
  }

  return null;
}

/** Whether delivery may write `target` (`findSkillDirectoryBlock` finds nothing in the way). */
export async function allowsSkillDirectory(baseDir: string, target: string, options: { keepSkillLink?: boolean } = {}): Promise<boolean> {
  return await findSkillDirectoryBlock(baseDir, target, options) === null;
}

/** The warning for a skill delivery skips at `block`. */
export function describeSkippedSkillDirectory(skillName: string, tool: string, block: SkillDirectoryBlock): string {
  const why = describeSkillDirectoryBlock(block);

  const next = block.kind === 'members-link'
    ? 'Remove the link to let teamai deliver this skill.'
    : block.kind === 'not-directory'
    ? 'Move the file aside and run `teamai pull` again.'
    : 'Point the skill directory inside the same repository.';

  return `Skipped ${skillName} (${tool}): ${why}. ${next}`;
}

export function describeSkillDirectoryBlock(block: SkillDirectoryBlock): string {
  switch (block.kind) {
    case 'not-directory': return `${block.path} is not a directory; the existing file was left unchanged`;
    case 'outside-base': return `${block.target} is outside ${block.baseDir}`;
    case 'members-link': return `${block.link} is your own link`;
    case 'broken-link': return `${block.link} is a link whose target does not exist`;
    case 'link-outside-base': return `${block.link} links to ${block.resolved}, outside ${block.baseDir}`;
    case 'link-to-other-repository': return `${block.link} links to ${block.resolved}, in another repository`;
    default: {
      const unhandled: never = block;

      return unhandled;
    }
  }
}
