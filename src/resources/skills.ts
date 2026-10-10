import path from 'node:path';
import YAML from 'yaml';
import { isToolInstalledForConfig, ResourceHandler, type ScanForPushOptions } from './base.js';
import type { CopyOrigin, PendingPush, ResourceItem, ResourceItemStatus, DeliveryTarget, TeamaiConfig, LocalConfig } from '../types.js';
import { getPushignorePath, isAgentExcluded, resolveToolBaseDir, scopedToolPaths, SELF_KNOWLEDGE_SCAN_KEY } from '../types.js';
import { listDirs, listFilesRecursive, pathExists, copyDir, remove, pruneEmptyDirs, dirContentEqual, dirTeamSubsetEqual, fileContentEqual, fileHash, getDirLatestMtime, readFileSafe, writeFile } from '../utils/fs.js';
import { log } from '../utils/logger.js';
import { warnOnce } from '../utils/warn-once.js';
import { getFileContentWhenAdded, isPastVersionOf } from '../utils/git.js';
import { isCliOwnedSkillName, ownedSkillFiles, prunedWhole, removeOwnedFiles } from '../builtin-skills.js';
import { resolveOpenclawWorkspaceDir } from '../openclaw-hooks.js';
import { getHermesHome } from '../hermes-home.js';
import {
  loadRolesManifest, resolveRoleResourceNamespaces, RolesManifestNotFoundError, type RolesManifest,
} from '../roles.js';
import { loadProjectsManifest, resolveProjectResourceNamespaces } from '../projects.js';
import { assertSafeFallbackNamespaces } from '../manifest-schema.js';
import { assertWithinRoot, resolveReal } from '../utils/path-safety.js';
import { openPrDestinations, recordedNamespace } from '../utils/pending-push.js';
import { splitFrontmatter, stringifyFrontmatter } from '../utils/frontmatter.js';
import {
  blockingEntries, deliveredSkillFiles, describeKeptDir, describeMembersDirLeft, describeMembersFile, describeMembersLink, describeSkippedLink, isLink, judgeCopy, keepsEditedCopy, keepsTrackedCopy,
  isRecordedFromTeamSkill, isUneditedSkillCopy, membersLinkAt, ownsSkillDir, recordDelivered, recordedUnder, teamaiSkillFiles,
  type DeliveredHashes, type DeliveryLedger,
} from './delivered-copies.js';

/** File name used to track who has contributed (pushed) a skill. */
const CONTRIBUTORS_FILE = 'CONTRIBUTORS';
const SKILL_MD = 'SKILL.md';
export const CODEX_TOOL = 'codex';
export const SHARED_AGENT_SKILLS_PATH = '.agents/skills';

/**
 * Whether the existing copy at `sharedDir`, in Codex's shared `.agents/skills`,
 * is teamai's (#993). Other tools and the member write there too, so a copy
 * is teamai's only on proof: the caller's delivery record (`judgeCopy`), or,
 * without one, the history of the repo the skill comes from
 * (`isTeamaiSkillCopy`).
 */
export type SharedSkillOwnership = (sharedDir: string) => Promise<boolean>;

/** What a full pull prints while Codex sees the member's `.agents/skills/<name>` and teamai's copy. */
export function codexSkillConflictLine(skillName: string, configuredSkillsPath: string): string {
  const shared = path.posix.join(SHARED_AGENT_SKILLS_PATH, skillName);
  const configured = path.posix.join(configuredSkillsPath, skillName);
  return `Codex skill conflict for ${skillName}: ${shared} is not teamai's, so it was left alone; `
    + `the team skill is in ${configured}. Codex now sees two skills named ${skillName}.`;
}

/**
 * Where Codex's copy of `skillName` goes: the shared `.agents/skills/<name>`
 * when a copy there is teamai's (`ownsShared`), else the configured directory.
 * Other tools get the configured directory.
 */
export async function resolveSkillDestination(
  tool: string,
  configuredSkillsPath: string,
  baseDir: string,
  skillName: string,
  ownsShared: SharedSkillOwnership,
  sourcePath?: string,
): Promise<string> {
  const configuredDestination = path.join(baseDir, configuredSkillsPath, skillName);
  if (tool === CODEX_TOOL) {
    const sharedDestination = path.join(baseDir, SHARED_AGENT_SKILLS_PATH, skillName);
    if (!await pathExists(sharedDestination)) return configuredDestination;
    if (!await ownsShared(sharedDestination)) {
      // The member's skill, or another tool's: never written, so Codex sees both.
      if (sourcePath) log.warn(codexSkillConflictLine(skillName, configuredSkillsPath));
      return configuredDestination;
    }
    // No source to compare against: the caller only wants to know where the
    // skill lives. Reconciling needs the team copy to prove the two are the
    // same, so without it there is nothing to decide and nothing to report —
    // `doctor` and the post-pull pass would otherwise warn about a conflict
    // on every skill, for copies the write path treats as identical.
    if (!sourcePath) return sharedDestination;
    if (await pathExists(configuredDestination)) {
      // A link there is the member's: never deleted as a duplicate (#993).
      if (await isLink(configuredDestination)) {
        log.warn(describeMembersLink(configuredDestination, `skills/${skillName}`));
      } else if (await dirContentEqual(sharedDestination, configuredDestination) && await dirContentEqual(configuredDestination, sourcePath)) {
        if (!await keepsTrackedCopy(configuredDestination, sharedDestination)) {
          await remove(configuredDestination);
          log.debug(`Removed identical TeamAI skill ${skillName} from ${configuredSkillsPath}`);
        }
      } else {
        log.warn(`Codex skill conflict for ${skillName}: keeping different copies in ${SHARED_AGENT_SKILLS_PATH} and ${configuredSkillsPath}`);
      }
    }
    return sharedDestination;
  }

  return configuredDestination;
}

/**
 * The directory `tool` receives skills into on this machine, or null when it
 * cannot receive them: no skills path configured, or the tool is not installed.
 *
 * This is the gate on its own, asked without inventing a skill name. OpenClaw
 * resolves through its workspace directory, Hermes through its home, Copilot
 * counts itself installed once `enabledAgents` names it, and everything else
 * falls back to the tool root. A second spelling of these gates is exactly how
 * "Synced N skills" ends up true while a tool receives nothing (#598).
 */
export async function skillsDirForTool(
  tool: string,
  configuredSkillsPath: string | undefined,
  localConfig: LocalConfig,
): Promise<string | null> {
  if (!configuredSkillsPath) return null;

  if (tool === 'openclaw') {
    const wsDir = await resolveOpenclawWorkspaceDir();
    if (!wsDir) {
      log.debug('Skipping skill sync for openclaw: workspace dir not found');
      return null;
    }
    return path.join(wsDir, 'skills');
  }

  if (tool === 'hermes') {
    // Like every other tool, skip when not installed: getHermesHome() always
    // resolves (HERMES_HOME or ~/.hermes), so without this check every pull
    // creates a hermes home the user never asked for.
    if (!await pathExists(getHermesHome())) {
      log.debug(`Skipping skill sync for ${tool}: tool not installed`);
      return null;
    }
    return path.join(getHermesHome(), 'skills');
  }

  if (!await isToolInstalledForConfig(tool, configuredSkillsPath, localConfig)) {
    log.debug(`Skipping skill sync for ${tool}: tool not installed`);
    return null;
  }

  return path.join(resolveToolBaseDir(tool, localConfig), configuredSkillsPath);
}

/**
 * Where `skillName` lands for `tool` on this machine, or null when the tool
 * cannot receive it.
 *
 * One place answers that question, so `pull` writes and `doctor` checks the very
 * same paths (#598). A second copy of these gates is how "Synced 12 skills"
 * ends up true for one tool and silently false for another.
 *
 * `ownsShared` decides whether Codex's existing copy in `.agents/skills` is
 * teamai's (`resolveSkillDestination`). `sourcePath` belongs to the write
 * path: it lets the Codex shared-directory reconciliation delete a duplicate
 * it can prove is identical, and name a conflict. Omit it to resolve a
 * destination without those side effects.
 */
export async function skillTargetForTool(
  tool: string,
  configuredSkillsPath: string | undefined,
  localConfig: LocalConfig,
  skillName: string,
  ownsShared: SharedSkillOwnership,
  sourcePath?: string,
): Promise<string | null> {
  const skillsDir = await skillsDirForTool(tool, configuredSkillsPath, localConfig);
  if (skillsDir === null || configuredSkillsPath === undefined) return null;

  // Codex alone can redirect a skill to the shared `.agents/skills` directory,
  // and only for a skill whose copy there is teamai's — so the destination is
  // per-skill and the gate above cannot answer it.
  if (tool === CODEX_TOOL) {
    const baseDir = resolveToolBaseDir(tool, localConfig);
    return resolveSkillDestination(tool, configuredSkillsPath, baseDir, skillName, ownsShared, sourcePath);
  }

  return path.join(skillsDir, skillName);
}

/**
 * Where a copy of team skill `name` comes from, for the ownership proof
 * (#993): that name's directory at the root of `skills/` or in any namespace
 * of the team repo at `repoPath`, so a copy of the root skill still proves
 * teamai's after the team moved it into a namespace. SKILL.md also counts as
 * pull delivers it, with its frontmatter repaired.
 */
export function skillOrigin(repoPath: string, name: string): CopyOrigin {
  return {
    repoPath,
    pathspec: `:(glob)skills/**/${name}`,
    renders: [(content) => withSkillFrontmatter(content.toString('utf-8'), name)],
  };
}

/** Add fields immediately before the closing delimiter without reformatting existing YAML. */
function appendFrontmatterFields(raw: string, fields: Record<string, string>): string {
  const eol = raw.includes('\r\n') ? '\r\n' : '\n';
  const yaml = YAML.stringify(fields).trimEnd().replace(/\n/g, eol);
  return raw.replace(
    /(\r?\n---[ \t]*)(\r?\n|$)$/,
    (_match, closing: string, trailing: string) => `${eol}${yaml}${closing}${trailing}`,
  );
}

/**
 * Ensure a SKILL.md file has valid YAML frontmatter with `name` and `description`.
 * If frontmatter is missing entirely, injects one derived from the skill name and
 * the first meaningful line of content. If frontmatter exists but is missing `name`
 * or `description`, adds the missing fields.
 *
 * This is called during push so that skills in the team repo always have proper
 * metadata for marketplace discovery and triggering.
 */
export async function ensureSkillFrontmatter(skillDir: string, skillName: string): Promise<boolean> {
  const skillMdPath = path.join(skillDir, SKILL_MD);
  const content = await readFileSafe(skillMdPath);
  if (!content) return false;

  const { raw, valid } = splitFrontmatter(content);
  if (raw && !valid) {
    log.warn(`Could not repair malformed frontmatter in ${skillName}/SKILL.md; leaving it unchanged`);
    return false;
  }

  const repaired = withSkillFrontmatter(content, skillName);
  if (repaired === content) return false; // Already complete
  await writeFile(skillMdPath, repaired);
  log.debug(`Added missing frontmatter to ${skillName}/SKILL.md`);
  return true;
}

/**
 * The SKILL.md `ensureSkillFrontmatter` leaves from `content`: the same text
 * when it is empty, already has `name` and `description`, or has frontmatter
 * that does not parse.
 */
export function withSkillFrontmatter(content: string, skillName: string): string {
  if (!content) return content;
  const { data, body, raw, valid } = splitFrontmatter(content);

  if (!raw) {
    // No frontmatter at all — derive description from first heading or first non-empty line
    const description = extractDescriptionFromContent(body, skillName);
    return stringifyFrontmatter({ name: skillName, description }, body);
  }
  if (!valid) return content;

  // Frontmatter exists — check for missing fields
  const hasName = typeof data['name'] === 'string' && String(data['name']).trim() !== '';
  const hasDescription = typeof data['description'] === 'string' && String(data['description']).trim() !== '';

  if (hasName && hasDescription) return content;

  const missingFields: Record<string, string> = {};
  if (!hasName) missingFields.name = skillName;
  if (!hasDescription) missingFields.description = extractDescriptionFromContent(body, skillName);

  // Preserve existing comments, quoting, key order, and line endings. Re-serializing
  // the whole block would make an unrelated metadata repair unnecessarily lossy.
  return appendFrontmatterFields(raw, missingFields) + body;
}

/**
 * Extract a short description from SKILL.md content by looking at the first
 * heading (# Title) or the first non-empty line. Falls back to the skill name.
 */
function extractDescriptionFromContent(content: string, skillName: string): string {
  const lines = content.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // Use first heading text (strip # prefix)
    const headingMatch = trimmed.match(/^#+\s+(.+)/);
    if (headingMatch) {
      return headingMatch[1].trim();
    }
    // Use first non-empty, non-heading line if it's descriptive enough
    if (trimmed.length > 10) {
      // Truncate to ~80 chars for a reasonable description
      return trimmed.length > 80 ? trimmed.slice(0, 77) + '...' : trimmed;
    }
  }
  return `${skillName} skill`;
}

/**
 * Scan the team repo skills/ directory to discover namespace subdirectories.
 * A directory is a namespace if it does NOT contain SKILL.md (i.e. it contains
 * skill subdirectories rather than being a skill itself) AND it actually holds
 * at least one skill. The second condition matters: git tracks files, not
 * directories, so a pushed skill whose source had an empty subdirectory (e.g.
 * an unused `assets/`) leaves an untracked, SKILL.md-less shell behind in the
 * working tree. Treating that shell as a namespace nested every later push
 * inside a skill's own name.
 * Returns the list of namespace names found, or [] if layout is purely flat.
 */
export async function scanTeamRepoNamespaces(repoPath: string): Promise<string[]> {
  const teamSkillsDir = path.join(repoPath, 'skills');
  if (!await pathExists(teamSkillsDir)) return [];

  const topDirs = await listDirs(teamSkillsDir);
  const namespaces: string[] = [];

  for (const dir of topDirs) {
    const dirPath = path.join(teamSkillsDir, dir);
    const hasSkillMd = await pathExists(path.join(dirPath, 'SKILL.md'));
    if (hasSkillMd) continue;
    const subDirs = await listDirs(dirPath);
    let holdsSkill = false;
    for (const subDir of subDirs) {
      if (await pathExists(path.join(dirPath, subDir, 'SKILL.md'))) {
        holdsSkill = true;
        break;
      }
    }
    if (holdsSkill) namespaces.push(dir);
  }

  return namespaces;
}

async function readPushIgnoredSkills(): Promise<Set<string>> {
  const content = await readFileSafe(getPushignorePath());
  if (!content) return new Set();

  return new Set(
    content.split('\n').map((line) => line.trim()).filter((line) => line.length > 0),
  );
}

/**
 * Resolve skill namespaces from the manifest using the user's configured roles.
 * Falls back to [primaryRole, ...additionalRoles] when the manifest is absent or
 * does not list the role, returns [] if no roles are configured, and throws when
 * the manifest exists but cannot be read or parsed.
 */
async function resolveSkillNamespaces(localConfig: LocalConfig): Promise<string[]> {
  if (!localConfig.primaryRole) return [];
  const roleIds = [localConfig.primaryRole, ...(localConfig.additionalRoles ?? [])];

  let manifest: RolesManifest;
  try {
    manifest = await loadRolesManifest(localConfig.repo.localPath);
  } catch (error) {
    // Fallback: use role ids as namespace names (legacy behavior). Reserved for a
    // manifest that is not there — one that exists and does not parse must not be
    // silently replaced by a guess at its contents.
    if (!(error instanceof RolesManifestNotFoundError)) throw error;
    return assertSafeFallbackNamespaces(roleIds, 'role id used as a skills namespace');
  }

  try {
    return resolveRoleResourceNamespaces({
      manifest,
      primaryRole: localConfig.primaryRole,
      additionalRoles: localConfig.additionalRoles ?? [],
    }).skills;
  } catch {
    // A valid manifest that no longer lists the role (renamed or removed) keeps
    // the legacy guess it always had; push placement still refuses to guess.
    return assertSafeFallbackNamespaces(roleIds, 'role id used as a skills namespace');
  }
}

/**
 * The skills namespaces push treats as this member's: the role ones
 * (`resolveSkillNamespaces`, legacy fallbacks included), then those of the
 * active projects, the same union pull delivers from. Without the project
 * half, a project skill was pushable only through legacy mode's first-match
 * scan, which can pick another project's skill of the same name. Null when no
 * role or active project scopes this directory, so every namespace is given.
 * When the active projects cannot be resolved this is the role half alone,
 * never null: an unscoped scan would match a local skill to any project's
 * skill of its name. Push without `--role` or `--project` stops before that.
 */
export async function resolvePushSkillNamespaces(localConfig: LocalConfig): Promise<string[] | null> {
  const roleNamespaces = await resolveSkillNamespaces(localConfig);
  const activeProjects = localConfig.projects ?? [];
  if (activeProjects.length === 0) return roleNamespaces.length > 0 ? roleNamespaces : null;
  const manifest = await loadProjectsManifest(localConfig.repo.localPath);
  if (!manifest) return roleNamespaces;
  let projectNamespaces: string[];
  try {
    projectNamespaces = resolveProjectResourceNamespaces({ manifest, activeProjects }).skills;
  } catch {
    // An unknown project id: pull falls back to role-only filtering and warns.
    return roleNamespaces;
  }
  return [...new Set([...roleNamespaces, ...projectNamespaces])];
}

/**
 * The team skill a local copy came from, among the same-named team skills
 * `copies` (absolute directories in the team repo at `repoPath`): the one whose
 * history holds the SKILL.md version pull recorded at `dest`. Undefined when
 * pull recorded nothing there or the record matches none or several of them:
 * a same-named skill that replaced a deleted one is not the copy's (#1020).
 */
export async function recordedOrigin<TCopy extends { dir: string }>(
  copies: readonly TCopy[], record: { delivered: DeliveredHashes; dest: string; repoPath: string },
): Promise<TCopy | undefined> {
  const matched: TCopy[] = [];
  for (const copy of copies) {
    const teamDir = path.relative(record.repoPath, copy.dir).split(path.sep).join('/');
    if (await isRecordedFromTeamSkill(record.delivered, record.dest, record.repoPath, teamDir)) matched.push(copy);
  }
  return matched.length === 1 ? matched[0] : undefined;
}

/** Build a skill push item with the origin fields shared by every push path. */
export function createSkillPushItem(input: {
  name: string;
  sourcePath: string;
  status: ResourceItemStatus;
  namespace?: string;
  fromInactiveNamespace?: true;
  deliveryRecorded?: true;
  originProven?: true;
  originCandidates?: readonly { dir: string }[];
  repoPath?: string;
  /** The path the warning about an unproven origin names, if any. */
  reportSourcePath?: string;
}): ResourceItem | undefined {
  if (input.deliveryRecorded && (!input.originProven || input.status === 'new')) {
    warnUnprovenOrigin(input.name, input.originCandidates ?? [], input.repoPath ?? process.cwd(),
      input.reportSourcePath);
    return undefined;
  }
  const relativePath = input.namespace
    ? `skills/${input.namespace}/${input.name}`
    : `skills/${input.name}`;
  return {
    name: input.name,
    type: 'skills',
    sourcePath: input.sourcePath,
    relativePath,
    status: input.status,
    namespace: input.namespace,
    ...input.fromInactiveNamespace ? { fromInactiveNamespace: true } : {},
  };
}

/**
 * Say why push leaves out a copy teamai delivered: its record ties it to none,
 * or to more than one, of the same-named team skills `copies`, so writing it
 * to any of them could replace a skill it never came from (#1020).
 */
function warnUnprovenOrigin(
  name: string,
  copies: readonly { dir: string }[],
  repoPath: string,
  sourcePath?: string,
): void {
  const holders = copies.map((copy) => path.relative(repoPath, copy.dir).split(path.sep).join('/')).join(' and ');
  warnOnce(
    `[skills] Skipped ${name}${sourcePath ? ` at ${sourcePath}` : ''}: teamai delivered this copy, but its record matches `
    + `${copies.length === 0 ? 'no current team skill' : copies.length === 1 ? `no version of ${holders}` : `no single one of ${holders}`}, `
    + 'so push cannot prove where it came from. To send the edit as a new skill, copy it under a new name and push that.',
  );
}

/**
 * Recursively scan a directory tree to find all subdirectories containing SKILL.md.
 * Returns a map of skill names to their full paths, supporting arbitrary nesting depth.
 * For example, if scanning ~/.claude/skills/, will find both:
 *   - top-level-skill/ → {"top-level-skill": "~/.claude/skills/top-level-skill"}
 *   - hai/my-skill/ → {"my-skill": "~/.claude/skills/hai/my-skill"}
 *   - nested/category/other-skill/ → {"other-skill": "~/.claude/skills/nested/category/other-skill"}
 */
async function scanSkillsRecursively(dirPath: string): Promise<Map<string, string>> {
  const results = new Map<string, string>();

  async function walk(currentPath: string): Promise<void> {
    if (!await pathExists(currentPath)) return;

    const entries = await listDirs(currentPath);

    // Two-pass scan: first collect skills at this level (shallow),
    // then recurse into non-skill subdirectories.
    // This ensures shallow (flat) skills always win over deeper
    // (namespace-nested) duplicates — the flat copy is the one synced
    // by `teamai pull` and is authoritative.
    const subdirs: string[] = [];
    for (const entry of entries) {
      // Skip hidden directories (e.g. .system — Codex built-in skills)
      // and workspace scratch directories (e.g. cls-log-workspace)
      if (entry.startsWith('.') || entry.endsWith('-workspace')) continue;

      const entryPath = path.join(currentPath, entry);
      const skillMdPath = path.join(entryPath, SKILL_MD);

      if (await pathExists(skillMdPath)) {
        // Shallow-wins: do not override a skill already found at a
        // shallower level. The flat copy (e.g. ~/.codebuddy/skills/my-skill/)
        // is the one synced by `teamai pull` and is authoritative; a stale
        // namespace copy (e.g. ~/.codebuddy/skills/hai_dev/my-skill/) must
        // not shadow it.
        if (!results.has(entry)) {
          results.set(entry, entryPath);
        }
      } else {
        subdirs.push(entryPath);
      }
    }

    // Second pass: recurse into non-skill directories.
    // Skills found deeper will NOT override those already found at this level.
    for (const sub of subdirs) {
      await walk(sub);
    }
  }

  await walk(dirPath);
  return results;
}

/**
 * Every file another team copy of `item`'s skill name tracks: the root skill,
 * or the skill of that name in any namespace, other than `item` itself. Each
 * relative path maps to that file in every copy that has it.
 */
async function otherVersionFiles(repoPath: string, item: ResourceItem): Promise<Map<string, string[]>> {
  const skillsDir = path.join(repoPath, 'skills');
  const copies: string[] = [];
  for (const dir of await listDirs(skillsDir)) {
    const dirPath = path.join(skillsDir, dir);
    if (await pathExists(path.join(dirPath, SKILL_MD))) {
      if (dir === item.name) copies.push(dirPath);
    } else if (await pathExists(path.join(dirPath, item.name))) {
      copies.push(path.join(dirPath, item.name));
    }
  }
  const files = new Map<string, string[]>();
  for (const copy of copies) {
    if (path.resolve(copy) === path.resolve(item.sourcePath)) continue;
    for (const file of await listFilesRecursive(copy)) files.set(file, [...(files.get(file) ?? []), path.join(copy, file)]);
  }
  return files;
}

/**
 * Install replaces the whole skill (#707): after `source` is copied over
 * `dest`, a file `source` does not have is removed when it is byte for byte
 * that file of another team version of the skill, so switching between the
 * root skill and a namespace skill of that name leaves nothing of the previous
 * one behind. Any other file is the member's own, and stays: push does not
 * count such an extra as a change, so it may never have been pushed. One at a
 * path another version has is named, since it may be an edited leftover.
 * `delivered` tells them apart (#822): a file still as teamai recorded writing
 * it is a leftover, and one it has no record of is the member's own.
 */
async function removeLeftoverVersionFiles(
  source: string, dest: string, otherVersions: Map<string, string[]>, delivered: DeliveredHashes | undefined,
): Promise<void> {
  if (otherVersions.size === 0) return;
  const sourceFiles = new Set(await listFilesRecursive(source));
  let removed = false;
  for (const file of await listFilesRecursive(dest)) {
    const versions = otherVersions.get(file);
    if (sourceFiles.has(file) || !versions) continue;
    const installed = path.join(dest, file);
    const recorded = delivered?.[installed];
    const leftover = (recorded !== undefined && await fileHash(installed) === recorded)
      || (await Promise.all(versions.map((version) => fileContentEqual(installed, version)))).some(Boolean);
    if (!leftover) {
      if (delivered !== undefined && recorded === undefined) continue;
      log.warn(
        `Kept ${installed}: another team version of this skill has a file at that path with different content, `
        + 'so it may be yours or an edited copy. Delete it if you do not need it.',
      );
      continue;
    }
    if (await keepsTrackedCopy(installed)) continue;
    await remove(installed);
    removed = true;
  }
  if (removed) await pruneEmptyDirs(dest);
}

/**
 * Whether every team file of the skill at `teamDir` (`teamRelDir` in the team
 * repo at `repoPath`) whose copy under `localDir` differs is an older version
 * of that team file. A team file missing locally is one a teammate added since
 * when the active branch at `activeRoot` never added it, and the member's
 * deletion otherwise. Files only the member has are ignored, as
 * dirTeamSubsetEqual ignores them.
 */
async function isPastSkillVersion(
  repoPath: string, activeRoot: string, localDir: string, teamDir: string, teamRelDir: string,
): Promise<boolean> {
  for (const rel of await listFilesRecursive(teamDir)) {
    if (rel.split('/').includes(CONTRIBUTORS_FILE)) continue;
    const localFile = path.join(localDir, rel);
    if (await fileContentEqual(localFile, path.join(teamDir, rel))) continue;
    if (!await pathExists(localFile)) {
      const activeRel = path.relative(activeRoot, localFile).split(path.sep).join('/');
      if (await getFileContentWhenAdded(activeRoot, activeRel) === null) continue;
      return false;
    }
    if (!await isPastVersionOf(repoPath, localFile, `${teamRelDir}/${rel}`)) return false;
  }
  return true;
}

/**
 * Where one local copy goes on the team repo, as `resolveDestination`
 * decides it: a team skill (`proven` when a delivery record ties the copy to
 * it), the destination of the open PR that added it, none yet (new), or no
 * destination it can be given and why.
 */
export type CopyDestination =
  | { kind: 'team'; teamSkill: { dir: string; namespace?: string }; proven: boolean }
  | { kind: 'openPr'; dir: string; namespace?: string }
  | { kind: 'new' }
  /** Delivered, but its record ties it to none, or several, of `candidates`. */
  | { kind: 'unproven'; candidates: readonly { dir: string }[] }
  /** Never delivered, and the legacy layout holds the name in several places. */
  | { kind: 'ambiguous'; candidates: readonly { dir: string }[] }
  /** Never delivered, and only namespaces this scope doesn't select hold the name. */
  | { kind: 'outOfScope'; candidates: readonly { dir: string }[] }
  /** Never delivered, and open PRs hold the name at several destinations none of which `role` names. */
  | { kind: 'ambiguousOpenPr'; records: readonly { branch: string; relativePath: string }[] };

/** The team repo's skills, by name, as the push scope sees them. */
export interface TeamSkillIndex {
  /** The skill of each name this scope is given: shared root or active namespace, a namespace winning. */
  teamSkills: Map<string, { dir: string; namespace?: string }>;
  /** Every team skill of each name, active or not. */
  allTeamSkills: Map<string, { dir: string; namespace?: string }[]>;
  /** Legacy mode (no role or project): every skill of each name. */
  legacyTeamSkills: Map<string, { dir: string; namespace?: string }[]>;
  /** Skills in namespaces neither the role nor an active project selects. */
  blockedSkills: Map<string, { dir: string; namespace: string }[]>;
}

/** Read the team repo's skills at `repoPath` for a push scope (`scopedNamespaces`, null in legacy mode). */
export async function readTeamSkillIndex(repoPath: string, scopedNamespaces: string[] | null): Promise<TeamSkillIndex> {
  const teamSkills = new Map<string, { dir: string; namespace?: string }>();
  const allTeamSkills = new Map<string, { dir: string; namespace?: string }[]>();
  const addTeamSkill = (name: string, copy: { dir: string; namespace?: string }): void => {
    allTeamSkills.set(name, [...allTeamSkills.get(name) ?? [], copy]);
  };
  // In legacy mode, pull can deliver one of several same-named skills. Keep
  // every source so its delivery record can identify the right destination.
  const legacyTeamSkills = new Map<string, { dir: string; namespace?: string }[]>();
  // Skills in namespaces neither the role nor an active project selects, with each team copy of the name
  const blockedSkills = new Map<string, { dir: string; namespace: string }[]>();

  if (scopedNamespaces !== null) {
    // Role-based mode: load allowed namespaces and track blocked ones.
    // Also recognize root-level flat skills (those with SKILL.md directly inside).
    const allSkillsDir = path.join(repoPath, 'skills');
    const topDirs = await listDirs(allSkillsDir);

    // First pass: identify root-level flat skills (accessible to everyone)
    for (const dir of topDirs) {
      const dirPath = path.join(allSkillsDir, dir);
      const hasSkillMd = await pathExists(path.join(dirPath, 'SKILL.md'));
      if (hasSkillMd) {
        // Root-level flat skill — shared across all roles
        const copy = { dir: dirPath };
        addTeamSkill(dir, copy);
        teamSkills.set(dir, copy);
      }
    }

    // Second pass: load skills from allowed namespaces. A namespace skill
    // replaces the root skill of its name, as pull delivers it (#707), so an
    // edit goes back to the namespace; the first namespace keeps a name. A
    // directory without SKILL.md is not a skill and replaces nothing, as in pull.
    for (const namespace of scopedNamespaces) {
      const teamSkillsNsDir = path.join(allSkillsDir, namespace);
      const names = await listDirs(teamSkillsNsDir);
      for (const name of names) {
        const dir = path.join(teamSkillsNsDir, name);
        if (await pathExists(path.join(dir, SKILL_MD))) {
          const copy = { dir, namespace };
          addTeamSkill(name, copy);
          if (!teamSkills.get(name)?.namespace) teamSkills.set(name, copy);
        }
      }
    }

    // Third pass: scan non-allowed namespace directories for blocked skills
    for (const dir of topDirs) {
      const dirPath = path.join(allSkillsDir, dir);
      const hasSkillMd = await pathExists(path.join(dirPath, 'SKILL.md'));
      if (hasSkillMd) continue; // Already handled as root-level flat skill
      if (scopedNamespaces.includes(dir)) continue; // Already processed as allowed namespace
      const names = await listDirs(dirPath);
      for (const name of names) {
        // A shared-root or active skill of the name does not decide alone: the copy may have come from here (#1020).
        const skillDir = path.join(dirPath, name);
        if (!await pathExists(path.join(skillDir, SKILL_MD))) continue;
        const copy = { dir: skillDir, namespace: dir };
        addTeamSkill(name, copy);
        blockedSkills.set(name, [...blockedSkills.get(name) ?? [], copy]);
      }
    }
  } else {
    // Legacy mode (no roles): detect flat vs namespaced layout automatically.
    // A directory is a namespace if it does NOT contain SKILL.md; otherwise it's a flat skill.
    const teamSkillsDir = path.join(repoPath, 'skills');
    const topDirs = await listDirs(teamSkillsDir);
    for (const dir of topDirs) {
      const dirPath = path.join(teamSkillsDir, dir);
      const hasSkillMd = await pathExists(path.join(dirPath, 'SKILL.md'));
      if (hasSkillMd) {
        // Flat skill
        const candidate = { dir: dirPath };
        addTeamSkill(dir, candidate);
        legacyTeamSkills.set(dir, [...legacyTeamSkills.get(dir) ?? [], candidate]);
        teamSkills.set(dir, candidate);
      } else {
        // Namespace directory — scan subdirectories as skills
        const subDirs = await listDirs(dirPath);
        for (const subDir of subDirs) {
          const candidate = { dir: path.join(dirPath, subDir), namespace: dir };
          if (!await pathExists(path.join(candidate.dir, SKILL_MD))) continue;
          addTeamSkill(subDir, candidate);
          legacyTeamSkills.set(subDir, [...legacyTeamSkills.get(subDir) ?? [], candidate]);
          if (!teamSkills.has(subDir)) {
            teamSkills.set(subDir, candidate);
          }
        }
      }
    }
  }
  return { teamSkills, allTeamSkills, legacyTeamSkills, blockedSkills };
}

/**
 * The team destination of one local copy at `dest`, the one place it is
 * decided, before copies from several tools are merged. In order of proof:
 * the delivery record (the team skill teamai delivered the copy from,
 * shared-root, active or not; a same-named skill that replaced the deleted
 * one is not its origin), then an open-PR record (where a new skill awaiting
 * review goes), then the team tree (the shared-root or active skill of its
 * name). A skill in a namespace this scope doesn't select is never a
 * destination without a record proving the copy came from there, and a flag
 * cannot move a proven origin (#1020). Open PRs at several destinations of
 * the name prove none of them: only the namespace `--role` / `--project` names
 * (`role`) picks one, and one none of them holds is a new destination. The
 * skills scan and `push --skill` both call it; each says in its own words why
 * a copy without one is left out.
 */
export async function resolveDestination(input: {
  name: string;
  dest: string;
  team: TeamSkillIndex;
  delivered: DeliveredHashes;
  pending: readonly PendingPush[];
  repoPath: string;
  role?: string;
}): Promise<CopyDestination> {
  const { name, dest, team, delivered, repoPath } = input;
  if (recordedUnder(delivered, dest).length > 0) {
    const copies = team.allTeamSkills.get(name) ?? [];
    const origin = await recordedOrigin(copies, { delivered, dest, repoPath });
    return origin ? { kind: 'team', teamSkill: origin, proven: true } : { kind: 'unproven', candidates: copies };
  }
  const open = await openPrDestinations({ pending: input.pending, name, repoPath });
  const awaiting = open.length > 1
    ? open.find((o) => input.role !== undefined && recordedNamespace(o.recorded) === input.role)?.recorded
    : open[0]?.recorded;
  if (!awaiting && open.length > 1) {
    // A namespace the flag names that none of them holds is a new destination: the flag places it.
    if (input.role !== undefined) return { kind: 'new' };
    return { kind: 'ambiguousOpenPr', records: open.map((o) => ({ branch: o.branch, relativePath: o.recorded.relativePath })) };
  }
  if (awaiting) {
    return { kind: 'openPr', dir: path.join(repoPath, awaiting.relativePath), namespace: recordedNamespace(awaiting) };
  }
  const legacyCopies = team.legacyTeamSkills.get(name) ?? [];
  if (legacyCopies.length > 1) return { kind: 'ambiguous', candidates: legacyCopies };
  const teamSkill = team.teamSkills.get(name);
  if (teamSkill) return { kind: 'team', teamSkill, proven: false };
  const blockedCopies = team.blockedSkills.get(name) ?? [];
  return blockedCopies.length > 0 ? { kind: 'outOfScope', candidates: blockedCopies } : { kind: 'new' };
}

export class SkillsHandler extends ResourceHandler {
  readonly type = 'skills' as const;

  /**
   * Scan local AI tool skill directories for skills that are new or modified
   * compared to the team repo. Compares across ALL tool directories and picks
   * the one with the latest mtime when multiple dirs have modifications.
   *
   * When roles are configured, skips skills that exist in non-allowed namespaces
   * to enforce role-based access control.
   */
  async scanLocalForPush(
    teamConfig: TeamaiConfig, localConfig: LocalConfig, options?: ScanForPushOptions,
  ): Promise<ResourceItem[]> {
    const team = await readTeamSkillIndex(localConfig.repo.localPath, await resolvePushSkillNamespaces(localConfig));

    // Read tombstones to skip previously deleted resources
    const tombstones = await this.readTombstones(localConfig);
    const pushIgnoredSkills = await readPushIgnoredSkills();

    // Quarantine ambiguous names; modern source records are excluded by physical path.
    let sourceSkillNames: Set<string>;
    let sourcePathOwners: Array<{ path: string; manifestPath?: string }>;
    try {
      const { getSourcePushQuarantineNames, getSourcePathOwners } = await import('../source.js');
      sourceSkillNames = await getSourcePushQuarantineNames(localConfig);
      sourcePathOwners = await getSourcePathOwners();
    } catch (error) {
      log.warn(`Skipping skill push because source ownership tracking could not be read safely: ${(error as Error).message}`);
      return [];
    }

    // Copies left out with a `skipReason` push reports, kept in the scan for pruning.
    const heldItems: ResourceItem[] = [];
    // What pull last wrote here, read with the first copy scanned.
    let delivered: DeliveredHashes | undefined;

    // Every step below reads that destination. A copy with one is keyed by it,
    // proven or not, so two copies of one skill are one candidate and copies
    // with different destinations never meet. New skills keep the existing
    // name-based placement and deduplication behavior.
    const candidates = new Map<string, {
      name: string; sourcePath: string; mtime: number; status: ResourceItemStatus; namespace?: string; fromInactiveNamespace?: true;
      deliveryRecorded?: true; originProven?: true; originCandidates?: readonly { dir: string }[];
    }>();
    // Scan each tool's skills directory
    for (const [tool, toolPath] of Object.entries(scopedToolPaths(teamConfig, localConfig))) {
      if (!toolPath.skills) continue;
      const skillsDir = path.join(resolveToolBaseDir(tool, localConfig), toolPath.skills);
      if (!await pathExists(skillsDir)) continue;

      // Use recursive scanning to find all skills at any depth
      const localSkills = await scanSkillsRecursively(skillsDir);

      for (const [dir, localDirPath] of localSkills) {
        if (tombstones.has(dir)) continue;
        if (pushIgnoredSkills.has(dir)) continue;
        if (isCliOwnedSkillName(dir)) continue; // Skip CLI built-in skills, current and legacy
        if (sourceSkillNames.has(dir)) continue; // Quarantine legacy/unpinned names
        // Compare the file actually scanned, not a future deployment target:
        // recursive scans and Codex's shared directory can differ from that target.
        const physicalPath = resolveReal(localDirPath);
        const sourceOwner = sourcePathOwners.find((owner) => owner.path === physicalPath
          || owner.path.startsWith(physicalPath + path.sep) || physicalPath.startsWith(owner.path + path.sep));
        if (sourceOwner) {
          log.warn(`Skill "${dir}" is owned by another source installation and is excluded from push. Ownership record: ${sourceOwner.manifestPath}`);
          continue;
        }

        delivered ??= (await (await import('../pull.js')).deliveredHashes(localConfig)) ?? {};
        // Exactly what teamai delivered: not an edit, whatever the team changed since.
        if (await isUneditedSkillCopy(delivered, localDirPath)) continue;
        const destination = await resolveDestination({
          name: dir, dest: localDirPath, team, delivered, pending: options?.pending ?? [], repoPath: localConfig.repo.localPath,
          role: options?.namespace,
        });
        if (destination.kind === 'unproven') {
          warnUnprovenOrigin(dir, destination.candidates, localConfig.repo.localPath);
          continue;
        }
        if (destination.kind === 'ambiguous') {
          const holders = destination.candidates.map((copy) => path.relative(localConfig.repo.localPath, copy.dir)
            .split(path.sep).join('/')).join(', ');
          warnOnce(
            `[skills] Skipped ${dir}: the team has several skills with this name (${holders}), `
            + 'and no delivery record proves which one this copy came from. '
            + `Run \`teamai push --skill ${localDirPath} --role <ns>\` to name the destination.`,
          );
          continue;
        }
        if (destination.kind === 'outOfScope') continue;
        if (destination.kind === 'ambiguousOpenPr') {
          // Returned with the reason it is skipped, so its open PRs' records survive the prune.
          const awaitingAt = destination.records.map((r) => `${r.relativePath} (branch ${r.branch})`).join(', ');
          const held: ResourceItem & { skipReason: string } = {
            name: dir, type: 'skills', sourcePath: localDirPath, relativePath: destination.records[0]!.relativePath, status: 'new',
            skipReason: `${localDirPath} is awaiting review at several destinations: ${awaitingAt}, and no record proves `
              + `which one this copy belongs to. Run \`teamai push --skill ${localDirPath} --role <ns>\` to pick one.`,
          };
          heldItems.push(held);
          continue;
        }

        if (destination.kind === 'new') {
          // Skill does not exist in team repo — candidate for "new"
          const existing = candidates.get(`name:${dir}`);
          if (!existing) {
            const mtime = await getDirLatestMtime(localDirPath);
            candidates.set(`name:${dir}`, { name: dir, sourcePath: localDirPath, mtime, status: 'new' });
          } else if (existing.status === 'new') {
            // Multiple tool dirs have the same new skill — pick latest mtime
            const mtime = await getDirLatestMtime(localDirPath);
            if (mtime > existing.mtime) {
              candidates.set(`name:${dir}`, { name: dir, sourcePath: localDirPath, mtime, status: 'new' });
            }
          }
          continue;
        }

        // A copy awaiting review is new at the destination its open PR holds,
        // which is not on the team repo, so there is nothing to compare it with.
        let target: { dir: string; namespace?: string };
        let status: ResourceItemStatus = 'new';
        let fromInactiveNamespace = false;
        if (destination.kind === 'openPr') {
          target = destination;
        } else {
          // Skill exists in team repo — check if content differs
          const { teamSkill } = destination;
          const teamDirPath = teamSkill.dir;
          const equal = await dirTeamSubsetEqual(localDirPath, teamDirPath, [CONTRIBUTORS_FILE]);
          if (equal) continue; // This tool dir's copy is identical, skip
          // Single-repo mode: like `.teamai/rules` (see the rules scan), the
          // active tree's `.teamai/skills` is never refreshed, and a branch
          // behind the default branch holds older copies nobody edited (#823).
          const teamRelDir = path.relative(localConfig.repo.localPath, teamDirPath).split(path.sep).join('/');
          if (tool === SELF_KNOWLEDGE_SCAN_KEY && localConfig.projectRoot
            && await isPastSkillVersion(localConfig.repo.localPath, localConfig.projectRoot, localDirPath, teamDirPath, teamRelDir)) {
            log.warn(
              `[skills] Skipped ${dir}: ${path.relative(resolveToolBaseDir(tool, localConfig), localDirPath)} is an older `
              + `version of ${teamRelDir}, which has changed on the team since. `
              + 'Copy the current files over it (or delete it) before editing.',
            );
            continue;
          }
          // Content differs — candidate for "modified"
          target = teamSkill;
          status = 'modified';
          fromInactiveNamespace = destination.proven;
        }

        const mtime = await getDirLatestMtime(localDirPath);
        const candidateKey = `destination:${target.dir}`;
        const existing = candidates.get(candidateKey);
        if (!existing || mtime > existing.mtime) {
          if (existing && !await dirContentEqual(existing.sourcePath, localDirPath, [CONTRIBUTORS_FILE])) {
            warnOnce(`[skills] Skipped ${dir} at ${existing.sourcePath}: another edited copy for `
              + `${path.relative(localConfig.repo.localPath, target.dir).split(path.sep).join('/')} has newer content.`);
          }
          // A destination one copy proves stays proven whichever copy is
          // newer, so a flag cannot move it.
          const proven = fromInactiveNamespace || existing?.originProven === true;
          candidates.set(candidateKey, {
            name: dir, sourcePath: localDirPath, mtime, status, namespace: target.namespace,
            ...proven ? { fromInactiveNamespace: true } : {},
            ...fromInactiveNamespace ? { deliveryRecorded: true } : {},
            ...proven ? { originProven: true, originCandidates: [target] } : {},
          });
        } else {
          if (fromInactiveNamespace && !existing.originProven) {
            candidates.set(candidateKey, {
              ...existing, fromInactiveNamespace: true, originProven: true, originCandidates: [target],
            });
          }
          if (!await dirContentEqual(existing.sourcePath, localDirPath, [CONTRIBUTORS_FILE])) {
            warnOnce(`[skills] Skipped ${dir} at ${localDirPath}: another edited copy for `
              + `${path.relative(localConfig.repo.localPath, target.dir).split(path.sep).join('/')} has newer content.`);
          }
        }
      }
    }

    // Convert candidates map to items array
    const items: ResourceItem[] = [];
    for (const candidate of candidates.values()) {
      const item = createSkillPushItem({
        name: candidate.name,
        sourcePath: candidate.sourcePath,
        status: candidate.status,
        namespace: candidate.namespace,
        ...candidate.fromInactiveNamespace ? { fromInactiveNamespace: true } : {},
        ...candidate.deliveryRecorded ? { deliveryRecorded: true } : {},
        ...candidate.originProven ? { originProven: true } : {},
        originCandidates: candidate.originCandidates,
        repoPath: localConfig.repo.localPath,
      });
      if (item) items.push(item);
    }

    return [...items, ...heldItems];
  }

  /**
   * Scan team repo for skills to pull.
   * Handles both flat layout (skills/<name>/) and namespaced layout (skills/<namespace>/<name>/).
   * A directory is treated as a namespace if it does not contain SKILL.md.
   */
  async scanTeamForPull(_teamConfig: TeamaiConfig, localConfig: LocalConfig): Promise<ResourceItem[]> {
    const teamSkillsDir = path.join(localConfig.repo.localPath, 'skills');
    const dirs = await listDirs(teamSkillsDir);
    const items: ResourceItem[] = [];

    for (const dir of dirs) {
      const dirPath = path.join(teamSkillsDir, dir);
      const hasSkillMd = await pathExists(path.join(dirPath, 'SKILL.md'));

      if (hasSkillMd) {
        items.push({
          name: dir,
          type: 'skills',
          sourcePath: dirPath,
          relativePath: `skills/${dir}`,
        });
      } else {
        const subDirs = await listDirs(dirPath);
        for (const subDir of subDirs) {
          items.push({
            name: subDir,
            type: 'skills',
            sourcePath: path.join(dirPath, subDir),
            relativePath: `skills/${dir}/${subDir}`,
            namespace: dir,
          });
        }
      }
    }

    return items;
  }

  /**
   * Copy a local skill to the team repo.
   */
  async pushItem(item: ResourceItem, _teamConfig: TeamaiConfig, localConfig: LocalConfig): Promise<void> {
    const skillsRoot = path.join(localConfig.repo.localPath, 'skills');
    const dest = path.resolve(localConfig.repo.localPath, item.relativePath);
    assertWithinRoot(
      skillsRoot,
      dest,
      `Invalid skill destination outside team repo skills directory: ${item.relativePath}`,
    );
    // A link in the member's skill stays theirs: teamai never puts links in the team repo (#993).
    await copyDir(item.sourcePath, dest, (link) => {
      log.warn(`Skipped ${link} in ${item.relativePath}: teamai does not push links to the team repo.`);
    });
    const sourceFiles = new Set(await listFilesRecursive(item.sourcePath));
    const teamFiles = await listFilesRecursive(dest);
    for (const relativePath of teamFiles) {
      if (sourceFiles.has(relativePath) || relativePath === CONTRIBUTORS_FILE) continue;
      await remove(path.join(dest, relativePath));
    }
    await pruneEmptyDirs(dest);
    log.debug(`Copied skill ${item.name} → team repo`);

    // Ensure SKILL.md has proper YAML frontmatter (name + description)
    await ensureSkillFrontmatter(dest, item.name);

    // Append current user to CONTRIBUTORS (deduplicated)
    const contribPath = path.join(dest, CONTRIBUTORS_FILE);
    const existing = await readFileSafe(contribPath);
    const contributors = existing
      ? existing.split('\n').map(l => l.trim()).filter(l => l.length > 0)
      : [];
    if (!contributors.includes(localConfig.username)) {
      contributors.push(localConfig.username);
      await writeFile(contribPath, contributors.join('\n') + '\n');
      log.debug(`Added contributor "${localConfig.username}" to ${item.name}`);
    }
  }

  /**
   * Every tool that receives `item`, and where it lands.
   *
   * `sourcePath` opts into the write path's Codex shared-directory
   * reconciliation, which can delete a duplicate it proves identical. A reader
   * omits it and gets the same destinations without the side effect.
   *
   * Codex's copy in `.agents/skills` is teamai's as pull judges any copy
   * (`judgeCopy`): by the checkout's record `previous` when the caller has it,
   * else by the team repo's history alone.
   */
  private async resolveTargets(
    teamConfig: TeamaiConfig,
    localConfig: LocalConfig,
    item: ResourceItem,
    sourcePath?: string,
    previous?: DeliveredHashes,
  ): Promise<DeliveryTarget[]> {
    const origin = skillOrigin(localConfig.repo.localPath, item.name);
    const targets: DeliveryTarget[] = [];
    for (const [tool, toolPath] of Object.entries(scopedToolPaths(teamConfig, localConfig))) {
      if (isAgentExcluded(localConfig, tool)) continue;

      const ownsShared = async (dest: string): Promise<boolean> =>
        (await judgeCopy(previous, item, { tool, dest, origin })).kind !== 'member';
      const dest = await skillTargetForTool(tool, toolPath.skills, localConfig, item.name, ownsShared, sourcePath);
      if (dest) targets.push({ tool, dest, origin });
    }
    return targets;
  }

  async deliveryTargets(
    teamConfig: TeamaiConfig,
    localConfig: LocalConfig,
    item: ResourceItem,
  ): Promise<DeliveryTarget[]> {
    return this.resolveTargets(teamConfig, localConfig, item);
  }

  /**
   * Pull a skill from team repo to all configured AI tool directories.
   */
  async pullItem(item: ResourceItem, teamConfig: TeamaiConfig, localConfig: LocalConfig, ledger?: DeliveryLedger): Promise<void> {
    const otherVersions = await otherVersionFiles(localConfig.repo.localPath, item);
    for (const target of await this.resolveTargets(teamConfig, localConfig, item, item.sourcePath, ledger?.previous)) {
      const { tool, dest } = target;
      try {
        if (ledger && await keepsEditedCopy(ledger, item, target)) continue;
        // With no ledger (the local agent's install), nothing else judges a link of the member's there (#993).
        const membersLink = ledger ? null : await membersLinkAt(dest);
        if (membersLink !== null) {
          warnOnce(describeMembersLink(membersLink, item.relativePath));
          continue;
        }
        // An entry of the member's of the other type blocks only the files under it (#993): the rest is delivered.
        const blocked = await blockingEntries(dest, item.sourcePath);
        for (const rel of blocked) {
          const entry = path.join(dest, ...rel.split('/'));
          if (ledger) ledger.members.push({ dest: entry, teamRelPath: `${item.relativePath}/${rel}` });
          else warnOnce(describeMembersFile(entry, `${item.relativePath}/${rel}`));
        }
        await copyDir(item.sourcePath, dest, (link) => warnOnce(describeSkippedLink(link, item.relativePath)), blocked);
        await removeLeftoverVersionFiles(item.sourcePath, dest, otherVersions, ledger?.previous);
        await ensureSkillFrontmatter(dest, item.name);
        if (ledger) await recordDelivered(ledger.hashes, dest, item.sourcePath);
        // The files it wrote, never the directory, nor an entry of the member's it delivered around (#915).
        if (ledger?.recorder) for (const file of await deliveredSkillFiles(item.sourcePath, dest, blocked)) ledger.recorder.report('skills', file);
        log.debug(`Synced skill ${item.name} → ${tool}`);
      } catch (e) {
        ledger?.recorder?.failed('skills');
        log.warn(`Failed to sync skill ${item.name} to ${tool}: ${(e as Error).message}`);
        ledger?.failed.push({ name: item.name, tool });
      }
    }
  }

  /**
   * Remove a skill from the team repo and all local AI tool directories.
   */
  async removeItem(name: string, teamConfig: TeamaiConfig, localConfig: LocalConfig): Promise<string[]> {
    const removed: string[] = [];
    const scopedNamespaces = await resolveSkillNamespaces(localConfig);
    const teamDirs = scopedNamespaces.length > 0
      ? scopedNamespaces.map((namespace) => path.join(localConfig.repo.localPath, 'skills', namespace, name))
      : [path.join(localConfig.repo.localPath, 'skills', name)];

    // Only teamai's copy in each tool's skills directory goes (#993): one on
    // this checkout's record, what pull writes today from the team source, or
    // a team version by the history. Judged before the team source is
    // deleted below; the local agent's resource cache has no history.
    const sources: ResourceItem[] = [];
    for (const teamDir of teamDirs) {
      if (!await pathExists(teamDir)) continue;
      sources.push({ name, type: 'skills', sourcePath: teamDir, relativePath: path.relative(localConfig.repo.localPath, teamDir).split(path.sep).join('/') });
    }
    const previous = await (await import('../pull.js')).deliveredHashes(localConfig);
    const origin = skillOrigin(localConfig.repo.localPath, name);
    const owned: { tool: string; skillDir: string; files?: string[]; packagedBase?: string }[] = [];
    for (const [tool, toolPath] of Object.entries(scopedToolPaths(teamConfig, localConfig))) {
      if (!toolPath.skills) continue;
      // Not ours to write to, so not ours to delete from. Above the OpenClaw
      // branch, so the workspace copy is covered by the same gate.
      if (isAgentExcluded(localConfig, tool)) continue;
      const skillDirs: string[] = [];
      let toolBase: string;
      if (tool === 'openclaw') {
        const wsDir = await resolveOpenclawWorkspaceDir();
        if (!wsDir) continue;
        toolBase = wsDir;
        skillDirs.push(path.join(wsDir, 'skills', name));
      } else {
        const baseDir = resolveToolBaseDir(tool, localConfig);
        toolBase = baseDir;
        skillDirs.push(path.join(baseDir, toolPath.skills, name));
        // Codex also reads, and pull may deliver into, the shared directory.
        if (tool === CODEX_TOOL) skillDirs.push(path.join(baseDir, SHARED_AGENT_SKILLS_PATH, name));
      }
      for (const skillDir of skillDirs) {
        if (!await pathExists(skillDir)) continue;
        // A link is the member's even at a built-in's name, so it is judged before the name.
        // A built-in's name loses the team's files and those a release packaged there, as on uninstall:
        // anything the member added stays.
        if (!await isLink(skillDir) && isCliOwnedSkillName(name)) {
          owned.push({ tool, skillDir, files: (await teamaiSkillFiles(previous, skillDir, origin)).teamais, packagedBase: toolBase });
          continue;
        }
        if (!await isLink(skillDir) && await ownsSkillDir(previous, skillDir, origin, sources)) {
          owned.push({ tool, skillDir });
          continue;
        }
        // Ownership is per file: teamai's go, the member's stay, and so does the directory (#993).
        const files = await isLink(skillDir) ? { teamais: [], members: [] } : await teamaiSkillFiles(previous, skillDir, origin);
        if (files.teamais.length === 0) {
          log.warn(await describeKeptDir(skillDir, `skills/${name}`, 'remove'));
          continue;
        }
        owned.push({ tool, skillDir, files: files.teamais });
        for (const file of files.members) {
          log.warn(describeMembersDirLeft(file, `skills/${name}/${path.relative(skillDir, file).split(path.sep).join('/')}`, 'remove'));
        }
      }
    }

    // Remove from team repo
    for (const { sourcePath } of sources) {
      await remove(sourcePath);
      removed.push(sourcePath);
    }

    // Record tombstone so the resource won't be re-pushed
    await this.addTombstone(name, localConfig);

    for (const { tool, skillDir, files, packagedBase } of owned) {
      // Any file of it the repository tracks keeps the whole directory, named once.
      if (await keepsTrackedCopy(skillDir)) continue;
      if (packagedBase) {
        for (const file of files ?? []) await remove(file);
        removed.push(...files ?? []);
        const result = await removeOwnedFiles(skillDir, await ownedSkillFiles(name), packagedBase);
        if (prunedWhole(result)) removed.push(skillDir);
        else if (result.notRemoved.length > 0) log.warn(`Could not delete packaged files under ${skillDir}. First: ${result.notRemoved[0].file} — ${result.notRemoved[0].error}. Fix the permissions and run \`teamai remove\` again, or delete the directory yourself.`);
        else log.warn(`Kept ${skillDir}: it holds files TeamAI did not put there. The packaged files were removed; delete the rest yourself once you have saved what you need.`);
      } else if (files) {
        for (const file of files) await remove(file);
        await pruneEmptyDirs(skillDir);
        removed.push(...files);
      } else {
        await remove(skillDir);
        removed.push(skillDir);
      }
      log.debug(`Removed skill ${name} from ${tool}`);
    }

    return removed;
  }

  /**
   * Read the CONTRIBUTORS list for a skill directory.
   */
  static async readContributors(skillDir: string): Promise<string[]> {
    const contribPath = path.join(skillDir, CONTRIBUTORS_FILE);
    const content = await readFileSafe(contribPath);
    if (!content) return [];
    return content.split('\n').map(l => l.trim()).filter(l => l.length > 0);
  }
}
