/**
 * The skills inventory behind the dashboard's Resources page (#1123): every
 * skill in the team repo, with whether `pull` delivers it to this scope, the
 * personal exclusion state, and which agents have it installed on disk.
 * `resolveDesiredSkills` already states what pull delivers (role namespaces,
 * tag channel, exclusions), so it decides `delivered`; the filters run once
 * more here only to attribute each undelivered skill to the channel that
 * dropped it. Metadata only — the dashboard must not return SKILL.md bodies
 * or environment values.
 */
import matter from 'gray-matter';
import { resolveDesiredSkills } from '../resources/desired.js';
import { skillsDirForTool } from '../resources/skills.js';
import { loadTagsConfig } from '../utils/tags.js';
import { readFileSafe } from '../utils/fs.js';
import { pathExists } from '../utils/fs.js';
import { scopedToolPaths, type LocalConfig, type TeamaiConfig } from '../types.js';
import { loadStateForScope, saveLocalConfig, saveLocalConfigForScope, saveStateForScope } from '../config.js';
import type { RolePullContext } from '../resources/desired.js';

export interface DashboardSkill {
  /** The skill's team name: `ns/name` for a namespaced skill, `name` at the root. */
  name: string;
  /** The namespace segment, or null for a root skill. */
  namespace: string | null;
  /** Path inside the team repo, e.g. `skills/backend/api`. */
  path: string;
  /** The SKILL.md frontmatter `description`, when the file carries one. */
  description: string | null;
  /** Usernames from the skill's CONTRIBUTORS file, when it has one. */
  contributors: string[];
  /** Tags from the team's tag catalog, when the skill is listed there. */
  tags: string[];
  /** Agents with the skill directory on disk right now. */
  installedAgents: string[];
  delivered: boolean;
  /** Why pull leaves the skill out; only set on an undelivered skill. */
  undeliveredReason: 'namespace' | 'tags' | 'replaced' | 'excluded' | undefined;
  /** Whether this workspace's personal exclude list holds the skill. */
  excluded: boolean;
}

/** One skill's frontmatter description, or null: the page lists metadata only. */
async function skillDescription(sourcePath: string): Promise<string | null> {
  const raw = await readFileSafe(pathJoin(sourcePath, 'SKILL.md'));
  if (raw === null) return null;
  try {
    const { data } = matter(raw);
    const description = (data as { description?: unknown }).description;
    return typeof description === 'string' && description.trim() !== '' ? description.trim() : null;
  } catch {
    // Damaged frontmatter must not take the whole listing down.
    return null;
  }
}

/** Usernames from a skill's CONTRIBUTORS file; absent file → empty. */
async function skillContributors(sourcePath: string): Promise<string[]> {
  const raw = await readFileSafe(pathJoin(sourcePath, 'CONTRIBUTORS'));
  if (raw === null) return [];
  return raw.split('\n').map((line) => line.trim()).filter((line) => line.length > 0);
}

function pathJoin(dir: string, file: string): string {
  // Local import shape keeps this module free of a top-level path dependency
  // cycle with the resources module.
  return `${dir.replace(/[/\\]+$/, '')}/${file}`;
}

/**
 * Every skill in the team repo with its delivery state for this scope, sorted
 * by name. Read-only, like `doctor`'s view of the same sets.
 */
export async function collectSkillsInventory(
  teamConfig: TeamaiConfig,
  localConfig: LocalConfig,
  roleContext: RolePullContext | null,
): Promise<DashboardSkill[]> {
  const resolved = await resolveDesiredSkills(teamConfig, localConfig, roleContext);
  if (resolved.kind === 'conflict') return [];
  const delivered = new Set(resolved.items.map((item) => item.name));
  const replacedRoots = new Set(resolved.overrides.map((override) => override.replaces));
  const excludedSkills = new Set(localConfig.excludedSkills ?? []);
  const tagsConfig = await loadTagsConfig(localConfig.repo.localPath);

  // Tag attribution: a catalogued skill the tag channel could have brought
  // (a subscribed tag would have delivered it) but did not. The tag channel
  // only speaks about catalogued skills — an uncatalogued one is never its
  // decision, so it falls through to the namespace attribution.
  const catalogued = new Set(
    Object.keys(tagsConfig?.skills ?? {}).filter((name) =>
      resolved.teamItems.some((item) => item.name === name)),
  );

  const skills: DashboardSkill[] = [];
  for (const item of resolved.teamItems) {
    const root = item.namespace === undefined || item.namespace === null;
    let undeliveredReason: DashboardSkill['undeliveredReason'];
    const excluded = excludedSkills.has(item.name);
    if (delivered.has(item.name)) undeliveredReason = undefined;
    else if (excluded) undeliveredReason = 'excluded';
    else if (root && replacedRoots.has(`skills/${item.name}`)) undeliveredReason = 'replaced';
    else if (catalogued.has(item.name)) undeliveredReason = 'tags';
    else if (roleContext) undeliveredReason = 'namespace';
    else undeliveredReason = 'tags';
    skills.push({
      name: item.name,
      namespace: root ? null : item.namespace ?? null,
      path: item.relativePath,
      description: await skillDescription(item.sourcePath),
      contributors: await skillContributors(item.sourcePath),
      tags: tagsConfig?.skills?.[item.name] ?? [],
      installedAgents: await installedAgentsFor(teamConfig, localConfig, item.name),
      delivered: undeliveredReason === undefined,
      undeliveredReason,
      excluded,
    });
  }
  return skills.sort((a, b) => a.name.localeCompare(b.name));
}

/** Which configured agents have the skill directory on disk right now. */
async function installedAgentsFor(
  teamConfig: TeamaiConfig,
  localConfig: LocalConfig,
  skillName: string,
): Promise<string[]> {
  const toolPaths = scopedToolPaths(teamConfig, localConfig);
  const installed: string[] = [];
  for (const tool of Object.keys(toolPaths)) {
    const skillsDir = await skillsDirForTool(tool, toolPaths[tool].skills, localConfig);
    if (!skillsDir) continue;
    if (await pathExists(pathJoin(skillsDir, skillName))) installed.push(tool);
  }
  return installed;
}

/** One skill's full inventory entry, or null when the name is unknown. */
export async function skillDetail(
  teamConfig: TeamaiConfig,
  localConfig: LocalConfig,
  roleContext: RolePullContext | null,
  name: string,
): Promise<DashboardSkill | null> {
  const skills = await collectSkillsInventory(teamConfig, localConfig, roleContext);
  return skills.find((skill) => skill.name === name) ?? null;
}

export type SkillExclusionResult =
  | { ok: true; skill: DashboardSkill }
  | { ok: false; error: 'unknown_skill' };

/**
 * Add or remove one skill from this workspace's personal exclude list (#1123).
 *
 * Writes only the selected workspace's config — never the team repository —
 * and invalidates pull's unchanged-revision fast path so the next pull
 * applies the change (this function never runs pull itself).
 */
export async function setSkillExclusion(
  teamConfig: TeamaiConfig,
  localConfig: LocalConfig,
  name: string,
  excluded: boolean,
): Promise<SkillExclusionResult> {
  const skills = await collectSkillsInventory(teamConfig, localConfig, null);
  if (!skills.some((skill) => skill.name === name)) {
    return { ok: false, error: 'unknown_skill' };
  }
  const existing = new Set(localConfig.excludedSkills ?? []);
  if (excluded) existing.add(name);
  else existing.delete(name);
  const nextConfig: LocalConfig = {
    ...localConfig,
    excludedSkills: existing.size > 0 ? [...existing].sort() : undefined,
  };

  // Scope-aware persistence, mirroring the `teamai exclude` command's save
  // path: the project scope's config file is per-project, the user scope's
  // is the single user config.
  if (nextConfig.scope === 'project') {
    await saveLocalConfigForScope(nextConfig, 'project', nextConfig.projectRoot);
  } else {
    await saveLocalConfig(nextConfig);
  }
  // A changed exclude list must bypass pull's unchanged-revision fast path so
  // excluded skills are removed, or newly included skills are restored.
  try {
    const state = await loadStateForScope(nextConfig);
    state.lastPullRev = null;
    await saveStateForScope(state, nextConfig);
  } catch {
    // Missing/corrupt state is non-critical: the next pull performs a full sync.
  }

  const updated = await skillDetail(teamConfig, nextConfig, null, name);
  return { ok: true, skill: updated! };
}
