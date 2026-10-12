import path from 'node:path';
import { listDirs, pathExists, readFileSafe } from './utils/fs.js';
import { detectInstalledAgents, type ResolvedAgent } from './known-agents.js';
import { isCliOwnedSkillName } from './builtin-skills.js';
import type { LocalConfig, TeamaiConfig } from './types.js';
import { parseFrontmatter } from './utils/frontmatter.js';
import { log } from './utils/logger.js';
import { resolveReal } from './utils/path-safety.js';

// ─── Local agent skill scanning ─────────────────────────
//
//  Walks each agent's `<HOME>/.<agent>/skills/` directory,
//  reads SKILL.md frontmatter, and tags each skill with its
//  origin so users can tell at a glance which skills came
//  from the team repo, which are CLI built-ins, which were
//  pulled from a cross-team source, and which are local-only
//  drafts that have not been pushed yet.

export type SkillSource =
  | { kind: 'team'; namespace?: string }
  | { kind: 'builtin' }
  | { kind: 'source'; name: string }
  | { kind: 'local-only' };

export interface AgentSkill {
  /** Skill directory name relative to the agent's skills root, including nesting. */
  name: string;
  /** Frontmatter description, trimmed and possibly truncated by callers. */
  description: string;
  /** Absolute path to the skill directory inside the agent. */
  path: string;
  /** Provenance of this skill. */
  source: SkillSource;
}

export interface AgentSkillsView {
  agent: ResolvedAgent;
  skills: AgentSkill[];
}

export interface ClassifyContext {
  /** Skill names found anywhere in the team repo (flat + namespaced). */
  teamSkills: Map<string, { namespace?: string }>;
  /** Skill names provided by external source repos. */
  sourceSkills: Map<string, string>;
  /** Verified physical installation paths, scoped to the current team/destination. */
  sourceSkillPaths: Map<string, string>;
  /** Sources with path records must not claim unrecorded copies by name alone. */
  pathTrackedSources: Set<string>;
}

/**
 * Build the classification context once so repeated `classifySkill`
 * calls (one per agent + skill) stay cheap.
 */
export async function buildClassifyContext(localConfig: LocalConfig): Promise<ClassifyContext> {
  const teamSkills = await collectTeamRepoSkills(localConfig.repo.localPath);

  let sourceSkills = new Map<string, string>();
  const sourceSkillPaths = new Map<string, string>();
  const pathTrackedSources = new Set<string>();
  try {
    const { getSourceSkillOrigins, getSourcePathOwners, getSourceManifestPath } = await import('./source.js');
    const origins = await getSourceSkillOrigins(localConfig);
    for (const owner of await getSourcePathOwners()) {
      const source = owner.sourceName;
      if (!source) continue;
      // Different aliases can publish the same name, so the first-name origin
      // map cannot enumerate every owner. Verify each alias's scoped record.
      if (owner.manifestPath !== getSourceManifestPath(source, localConfig)) continue;
      if (!sourceSkillPaths.has(owner.path)) sourceSkillPaths.set(owner.path, source);
      pathTrackedSources.add(source);
    }
    sourceSkills = origins;
  } catch (error) {
    log.warn(`Source provenance could not be determined: ${(error as Error).message}. Source labels may be incomplete; do not treat local-only as proof of local ownership.`);
  }

  return { teamSkills, sourceSkills, sourceSkillPaths, pathTrackedSources };
}

/**
 * Walk the team repo `skills/` directory, returning a map of
 * skill name → namespace. Flat skills get an empty namespace.
 */
export async function collectTeamRepoSkills(repoPath: string): Promise<Map<string, { namespace?: string }>> {
  const teamSkillsDir = path.join(repoPath, 'skills');
  const result = new Map<string, { namespace?: string }>();
  if (!await pathExists(teamSkillsDir)) return result;

  const topDirs = await listDirs(teamSkillsDir);
  for (const dir of topDirs) {
    const dirPath = path.join(teamSkillsDir, dir);
    const hasSkillMd = await pathExists(path.join(dirPath, 'SKILL.md'));
    if (hasSkillMd) {
      result.set(dir, {});
    } else {
      const subDirs = await listDirs(dirPath);
      for (const subDir of subDirs) {
        if (!result.has(subDir)) {
          result.set(subDir, { namespace: dir });
        }
      }
    }
  }

  return result;
}

/** Resolve a skill name to its source tag using the prebuilt context. */
export function classifySkill(name: string, ctx: ClassifyContext, skillPath?: string): SkillSource {
  // Same rule as the push scan and uninstall: a name a pre-stub release deployed
  // is ours until the next pull prunes it, not a member's local-only skill.
  if (isCliOwnedSkillName(name)) return { kind: 'builtin' };
  if (ctx.teamSkills.has(name)) {
    return { kind: 'team', namespace: ctx.teamSkills.get(name)?.namespace };
  }
  const pathSource = skillPath && ctx.sourceSkillPaths.get(resolveReal(skillPath));
  if (pathSource) return { kind: 'source', name: pathSource };
  const nameSource = ctx.sourceSkills.get(name);
  // Older scoped records may carry only names. Keep their exact-name fallback,
  // but never use a basename alias or override a modern record's actual paths.
  if (nameSource && (!skillPath || !ctx.pathTrackedSources.has(nameSource))) {
    return { kind: 'source', name: nameSource };
  }
  return { kind: 'local-only' };
}

/** Pretty-print a SkillSource for terminal output. */
export function formatSkillSource(source: SkillSource): string {
  switch (source.kind) {
    case 'team':
      return source.namespace ? `[team:${source.namespace}]` : '[team]';
    case 'builtin':
      return '[builtin]';
    case 'source':
      return `[source:${source.name}]`;
    case 'local-only':
      return '[local-only]';
  }
}

/**
 * Walk a single agent's skills directory, returning one AgentSkill
 * per `<skillsDir>/<name>/SKILL.md`, including known nested source installs.
 * Do not recursively discover bundled modules as independent skills.
 */
export async function scanAgentSkills(agent: ResolvedAgent, ctx: ClassifyContext): Promise<AgentSkillsView> {
  const skills: AgentSkill[] = [];
  if (!agent.installed) {
    return { agent, skills };
  }
  if (!await pathExists(agent.absoluteSkillsPath)) {
    return { agent, skills };
  }

  const names = new Set(await listDirs(agent.absoluteSkillsPath));
  for (const [name, source] of ctx.sourceSkills) {
    // Recorded names also find symlinked installs, whose physical path may sit
    // outside this root. A name alone must not expose another tool's modules.
    if (!ctx.pathTrackedSources.has(source)
      || ctx.sourceSkillPaths.has(resolveReal(path.join(agent.absoluteSkillsPath, name)))) names.add(name);
  }
  const physicalRoot = resolveReal(agent.absoluteSkillsPath);
  for (const installedPath of ctx.sourceSkillPaths.keys()) {
    const relative = path.relative(physicalRoot, installedPath);
    if (relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) {
      names.add(relative.split(path.sep).join('/'));
    }
  }
  for (const name of names) {
    // Skip hidden directories (e.g. .system) and workspace scratch dirs
    if (name.split('/').some((part) => part.startsWith('.') || part.endsWith('-workspace'))) continue;
    const skillDir = path.join(agent.absoluteSkillsPath, name);
    const skillMd = path.join(skillDir, 'SKILL.md');
    if (!await pathExists(skillMd)) continue;
    const description = await readSkillDescription(skillMd);
    skills.push({
      name,
      description,
      path: skillDir,
      source: classifySkill(name, ctx, skillDir),
    });
  }

  skills.sort((a, b) => a.name.localeCompare(b.name));
  return { agent, skills };
}

/**
 * Scan every installed agent in one pass. Agents that are not
 * installed (no `~/.<id>/` directory) are silently dropped — they
 * are intentionally not part of the output, matching the rule that
 * `pull` already skips uninstalled tools.
 */
export async function scanInstalledAgents(
  localConfig: LocalConfig,
  teamConfig: TeamaiConfig,
): Promise<AgentSkillsView[]> {
  const agents = await detectInstalledAgents(localConfig, teamConfig);
  const ctx = await buildClassifyContext(localConfig);
  const views: AgentSkillsView[] = [];
  for (const agent of agents) {
    if (!agent.installed) continue;
    views.push(await scanAgentSkills(agent, ctx));
  }
  return views;
}

/**
 * Extract a description from a SKILL.md file. Parses the YAML
 * frontmatter and returns the `description` field, normalizing
 * any multi-line block scalar to a single space-joined string.
 */
export async function readSkillDescription(skillMdPath: string): Promise<string> {
  const content = await readFileSafe(skillMdPath);
  if (!content) return '';
  const { data } = parseFrontmatter(content);
  const desc = data['description'];
  if (typeof desc !== 'string') return '';

  // Normalize whitespace: collapse newlines + indentation into single spaces
  return desc.split('\n').map((l) => l.trim()).filter(Boolean).join(' ');
}

/** Truncate description to `max` characters with an ellipsis suffix. */
export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, Math.max(0, max - 3)) + '...';
}
