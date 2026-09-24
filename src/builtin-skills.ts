import fs from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import fse from 'fs-extra';
import { pathExists, remove } from './utils/fs.js';
import { log } from './utils/logger.js';
import type { TeamaiConfig, LocalConfig } from './types.js';
import { resolveBaseDir, isAgentExcluded, scopedToolPaths } from './types.js';
import { ResourceHandler } from './resources/base.js';
import { CODEX_TOOL, resolveSkillDestination, SHARED_AGENT_SKILLS_PATH, skillsDirForTool, skillTargetForTool } from './resources/skills.js';
import { getUserHome } from './utils/home.js';
import { packagedSkillRoots } from './skill-content.js';
import { PACKAGED_SKILL_DIGESTS } from './packaged-skill-digests.js';

// ─── Built-in skills deployment ──────────────────────────
//
//  The CLI ships one deployable skill: the `teamai` discovery
//  stub under skills/.  On each `teamai pull` its SKILL.md is
//  copied to local AI tool skill directories.  The workflow
//  content it points at is never copied — it lives under
//  skill-data/ and is printed by `teamai skill get`, so what
//  the agent reads always matches the installed CLI version.
//
//  npm package
//    skills/teamai/SKILL.md          (about 2 KB)
//      │
//      ▼  (teamai pull / teamai init)
//    ~/.claude/skills/teamai/SKILL.md
//    ~/.codex-internal/skills/teamai/SKILL.md
//    ~/.cursor/skills/teamai/SKILL.md
//    ...
//
//    skill-data/{core,setup,wiki,share}/   never copied
//

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

/**
 * Every file a release ever packaged under `skills/`, by directory name: the
 * paths of PACKAGED_SKILL_DIGESTS. A path alone does not make a file ours —
 * `removeOwnedFiles` also needs its content to match a shipped version — but
 * the list is what the deploy prune reads to find paths the current package no
 * longer ships.
 *
 * `teamai-wiki` (0.13.0, 0.16.x) is deliberately absent: it predates the trees
 * this migration is about, and widening a destructive set is its own change.
 */
export const PACKAGED_SKILL_FILES: ReadonlyMap<string, readonly string[]> = new Map(
  [...PACKAGED_SKILL_DIGESTS].map(([skill, files]) => [skill, [...files.keys()]]),
);

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
      digests.add(packagedSkillDigest(await fs.promises.readFile(stubPath)));
      owned.set('SKILL.md', digests);
    }
  }
  return owned;
}

/** True when `file` sits at an owned path with content a release shipped there. */
async function isOwnedFile(file: string, relative: string, owned: OwnedSkillFiles): Promise<boolean> {
  const digests = owned.get(relative);
  if (!digests) return false;
  return digests.has(packagedSkillDigest(await fs.promises.readFile(file)));
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
async function walkFiles(dir: string, prefix = ''): Promise<string[]> {
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
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') failures.push({ file: dir, error: (e as Error).message });
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
    const code = (e as NodeJS.ErrnoException).code;
    const stillHolds = code === 'ENOTEMPTY' || code === 'EEXIST'
      || (await fs.promises.readdir(dir).catch(() => [])).length > 0;
    if (!stillHolds) failures.push({ file: dir, error: (e as Error).message });
  }
  return failures;
}

/** What `removeOwnedFiles` did and did not do, for the caller to report. */
export interface PruneResult {
  /** True when a link sits between the base and the skill directory: nothing was touched. */
  skippedSymlink: boolean;
  /** Files left in place because the member, not the CLI, put them there. */
  foreign: number;
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
    skippedSymlink: false, foreign: 0, unbackedUp: [], notRemoved: [], backedUp: 0,
  };

  // A link anywhere between the base directory and this one points at files we
  // never wrote — a shared checkout, a dotfiles repo. `readdir` follows it and
  // every path under it matches ours by name, so the walk would delete someone
  // else's files through the link. Ownership stops at the first link.
  if (await crossesSymlink(baseDir, dir)) {
    result.skippedSymlink = true;
    return result;
  }

  let entries: string[];
  try {
    entries = await walkFiles(dir);
  } catch (e) {
    // An unreadable subdirectory. Reporting it is the point: a silent return
    // leaves the tree in place while `pull` says it succeeded.
    result.notRemoved.push({ file: dir, error: (e as Error).message });
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
      result.notRemoved.push({ file, error: (e as Error).message });
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
    // Content proves the CLI wrote the file; a copy still goes to the archive
    // before the delete, so no removal is a one-way door.
    if (backupDir) {
      try {
        // `errorOnExist` turns a colliding path into a failure rather than a
        // silent overwrite: a lost copy would be the data loss this exists to
        // prevent, wearing the log line of a success.
        await fse.copy(file, path.join(backupDir, relative), { overwrite: false, errorOnExist: true });
        result.backedUp++;
      } catch (e) {
        // A full disk, a read-only home, a colliding copy. Keep the file: a
        // backup that did not happen must not authorise the delete.
        result.unbackedUp.push({ file, error: (e as Error).message });
        continue;
      }
    }
    try {
      await remove(file);
    } catch (e) {
      // A read-only parent. The archive holds the copy, but the original stays,
      // so the tree is half-pruned: say so rather than let a debug line carry it.
      result.notRemoved.push({ file, error: (e as Error).message });
    }
  }
  result.notRemoved.push(...await removeEmptyDirs(dir));

  return result;
}

/**
 * True when any path component between `baseDir` and `target` is a symlink, or
 * `target` is not under `baseDir` at all.
 *
 * Checking `target` alone is not enough: a member who links `~/.claude/skills`
 * — or `~/.config/opencode`, or `~/.claude` itself — at a dotfiles checkout
 * leaves every skill directory under it a real directory, so `lstat` on one
 * says nothing. Components at or above `baseDir` are not checked: a home
 * directory that itself sits under a link is ordinary, and refusing there would
 * disable deployment for those machines.
 */
async function crossesSymlink(baseDir: string, target: string): Promise<boolean> {
  const relative = path.relative(baseDir, target);
  if (relative.startsWith('..') || path.isAbsolute(relative)) return true;

  let walked = baseDir;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    walked = path.join(walked, segment);
    try {
      if ((await fs.promises.lstat(walked)).isSymbolicLink()) return true;
    } catch {
      return false; // does not exist yet: nothing to walk through
    }
  }
  return false;
}

/**
 * One backup root per process run. A date alone collides: two pulls on the same
 * day would have the second overwrite the first's copies.
 */
const PRUNE_RUN_ID = `${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}`;

/**
 * Where the prune parks what it removes: outside every agent directory, so no
 * agent reads it back as a skill, and under the member's own `~/.teamai`.
 *
 * The skill root is part of the path because one tool can prune the same skill
 * name from two roots — Codex reads `.codex/skills` and the shared
 * `.agents/skills` — and those two copies are different files.
 */
function skillBackupDir(baseDir: string, tool: string, skillRoot: string, skillName: string): string {
  const rootSlug = skillRoot.replace(/[\\/:]+/g, '-').replace(/^-+/, '');
  // `inheritUserScope` deploys to the user base and then the project base in one
  // process, with the same tool, root and skill name. Without the base in the
  // path the second pass collides with the first, and `errorOnExist` turns that
  // into files it can neither archive nor prune.
  const baseSlug = `${path.basename(baseDir) || 'root'}-${createHash('sha256').update(baseDir).digest('hex').slice(0, 8)}`;
  // Machine data, not project data: under project scope `baseDir` is the repo
  // root, where a backup per session start would show up as a dirty tree.
  return path.join(getUserHome(), '.teamai', 'removed-skills', PRUNE_RUN_ID, baseSlug, tool, rootSlug, skillName);
}

/** Where a tool keeps its skills on this machine, and where the link guard starts. */
export interface BuiltinSkillsTarget {
  skillsDir: string;
  /**
   * The scope root (home, or the project root) when the skills directory sits
   * under it, else the parent of the configured root: `COPILOT_HOME`,
   * `HERMES_HOME` and OpenClaw's workspace can live anywhere, and the guard
   * must still check that root and every component below it.
   */
  guardBase: string;
}

/**
 * The base the link guard walks down from: the scope root — home, or the
 * project root — when `skillsDir` sits under it, since a link at or above that
 * is ordinary. Not the tool's base directory: for Copilot that is
 * `COPILOT_HOME`, and starting there would never check whether `COPILOT_HOME`
 * itself is a link. A root configured outside the scope root (`HERMES_HOME`,
 * an OpenClaw workspace) has the walk start just above it, so that root is
 * checked too.
 */
export function skillsGuardBase(scopeRoot: string, skillsDir: string): string {
  const relative = path.relative(scopeRoot, skillsDir);
  const underRoot = relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
  return underRoot ? scopeRoot : path.dirname(path.dirname(skillsDir));
}

/**
 * The skills directory `tool` receives built-ins into, or null when it cannot
 * receive them. The same resolver team-skill sync uses (`skillsDirForTool`),
 * so the stub lands where every other skill does — OpenClaw's workspace,
 * `HERMES_HOME` — and the prune looks where earlier releases wrote.
 */
export async function builtinSkillsTarget(
  tool: string,
  configuredSkillsPath: string,
  localConfig?: LocalConfig,
): Promise<BuiltinSkillsTarget | null> {
  if (!localConfig) {
    const baseDir = getUserHome();
    if (!await ResourceHandler.isToolInstalled(configuredSkillsPath, baseDir)) return null;
    return { skillsDir: path.join(baseDir, configuredSkillsPath), guardBase: baseDir };
  }
  const skillsDir = await skillsDirForTool(tool, configuredSkillsPath, localConfig);
  if (skillsDir === null) return null;
  return { skillsDir, guardBase: skillsGuardBase(resolveBaseDir(localConfig), skillsDir) };
}

/**
 * Remove the skill directories earlier releases deployed.
 *
 * Only the files those releases packaged: each was overwritten on every pull
 * (`overwrite: true`), so no local edit ever survived in one, while a file the
 * member added beside them was never touched and is not ours to delete. A
 * directory that still holds such a file is kept, and the member is told.
 */
export async function pruneLegacyBuiltinSkills(
  tool: string,
  { skillsDir, guardBase }: BuiltinSkillsTarget,
  names: ReadonlySet<string> = LEGACY_BUILTIN_SKILL_NAMES,
): Promise<void> {
  // The shared .agents/skills directory belongs to Codex alone. Reaching it from
  // another tool's pass would delete Codex's copies while Codex is excluded or
  // not installed, which the enabledAgents whitelist rules out.
  const skillRoots = [skillsDir];
  if (tool === CODEX_TOOL) skillRoots.push(path.join(guardBase, SHARED_AGENT_SKILLS_PATH));
  for (const legacyName of names) {
    for (const root of skillRoots) {
      const dir = path.join(root, legacyName);
      if (!await pathExists(dir)) continue;
      try {
        const backupDir = skillBackupDir(guardBase, tool, path.relative(guardBase, root), legacyName);
        const result = await removeOwnedFiles(dir, await ownedSkillFiles(legacyName), guardBase, backupDir);
        const saved = result.backedUp > 0 ? `; a copy is in ${backupDir}` : '';
        if (prunedWhole(result)) {
          log.debug(`Removed legacy built-in skill ${legacyName} from ${tool} (${dir})${saved}`);
        } else if (result.skippedSymlink) {
          // Never the "delete the rest yourself" sentence here: following it
          // would destroy exactly what the guard just protected.
          log.warn(`Skipped "${legacyName}" (${tool}): ${dir} is reached through a symlink, so TeamAI left it alone. Nothing was read, copied or removed.`);
        } else if (result.unbackedUp.length > 0) {
          log.warn(`Kept "${legacyName}" (${tool}): ${result.unbackedUp.length} file(s) in ${dir} could not be backed up, so they were not removed. First: ${result.unbackedUp[0].file} — ${result.unbackedUp[0].error}`);
        } else if (result.notRemoved.length > 0) {
          log.warn(`Partly removed "${legacyName}" (${tool}): ${result.notRemoved.length} file(s) in ${dir} were archived but could not be deleted. First: ${result.notRemoved[0].file} — ${result.notRemoved[0].error}`);
        } else {
          log.warn(`Kept "${legacyName}" (${tool}): ${dir} holds files TeamAI did not put there. The packaged files were removed${saved}; delete the rest yourself once you have saved what you need.`);
        }
      } catch (e) {
        const message = `Could not finish removing "${legacyName}" (${tool}) from ${dir}: ${e instanceof Error ? e.message : String(e)}. Whatever is left there stays until the next pull, which tries again.`;
        log.warn(message);
        // A detached SessionStart pull discards its output; debug.log keeps the record.
        log.persist(message);
      }
    }
  }
}

/**
 * Codex reads both `.codex/skills` and the shared `.agents/skills`, and the
 * destination resolver picks the shared copy whenever one exists. The stub has
 * just been written to one of them; a copy an earlier release left in the other
 * would keep its old SKILL.md and references beside it, so Codex would see two
 * `teamai` skills and one of them stale. That copy goes, by the same ownership
 * rule as the rest: only files whose content a release shipped, archived first.
 */
async function retireOtherCodexCopy(
  tool: string,
  skillName: string,
  deployedDir: string,
  { skillsDir, guardBase }: BuiltinSkillsTarget,
): Promise<void> {
  const candidates = [path.join(skillsDir, skillName), path.join(guardBase, SHARED_AGENT_SKILLS_PATH, skillName)];
  for (const other of candidates) {
    if (path.resolve(other) === path.resolve(deployedDir) || !await pathExists(other)) continue;
    const backupDir = skillBackupDir(guardBase, tool, path.relative(guardBase, path.dirname(other)), skillName);
    const result = await removeOwnedFiles(other, await ownedSkillFiles(skillName), guardBase, backupDir);
    if (prunedWhole(result)) {
      log.debug(`Removed the second Codex copy of ${skillName} at ${other}; the stub is at ${deployedDir}`);
    } else if (result.skippedSymlink) {
      log.warn(`Kept ${other}: it is reached through a symlink, so TeamAI left it alone. Codex also reads the stub at ${deployedDir}.`);
    } else if (result.unbackedUp.length > 0) {
      log.warn(`Kept ${result.unbackedUp.length} file(s) in ${other}: their backup could not be written, so they were not removed. First: ${result.unbackedUp[0].file} — ${result.unbackedUp[0].error}`);
    } else if (result.notRemoved.length > 0) {
      log.warn(`Could not finish removing ${other}: ${result.notRemoved.length} file(s) or directories stayed. First: ${result.notRemoved[0].file} — ${result.notRemoved[0].error}`);
    } else {
      log.warn(`Kept ${other}: it holds files TeamAI did not write, so Codex sees it beside the stub at ${deployedDir}. Remove it once you have saved what you need.`);
    }
  }
}

/**
 * Deploy CLI built-in skills to all configured AI tool skill directories.
 *
 * Copies the SKILL.md of each skill in the npm package's skills/ folder to
 * every tool's skills path defined in teamai.yaml. Only that one file: the
 * deployed unit is a discovery stub, and its workflow content is served by
 * `teamai skill get` from skill-data/.
 *
 * The stub is written verbatim — no frontmatter repair on the way out, so a
 * deployed copy that differs from the packaged one is a bug, not a variant.
 *
 * Reporting-only HTTP teams get the stub too. The release before this one had
 * nothing to deploy there that worked without a team repo, so it deployed
 * nothing; the stub's content is served by the installed CLI, and `skill get
 * wiki` — a local knowledge-base generator — needs no repo at all. Skipping it
 * while still pruning the legacy trees would leave those members with no
 * discoverable entry point at all.
 *
 * Silently skips if:
 * - Built-in skills directory doesn't exist (dev environment without build)
 * - A tool's skills directory is not configured
 */
export async function deployBuiltinSkills(teamConfig: TeamaiConfig, localConfig?: LocalConfig): Promise<number> {
  const builtinDir = packagedSkillRoots().deployRoot;

  if (!await pathExists(builtinDir)) {
    log.debug('No built-in skills directory found, skipping deployment');
    return 0;
  }

  let entries: string[];
  try {
    entries = await fs.promises.readdir(builtinDir);
  } catch (e) {
    log.debug(`Could not list the built-in skills in ${builtinDir}, skipping deployment: ${e instanceof Error ? e.message : String(e)}`);
    return 0;
  }

  // Filter to directories that contain SKILL.md
  const skillNames: string[] = [];
  for (const entry of entries) {
    const skillMd = path.join(builtinDir, entry, 'SKILL.md');
    if (await pathExists(skillMd)) {
      skillNames.push(entry);
    }
  }

  if (skillNames.length === 0) {
    log.debug(`No built-in skill in ${builtinDir} has a SKILL.md, skipping deployment`);
    return 0;
  }

  let deployed = 0;

  for (const [tool, toolPath] of Object.entries(scopedToolPaths(teamConfig, localConfig ?? {}))) {
    if (!toolPath.skills) continue;

    // Skip tools that cannot receive skills: not installed, no workspace.
    const target = await builtinSkillsTarget(tool, toolPath.skills, localConfig);
    if (!target) {
      log.debug(`Skipping built-in skill deployment for ${tool}: tool not installed`);
      continue;
    }
    const baseDir = target.guardBase;
    // An excluded agent is neither written to nor deleted from (usage-guide:
    // "the enabledAgents whitelist also gates CLI built-in skills"), so its
    // legacy directories are left alone too.
    if (localConfig && isAgentExcluded(localConfig, tool)) continue;

    let deployedHere = 0;
    for (const skillName of skillNames) {
      const srcDir = path.join(builtinDir, skillName);
      // Resolved without a source path, so the resolver only answers where the
      // skill lives and touches nothing: its Codex reconciliation deletes a
      // duplicate, and nothing may be deleted before the link guard has run.
      // The other Codex copy is dealt with below, under the guard.
      const destDir = localConfig
        ? await skillTargetForTool(tool, toolPath.skills, localConfig, skillName) ?? path.join(target.skillsDir, skillName)
        : await resolveSkillDestination(tool, toolPath.skills, baseDir, skillName);

      try {
        // A symlinked destination points somewhere we do not own. Writing
        // through it would put the stub outside the agent directory, which is
        // the same reason the prune refuses to walk it. Neither step runs.
        if (await crossesSymlink(baseDir, destDir)) {
          log.warn(`Skipped ${skillName} (${tool}): ${destDir} is reached through a symlink, and TeamAI does not write through one. Remove the link to let the skill deploy.`);
          continue;
        }
        // The stub first: if it cannot be written, the pre-stub SKILL.md and the
        // references it points at stay together, a working old skill rather
        // than an old skill whose references are gone.
        await fse.ensureDir(destDir);
        await fse.copy(path.join(srcDir, 'SKILL.md'), path.join(destDir, 'SKILL.md'), { overwrite: true });
        // Releases before the discovery stub deployed this same directory with a
        // references/ tree beside SKILL.md, ~39 KB of pre-stub instructions the
        // new SKILL.md no longer points at. The files those releases wrote go —
        // only the paths this release no longer ships, and only at content a
        // release shipped: a file a member added or edited here is theirs.
        const shippedNow = new Set(await walkFiles(srcDir));
        const retired = (PACKAGED_SKILL_FILES.get(skillName) ?? []).filter((p) => !shippedNow.has(p));
        const backupDir = skillBackupDir(baseDir, tool, path.relative(baseDir, path.dirname(destDir)), skillName);
        const result = await removeOwnedFiles(destDir, await ownedSkillFiles(skillName, retired), baseDir, backupDir);
        if (result.unbackedUp.length > 0) {
          log.warn(`Kept ${result.unbackedUp.length} file(s) under ${destDir}: their backup could not be written, so they were not removed. First: ${result.unbackedUp[0].file} — ${result.unbackedUp[0].error}`);
        }
        if (result.notRemoved.length > 0) {
          log.warn(`Archived but could not delete ${result.notRemoved.length} file(s) under ${destDir}. First: ${result.notRemoved[0].file} — ${result.notRemoved[0].error}`);
        }
        if (tool === CODEX_TOOL) await retireOtherCodexCopy(tool, skillName, destDir, target);

        deployed++;
        deployedHere++;
      } catch (e) {
        log.error(`Failed to deploy built-in skill ${skillName} to ${toolPath.skills}: ${(e as Error).message}`);
      }
    }

    // The legacy trees go only once their replacement is in place: pruning first
    // and then failing to write the stub (a link, a read-only directory) would
    // leave the agent with no discoverable TeamAI skill at all.
    if (deployedHere === skillNames.length) {
      await pruneLegacyBuiltinSkills(tool, target);
    } else {
      log.warn(`Kept the pre-stub skills for ${tool}: the new stub was not deployed there, so removing them would leave nothing to discover.`);
    }
  }

  return deployed;
}
