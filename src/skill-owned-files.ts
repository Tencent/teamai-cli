// The files of a skill directory the CLI provably wrote, by path and content, and their removal: pull's prune and
// uninstall remove only these, archived first, and leave a member's own file with its directory.
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { copyRegularTree, readRegularFile } from '@teamai/shared/regular-file';
import { errnoCode, pathExists, remove } from './utils/fs.js';
import { COPILOT_TOOL_ID } from './types.js';
import { openclawWorkspaceDir } from './locate.js';
import { toolHome } from './tool-home.js';
import { packagedSkillRoots } from './skill-content.js';
import { PACKAGED_SKILL_DIGESTS } from './packaged-skill-digests.js';
import { keepsTrackedCopy } from './resources/delivered-copies.js';
import { BUILTIN_SKILL_NAMES } from './cli-skill-names.js';
import { allowsSkillDirectory } from './skill-directory.js';

/**
 * The digest PACKAGED_SKILL_DIGESTS records for a file: sha256 of its bytes.
 * The whole file, frontmatter included: a member who changed only a skill's
 * name, description or allowed-tools changed the skill, and it is theirs.
 */
export function packagedSkillDigest(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

/** Digests by path: what `removeOwnedFiles` may remove, and only at that content. */
export type OwnedSkillFiles = ReadonlyMap<string, ReadonlySet<string>>;

/**
 * The files of `skillName` the CLI provably wrote — every version a release
 * shipped, plus, for the stub, the one this package ships now — optionally
 * narrowed to `paths`.
 */
export async function ownedSkillFiles(skillName: string, paths?: readonly string[]): Promise<OwnedSkillFiles> {
  const owned = new Map<string, Set<string>>();

  for (const [relative, digests] of PACKAGED_SKILL_DIGESTS.get(skillName) ?? []) {
    if (!paths || paths.includes(relative)) owned.set(relative, new Set(digests));
  }

  if (BUILTIN_SKILL_NAMES.has(skillName) && (!paths || paths.includes('SKILL.md'))) {
    const stubPath = path.join(packagedSkillRoots().deployRoot, skillName, 'SKILL.md');

    if (await pathExists(stubPath)) {
      const digests = owned.get('SKILL.md') ?? new Set<string>();
      digests.add(packagedSkillDigest(await readRegularFile(stubPath)));
      owned.set('SKILL.md', digests);
    }
  }

  return owned;
}

/** True when `file` sits at an owned path with content a release shipped there. */
export async function isOwnedFile(file: string, relative: string, owned: OwnedSkillFiles): Promise<boolean> {
  const digests = owned.get(relative);

  if (!digests) return false;

  return digests.has(packagedSkillDigest(await readRegularFile(file)));
}

/**
 * Python bytecode cache of a script we shipped: `a/__pycache__/x.cpython-311.pyc`
 * for an `a/x.py` present and proven ours by content. Compiler output of our
 * own file, so it carries nothing a member wrote and does not make a directory
 * theirs. Bytecode beside a member's edit of the script, or with no script at
 * all, is theirs.
 */
function isDerivedArtifact(relativePath: string, provenScripts: ReadonlySet<string>): boolean {
  const parts = relativePath.split('/');

  if (parts.length < 2 || parts[parts.length - 2] !== '__pycache__' || !relativePath.endsWith('.pyc')) return false;
  const stem = parts[parts.length - 1].split('.')[0];

  return provenScripts.has([...parts.slice(0, -2), `${stem}.py`].join('/'));
}

/**
 * Every file under `dir`, as paths relative to it. Symlinks count as files.
 * Not the shared walker in utils/fs: that one skips `__pycache__`, and the prune
 * has to see it to decide whether a directory is empty of the member's files.
 */
export async function walkFiles(dir: string, prefix = ''): Promise<string[]> {
  const found: string[] = [];

  for (const entry of await fs.promises.readdir(dir, { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;

    if (entry.isDirectory()) {
      found.push(...await walkFiles(path.join(dir, entry.name), relative));
    } else {
      found.push(relative);
    }
  }

  return found;
}

/**
 * Remove `dir` and every directory under it that holds nothing. A directory
 * that still has something in it stays, which is the point: that something is
 * the member's. Any other failure (permissions, a busy mount) is returned, so
 * the prune does not report a directory gone that is still there.
 */
async function removeEmptyDirs(dir: string): Promise<{ file: string; error: string }[]> {
  const failures: { file: string; error: string }[] = [];
  let entries;

  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch (e) {
    if (errnoCode(e) !== 'ENOENT') failures.push({ file: dir, error: e instanceof Error ? e.message : String(e) });

    return failures;
  }

  for (const entry of entries) {
    if (entry.isDirectory()) failures.push(...await removeEmptyDirs(path.join(dir, entry.name)));
  }

  try {
    await fs.promises.rmdir(dir);
  } catch (e) {
    // Not empty is the expected outcome for a directory holding the member's
    // files — and some platforms say EACCES for that under a read-only parent,
    // so the directory's contents, not the error code, decide.
    const code = errnoCode(e);

    const stillHolds = code === 'ENOTEMPTY' || code === 'EEXIST'
      || (await fs.promises.readdir(dir).catch(() => [])).length > 0;

    if (!stillHolds) failures.push({ file: dir, error: e instanceof Error ? e.message : String(e) });
  }

  return failures;
}

/** What `removeOwnedFiles` did and did not do, for the caller to report. */
export interface PruneResult {
  /** True when a link sits between the base and the skill directory: nothing was touched. */
  skippedSymlink: boolean;
  /** Files left in place because the member, not the CLI, put them there. */
  foreign: number;
  /** The CLI's files left in place because the repository tracks them, each named by `keepsTrackedCopy`. */
  tracked: number;
  /** Files left in place because their backup could not be written, and why. */
  unbackedUp: { file: string; error: string }[];
  /** Files archived but not deleted, leaving the tree half-pruned, and why. */
  notRemoved: { file: string; error: string }[];
  /** Whether anything was actually copied, so a log only names a backup that exists. */
  backedUp: number;
}

/** True when the directory is gone: nothing of the member's, nothing unsaved. */
export function prunedWhole(result: PruneResult): boolean {
  return !result.skippedSymlink
    && result.foreign === 0
    && result.tracked === 0
    && result.unbackedUp.length === 0
    && result.notRemoved.length === 0;
}

/**
 * Remove from `dir` the files the CLI put there, then the directories that end
 * up empty. Anything that stopped it — a member's own file, a failed backup, a
 * failed delete, a link — is in the result, so the caller can say which.
 *
 * Exported because uninstall must delete a CLI-owned skill directory by the same
 * rule pull does: a file a member added beside our packaged ones was never ours
 * to write and is not ours to remove, whichever command is doing the removing.
 */
export async function removeOwnedFiles(
  dir: string,
  owned: OwnedSkillFiles,
  baseDir: string,
  backupDir?: string,
): Promise<PruneResult> {
  const result: PruneResult = {
    skippedSymlink: false, foreign: 0, tracked: 0, unbackedUp: [], notRemoved: [], backedUp: 0,
  };

  // Root links may stay within this repository; foreign and skill links are not owned.
  if (!await allowsSkillDirectory(baseDir, dir)) {
    result.skippedSymlink = true;

    return result;
  }

  let entries: string[];

  try {
    entries = await walkFiles(dir);
  } catch (e) {
    // Another tool may have removed this same tree through an allowed root alias.
    if (errnoCode(e) === 'ENOENT') return result;
    // An unreadable subdirectory. Reporting it is the point: a silent return
    // leaves the tree in place while `pull` says it succeeded.
    result.notRemoved.push({ file: dir, error: e instanceof Error ? e.message : String(e) });

    return result;
  }

  // Decide ownership before removing anything: bytecode is ours only beside a
  // script proven ours, and that proof has to be taken while the script is
  // still there.
  const proven = new Set<string>();

  for (const relative of entries) {
    const file = path.join(dir, relative);

    try {
      // Ours only at a path a release shipped *and* with content one of them
      // shipped there. A member's edit, or a skill of their own that uses a
      // packaged name under a root TeamAI never managed, fails the second test
      // and stays, with its directory. No release shipped a symlink.
      if (!(await fs.promises.lstat(file)).isSymbolicLink() && await isOwnedFile(file, relative, owned)) proven.add(relative);
    } catch (e) {
      // Unreadable, so unprovable: kept, and said so.
      result.notRemoved.push({ file, error: e instanceof Error ? e.message : String(e) });
    }
  }

  for (const relative of entries) {
    const file = path.join(dir, relative);

    if (result.notRemoved.some((failure) => failure.file === file)) continue;

    const owns = proven.has(relative)
      || (isDerivedArtifact(relative, proven) && !(await fs.promises.lstat(file)).isSymbolicLink());

    if (!owns) {
      result.foreign++;
      continue;
    }

    // Ours, but a file the repository tracks is never deleted (#915); named there.
    if (await keepsTrackedCopy(file)) {
      result.tracked++;
      continue;
    }

    // Content proves the CLI wrote the file; a copy still goes to the archive
    // before the delete, so no removal is a one-way door.
    if (backupDir) {
      try {
        // `existing: 'fail'` turns a colliding path into a failure rather than a
        // silent overwrite: a lost copy would be the data loss this exists to
        // prevent, wearing the log line of a success.
        await copyRegularTree(file, path.join(backupDir, relative), { existing: 'fail' });
        result.backedUp++;
      } catch (e) {
        // A full disk, a read-only home, a colliding copy. Keep the file: a
        // backup that did not happen must not authorise the delete.
        result.unbackedUp.push({ file, error: e instanceof Error ? e.message : String(e) });
        continue;
      }
    }

    try {
      await remove(file);
    } catch (e) {
      // A read-only parent. The archive holds the copy, but the original stays,
      // so the tree is half-pruned: say so rather than let a debug line carry it.
      result.notRemoved.push({ file, error: e instanceof Error ? e.message : String(e) });
    }
  }

  result.notRemoved.push(...await removeEmptyDirs(dir));

  return result;
}

/**
 * The base the link guard walks down from: the scope root — home, or the
 * project root — when `skillsDir` sits under it, since a link at or above that
 * is ordinary. Not the tool's home: for Copilot that is
 * `COPILOT_HOME`, and starting there would never check whether `COPILOT_HOME`
 * itself is a link. A root outside the scope root has the walk start at the
 * parent of the tool home holding it (`COPILOT_HOME`, `HERMES_HOME`, the
 * OpenClaw workspace), however deep the skills path below it, so that home is
 * checked too.
 */
export async function skillsGuardBase(scopeRoot: string, skillsDir: string): Promise<string> {
  const under = (root: string): boolean => {
    const relative = path.relative(root, skillsDir);

    return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
  };

  if (under(scopeRoot)) return scopeRoot;
  const homes = [toolHome(COPILOT_TOOL_ID), toolHome('hermes'), await openclawWorkspaceDir()];
  const home = homes.filter((dir): dir is string => dir !== null && under(dir)).sort((a, b) => a.length - b.length)[0];

  return home ? path.dirname(home) : path.dirname(path.dirname(skillsDir));
}
