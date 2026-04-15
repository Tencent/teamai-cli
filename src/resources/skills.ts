import path from 'node:path';
import { ResourceHandler } from './base.js';
import type { ResourceItem, ResourceItemStatus, TeamaiConfig, LocalConfig } from '../types.js';
import { resolveBaseDir, getPushignorePath } from '../types.js';
import { listDirs, pathExists, copyDir, remove, dirContentEqual, getDirLatestMtime, readFileSafe, writeFile } from '../utils/fs.js';
import { log } from '../utils/logger.js';
import { BUILTIN_SKILL_NAMES } from '../builtin-skills.js';
import { loadRolesManifest, resolveRoleResourceNamespaces } from '../roles.js';

/** File name used to track who has contributed (pushed) a skill. */
const CONTRIBUTORS_FILE = 'CONTRIBUTORS';
const SKILL_MD = 'SKILL.md';
const FRONTMATTER_REGEX = /^---\n[\s\S]*?\n---/;

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

  const fmMatch = content.match(FRONTMATTER_REGEX);

  if (!fmMatch) {
    // No frontmatter at all — derive description from first heading or first non-empty line
    const description = extractDescriptionFromContent(content, skillName);
    const frontmatter = `---\nname: ${skillName}\ndescription: ${description}\n---\n`;
    const newContent = frontmatter + (content.startsWith('\n') ? content : '\n' + content);
    await writeFile(skillMdPath, newContent);
    log.debug(`Injected YAML frontmatter into ${skillName}/SKILL.md`);
    return true;
  }

  // Frontmatter exists — check for missing fields
  const fmBlock = fmMatch[0];
  const fmBody = fmBlock.slice(4, fmBlock.length - 4); // strip leading/trailing ---\n
  const hasName = /^name:\s*.+/m.test(fmBody);
  const hasDescription = /^description:\s*.+/m.test(fmBody);

  if (hasName && hasDescription) return false; // Already complete

  const lines = fmBody.split('\n');
  if (!hasName) {
    lines.push(`name: ${skillName}`);
  }
  if (!hasDescription) {
    const restContent = content.slice(fmMatch[0].length);
    const description = extractDescriptionFromContent(restContent, skillName);
    lines.push(`description: ${description}`);
  }

  const newFrontmatter = `---\n${lines.join('\n')}\n---`;
  const newContent = content.replace(FRONTMATTER_REGEX, newFrontmatter);
  await writeFile(skillMdPath, newContent);
  log.debug(`Added missing frontmatter fields to ${skillName}/SKILL.md`);
  return true;
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
 * skill subdirectories rather than being a skill itself).
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
    if (!hasSkillMd) {
      namespaces.push(dir);
    }
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
 * Falls back to [primaryRole, ...additionalRoles] if manifest is unavailable,
 * and returns [] if no roles are configured.
 */
async function resolveSkillNamespaces(localConfig: LocalConfig): Promise<string[]> {
  if (!localConfig.primaryRole) return [];

  try {
    const manifest = await loadRolesManifest(localConfig.repo.localPath);
    const namespaces = resolveRoleResourceNamespaces({
      manifest,
      primaryRole: localConfig.primaryRole,
      additionalRoles: localConfig.additionalRoles ?? [],
    });
    return namespaces.skills;
  } catch {
    // Fallback: use role ids as namespace names (legacy behavior)
    return [localConfig.primaryRole, ...(localConfig.additionalRoles ?? [])];
  }
}

function getSkillDestination(localConfig: LocalConfig, skillName: string, namespace?: string): string {
  if (namespace) {
    return path.join(localConfig.repo.localPath, 'skills', namespace, skillName);
  }
  return path.join(localConfig.repo.localPath, 'skills', skillName);
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
  async scanLocalForPush(teamConfig: TeamaiConfig, localConfig: LocalConfig): Promise<ResourceItem[]> {
    const scopedNamespaces = await resolveSkillNamespaces(localConfig);
    const teamSkills = new Map<string, { dir: string; namespace?: string }>();
    const blockedSkills = new Set<string>(); // Skills in non-allowed namespaces (role-based)

    if (scopedNamespaces.length > 0) {
      // Role-based mode: load allowed namespaces and track blocked ones
      for (const namespace of scopedNamespaces) {
        const teamSkillsDir = path.join(localConfig.repo.localPath, 'skills', namespace);
        const names = await listDirs(teamSkillsDir);
        for (const name of names) {
          if (!teamSkills.has(name)) {
            teamSkills.set(name, { dir: path.join(teamSkillsDir, name), namespace });
          }
        }
      }

      // Scan all namespaces to find skills in non-allowed ones
      const allSkillsDir = path.join(localConfig.repo.localPath, 'skills');
      const allNamespaces = await listDirs(allSkillsDir);
      for (const namespace of allNamespaces) {
        if (scopedNamespaces.includes(namespace)) continue; // Already processed as allowed
        const nonAllowedDir = path.join(allSkillsDir, namespace);
        const names = await listDirs(nonAllowedDir);
        for (const name of names) {
          if (!teamSkills.has(name)) {
            blockedSkills.add(name);
          }
        }
      }
    } else {
      // Legacy mode (no roles): detect flat vs namespaced layout automatically.
      // A directory is a namespace if it does NOT contain SKILL.md; otherwise it's a flat skill.
      const teamSkillsDir = path.join(localConfig.repo.localPath, 'skills');
      const topDirs = await listDirs(teamSkillsDir);
      for (const dir of topDirs) {
        const dirPath = path.join(teamSkillsDir, dir);
        const hasSkillMd = await pathExists(path.join(dirPath, 'SKILL.md'));
        if (hasSkillMd) {
          // Flat skill
          teamSkills.set(dir, { dir: dirPath });
        } else {
          // Namespace directory — scan subdirectories as skills
          const subDirs = await listDirs(dirPath);
          for (const subDir of subDirs) {
            if (!teamSkills.has(subDir)) {
              teamSkills.set(subDir, { dir: path.join(dirPath, subDir), namespace: dir });
            }
          }
        }
      }
    }

    // Read tombstones to skip previously deleted resources
    const tombstones = await this.readTombstones(localConfig);
    const pushIgnoredSkills = await readPushIgnoredSkills();

    // Load source skill names to exclude from push candidates (Codex finding #1)
    let sourceSkillNames: Set<string>;
    try {
      const { getAllSourceSkillNames } = await import('../source.js');
      sourceSkillNames = await getAllSourceSkillNames();
    } catch {
      sourceSkillNames = new Set();
    }

    // Collect the best candidate for each skill name across all tool directories
    const candidates = new Map<string, { sourcePath: string; mtime: number; status: ResourceItemStatus; namespace?: string }>();

    // Scan each tool's skills directory
    for (const [_tool, toolPath] of Object.entries(teamConfig.toolPaths)) {
      if (!toolPath.skills) continue;
      const skillsDir = path.join(resolveBaseDir(localConfig), toolPath.skills);
      if (!await pathExists(skillsDir)) continue;

      const dirs = await listDirs(skillsDir);
      for (const dir of dirs) {
        if (tombstones.has(dir)) continue;
        if (pushIgnoredSkills.has(dir)) continue;
        if (blockedSkills.has(dir)) continue; // Skip skills in non-allowed namespaces
        if (BUILTIN_SKILL_NAMES.has(dir)) continue; // Skip CLI built-in skills
        if (sourceSkillNames.has(dir)) continue; // Skip cross-team source skills
        // Check for SKILL.md to confirm it's a valid skill
        const skillMd = path.join(skillsDir, dir, 'SKILL.md');
        if (!await pathExists(skillMd)) continue;

        const localDirPath = path.join(skillsDir, dir);

        if (teamSkills.has(dir)) {
          // Skill exists in team repo — check if content differs
          const teamDirPath = teamSkills.get(dir)!.dir;
          const equal = await dirContentEqual(localDirPath, teamDirPath, [CONTRIBUTORS_FILE]);
          if (equal) continue; // This tool dir's copy is identical, skip

          // Content differs — candidate for "modified"
          const mtime = await getDirLatestMtime(localDirPath);
          const existing = candidates.get(dir);
          if (!existing || mtime > existing.mtime) {
            candidates.set(dir, { sourcePath: localDirPath, mtime, status: 'modified', namespace: teamSkills.get(dir)!.namespace });
          }
        } else {
          // Skill does not exist in team repo — candidate for "new"
          const existing = candidates.get(dir);
          if (!existing) {
            const mtime = await getDirLatestMtime(localDirPath);
            candidates.set(dir, { sourcePath: localDirPath, mtime, status: 'new' });
          } else if (existing.status === 'new') {
            // Multiple tool dirs have the same new skill — pick latest mtime
            const mtime = await getDirLatestMtime(localDirPath);
            if (mtime > existing.mtime) {
              candidates.set(dir, { sourcePath: localDirPath, mtime, status: 'new' });
            }
          }
        }
      }
    }

    // Convert candidates map to items array
    const items: ResourceItem[] = [];
    for (const [name, candidate] of candidates) {
      const ns = candidate.namespace ?? (candidate.status === 'new' ? undefined : undefined);
      const relPath = ns ? `skills/${ns}/${name}` : `skills/${name}`;
      items.push({
        name,
        type: 'skills',
        sourcePath: candidate.sourcePath,
        relativePath: relPath,
        status: candidate.status,
        namespace: ns,
      });
    }

    return items;
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
    const dest = getSkillDestination(localConfig, item.name, item.namespace ?? localConfig.primaryRole);
    await copyDir(item.sourcePath, dest);
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
   * Pull a skill from team repo to all configured AI tool directories.
   */
  async pullItem(item: ResourceItem, teamConfig: TeamaiConfig, localConfig: LocalConfig): Promise<void> {
    const baseDir = resolveBaseDir(localConfig);

    for (const [tool, toolPath] of Object.entries(teamConfig.toolPaths)) {
      if (!toolPath.skills) continue;

      // Skip tools that are not installed
      if (!await ResourceHandler.isToolInstalled(toolPath.skills, baseDir)) {
        log.debug(`Skipping skill sync for ${tool}: tool not installed`);
        continue;
      }

      const dest = path.join(baseDir, toolPath.skills, item.name);
      try {
        await copyDir(item.sourcePath, dest);
        log.debug(`Synced skill ${item.name} → ${tool}`);
      } catch (e) {
        log.warn(`Failed to sync skill ${item.name} to ${tool}: ${(e as Error).message}`);
      }
    }
  }

  /**
   * Remove a skill from the team repo and all local AI tool directories.
   */
  async removeItem(name: string, teamConfig: TeamaiConfig, localConfig: LocalConfig): Promise<string[]> {
    const removed: string[] = [];
    const baseDir = resolveBaseDir(localConfig);

    // Remove from team repo
    const scopedNamespaces = await resolveSkillNamespaces(localConfig);
    if (scopedNamespaces.length > 0) {
      for (const namespace of scopedNamespaces) {
        const namespaceDir = path.join(localConfig.repo.localPath, 'skills', namespace, name);
        if (await pathExists(namespaceDir)) {
          await remove(namespaceDir);
          removed.push(namespaceDir);
        }
      }
    } else {
      const teamDir = path.join(localConfig.repo.localPath, 'skills', name);
      if (await pathExists(teamDir)) {
        await remove(teamDir);
        removed.push(teamDir);
      }
    }

    // Record tombstone so the resource won't be re-pushed
    await this.addTombstone(name, localConfig);

    // Remove from each tool's skills directory
    for (const [tool, toolPath] of Object.entries(teamConfig.toolPaths)) {
      if (!toolPath.skills) continue;
      const skillDir = path.join(baseDir, toolPath.skills, name);
      if (await pathExists(skillDir)) {
        await remove(skillDir);
        removed.push(skillDir);
        log.debug(`Removed skill ${name} from ${tool}`);
      }
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
