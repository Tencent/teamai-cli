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
import { describeDeliveryConflict, resolveDesiredSkills } from '../resources/desired.js';
import { skillsDirForTool } from '../resources/skills.js';
import { getHandler } from '../resources/index.js';
import { loadTagsConfig } from '../utils/tags.js';
import { readFileSafe } from '../utils/fs.js';
import { pathExists } from '../utils/fs.js';
import { scopedToolPaths, type LocalConfig, type TeamaiConfig } from '../types.js';
import { loadLocalConfig, loadLocalConfigForScope, loadStateForScope, saveLocalConfig, saveLocalConfigForScope, saveStateForScope } from '../config.js';
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

/** Items that have a SKILL.md, the resolver's own inventory filter. */
async function withSkillMdLocal<T extends { sourcePath: string }>(items: readonly T[]): Promise<T[]> {
  const kept: T[] = [];
  for (const item of items) if (await pathExists(item.sourcePath)) kept.push(item);
  return kept;
}

/** The skills inventory plus, when delivery cannot be said this run, why. */
export interface SkillsInventory {
  readonly skills: DashboardSkill[];
  /**
   * Why pull stops the run and keeps what is installed (#707): two skills of
   * one name would land at one path. The inventory stays usable — the list and
   * the exclusions keyed on it keep working; every entry reads undelivered,
   * which is what a conflicted pull delivers.
   */
  readonly skillConflict: string | null;
}

/**
 * Every skill in the team repo with its delivery state for this scope, sorted
 * by name. Read-only, like `doctor`'s view of the same sets.
 */
export async function collectSkillsInventory(
  teamConfig: TeamaiConfig,
  localConfig: LocalConfig,
  roleContext: RolePullContext | null,
): Promise<SkillsInventory> {
  const resolved = await resolveDesiredSkills(teamConfig, localConfig, roleContext);
  // A conflict ends the delivery answer, not the inventory: enumerate the
  // whole repo the way the resolver's own scan does, so the page (and the
  // exclusions keyed on these names) survives it.
  const items = resolved.kind === 'resolved'
    ? resolved.teamItems
    : await withSkillMdLocal(await getHandler('skills').scanTeamForPull(teamConfig, localConfig));
  // Delivery is keyed by source identity (the team-repo path), not the
  // basename: a root skill and a namespaced copy can share a name, and only
  // the copy actually delivers (#1143 review).
  const delivered = new Set(resolved.kind === 'resolved' ? resolved.items.map((item) => item.relativePath) : []);
  // Delivery is name-keyed in resolveDesiredSkills: among same-name skills
  // (a root copy and a namespaced one) exactly one wins the merge — with
  // roles the namespace copy, without them the scan-order winner. The
  // loser's truthful label is `replaced`: a same-name skill stands in for
  // it. This covers both directions and the overrides the resolver reports.
  const winnerByName = new Map(resolved.kind === 'resolved' ? resolved.items.map((item) => [item.name, item] as const) : []);
  const excludedSkills = new Set(localConfig.excludedSkills ?? []);
  const tagsConfig = await loadTagsConfig(localConfig.repo.localPath);

  // Tag attribution: a catalogued skill the tag channel could have brought
  // (a subscribed tag would have delivered it) but did not. The tag channel
  // only speaks about catalogued skills — an uncatalogued one is never its
  // decision, so it falls through to the namespace attribution.
  const catalogued = new Set(
    Object.keys(tagsConfig?.skills ?? {}).filter((name) =>
      items.some((item) => item.name === name)),
  );

  const skills: DashboardSkill[] = [];
  for (const item of items) {
    const root = item.namespace === undefined || item.namespace === null;
    let undeliveredReason: DashboardSkill['undeliveredReason'];
    const excluded = excludedSkills.has(item.name);
    if (delivered.has(item.relativePath)) undeliveredReason = undefined;
    else if (excluded) undeliveredReason = 'excluded';
    else {
      const winner = winnerByName.get(item.name);
      if (winner && winner.relativePath !== item.relativePath) undeliveredReason = 'replaced';
      else if (catalogued.has(item.name)) undeliveredReason = 'tags';
      else if (roleContext) undeliveredReason = 'namespace';
      else undeliveredReason = 'tags';
    }
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
  return { skills: skills.sort((a, b) => a.name.localeCompare(b.name)), skillConflict: resolved.kind === 'conflict' ? describeDeliveryConflict(resolved) : null };
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

/**
 * One skill's full inventory entry, or null when the name is unknown. Two
 * entries can share a name — a root and the namespaced copy that replaces it
 * — so an optional source path (the inventory's own identity) selects the
 * copy exactly; a name-only lookup prefers the delivered one, so it cannot
 * land on a replaced root while a delivered copy exists.
 */
export async function skillDetail(
  teamConfig: TeamaiConfig,
  localConfig: LocalConfig,
  roleContext: RolePullContext | null,
  name: string,
  sourcePath?: string,
): Promise<DashboardSkill | null> {
  const { skills } = await collectSkillsInventory(teamConfig, localConfig, roleContext);
  const matches = skills.filter((skill) => skill.name === name);
  if (sourcePath !== undefined) return matches.find((skill) => skill.path === sourcePath) ?? null;
  return matches.find((skill) => skill.delivered) ?? matches[0] ?? null;
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
  roleContext: RolePullContext | null = null,
): Promise<SkillExclusionResult> {
  // Two requests excluding different skills must not race: both start from
  // the same cached config and the last save would drop the first's change.
  // Writes are serialized per workspace, and the config is reloaded inside
  // the critical section so each write sees the previous one (#1143 review).
  const key = `${localConfig.scope}:${localConfig.projectRoot ?? localConfig.repo.localPath}`;
  const run = exclusionQueues.get(key) ?? Promise.resolve();
  const queued = run.then(
    () =>
      setSkillExclusionSerialized(teamConfig, localConfig, name, excluded, roleContext),
    () => setSkillExclusionSerialized(teamConfig, localConfig, name, excluded, roleContext),
  );
  exclusionQueues.set(
    key,
    queued.catch(() => undefined),
  );
  return queued;
}
const exclusionQueues = new Map<string, Promise<unknown>>();

async function setSkillExclusionSerialized(
  teamConfig: TeamaiConfig,
  localConfig: LocalConfig,
  name: string,
  excluded: boolean,
  roleContext: RolePullContext | null,
): Promise<SkillExclusionResult> {
  // Reload from disk inside the serialized section: the endpoint's in-memory
  // copy may predate another write.
  const diskConfig = (await reloadLocalConfig(localConfig)) ?? localConfig;
  const { skills } = await collectSkillsInventory(teamConfig, diskConfig, roleContext);
  if (!skills.some((skill) => skill.name === name)) {
    return { ok: false, error: 'unknown_skill' };
  }
  const existing = new Set(diskConfig.excludedSkills ?? []);
  if (excluded) existing.add(name);
  else existing.delete(name);
  const nextConfig: LocalConfig = {
    ...diskConfig,
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

  // The response answers with the same role context the GET endpoints use,
  // so a re-included skill outside the active namespaces reports
  // delivered: false here too (#1143 review).
  const updated = await skillDetail(teamConfig, nextConfig, roleContext, name);
  return { ok: true, skill: updated! };
}

/** The scope's config as last saved on disk; null when unreadable. */
async function reloadLocalConfig(localConfig: LocalConfig): Promise<LocalConfig | null> {
  if (localConfig.scope === 'project') {
    return loadLocalConfigForScope('project', localConfig.projectRoot);
  }
  return loadLocalConfig();
}
